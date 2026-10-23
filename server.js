import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import admin from 'firebase-admin';

const app=express();app.disable('x-powered-by');app.use(express.json({limit:'32kb'}));
const url=process.env.PUBLIC_SITE_URL||'https://edielrodrigues.github.io/Rifa-Cliente/';
const allowed=new Set(url.split(',').map(x=>{try{return new URL(x.trim()).origin}catch{return x.trim()}}));
allowed.add('https://edielrodrigues.github.io');
app.use(cors({origin(origin,cb){if(!origin||allowed.has(origin))return cb(null,true);console.warn('CORS bloqueado:',origin);cb(new Error('Origem não autorizada'))},methods:['GET','POST','OPTIONS'],allowedHeaders:['Authorization','Content-Type']}));
let ready=false;
try{
 const j=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
 const c=j?JSON.parse(j):{project_id:process.env.FIREBASE_PROJECT_ID,client_email:process.env.FIREBASE_CLIENT_EMAIL,private_key:process.env.FIREBASE_PRIVATE_KEY};
 const privateKey=String(c.private_key||'').replace(/\\n/g,'\n');
 admin.initializeApp({credential:admin.credential.cert({projectId:c.project_id,clientEmail:c.client_email,privateKey}),databaseURL:process.env.FIREBASE_DATABASE_URL});ready=true;
}catch(e){console.error('Firebase:',e.message)}
const db=()=>admin.database();const sv=()=>admin.database.ServerValue.TIMESTAMP;
const mpBase='https://api.mercadopago.com';
async function mp(path,options={}){const r=await fetch(mpBase+path,{...options,headers:{Authorization:'Bearer '+process.env.MP_ACCESS_TOKEN,'Content-Type':'application/json',...(options.headers||{})},signal:AbortSignal.timeout(35000)});const j=await r.json().catch(()=>({}));if(!r.ok)throw Error('Mercado Pago HTTP '+r.status+': '+String(j.message||j.error||'falha').slice(0,160));return j}
const cents=v=>Math.round(Number(v)*100);
const HOLD_MS=60*60*1000;
const validId=s=>/^[A-Za-z0-9_-]{8,100}$/.test(s);
async function user(req,res,next){try{const token=/^Bearer (.+)$/.exec(req.headers.authorization||'')?.[1];if(!token)return res.status(401).json({error:'Login necessário'});req.user=await admin.auth().verifyIdToken(token);next()}catch(e){res.status(401).json({error:'Autenticação inválida'})}}
app.get('/',(_,res)=>res.json({online:true,service:'Rifa Pix Render',version:'2.5.0'}));
app.get('/api/diagnostico',(_,res)=>res.json({online:true,version:'2.5.0',mercadoPagoConfigured:!!process.env.MP_ACCESS_TOKEN,firebaseConfigured:ready,siteAutorizado:allowed.has('https://edielrodrigues.github.io'),webhookConfigured:!!process.env.MP_WEBHOOK_SECRET}));
function qr(pay){return {paymentId:String(pay.id),pixCopiaECola:pay.point_of_interaction?.transaction_data?.qr_code||'',qrCodeBase64:pay.point_of_interaction?.transaction_data?.qr_code_base64||''}}
async function finalize(id,pay){
 const ref=db().ref('rifa/reservas/'+id);
 const current=(await ref.get()).val();
 const reasons=[];
 if(!current)reasons.push('reserva inexistente');
 else {
  if(String(current.mpPaymentId)!==String(pay.id))reasons.push('paymentId divergente');
  if(pay.status!=='approved')reasons.push('status nao aprovado');
  if(pay.payment_method_id!=='pix')reasons.push('metodo nao Pix');
  if(String(pay.external_reference||'')!==id)reasons.push('referencia divergente');
  if(cents(current.valor)!==cents(pay.transaction_amount))reasons.push('valor divergente');
 }
 if(reasons.length){
  console.error('CONFIRMACAO BLOQUEADA',id,'payment',String(pay.id),'motivos:',reasons.join(', '));
  return false;
 }
 // A transacao Firebase pode nao ser aplicada. Registre o resultado e nao confirme
 // visualmente antes da persistencia efetiva.
 const now=Date.now();
 const tx=await ref.transaction(r=>{
  if(!r||String(r.mpPaymentId)!==String(pay.id)||r.status==='cancelado')return;
  if(r.status==='confirmado')return r;
  if(r.status!=='aguardando_pagamento'&&r.status!=='reservado')return;
  return {...r,status:'confirmado',mpStatus:'approved',mpConfirmadoEm:now,atualizadoEm:now};
 },undefined,false);
 const saved=tx.snapshot?.val();
 console.info('CONFIRMACAO TRANSACAO',id,'committed',tx.committed,'status',saved?.status||'ausente');
 if(!tx.committed||saved?.status!=='confirmado'){
  console.error('CONFIRMACAO NAO GRAVADA',id,'statusAtual',saved?.status||'ausente');
  return false;
 }
 // Idempotencia: atualize os indices mesmo quando a reserva ja estava confirmada.
 const updates={};
 if(saved.cpf)updates['rifa/reservasPorCpf/'+saved.cpf+'/'+id+'/status']='confirmado';
 for(const n of saved.numeros||[]){
  const numberRef=db().ref('rifa/numeros/'+n);
  const existing=(await numberRef.get()).val();
  if(existing?.reservaId!==id){
   console.error('NUMERO DIVERGENTE',id,n);
   throw Error('Numero vinculado a outra reserva; revisao administrativa necessaria');
  }
  updates['rifa/numeros/'+n]={...existing,status:'confirmado',atualizadoEm:now};
 }
 await db().ref().update(updates);
 console.info('PAGAMENTO CONFIRMADO',id,String(pay.id));
 return true;
}

async function expire(id,r,pay){
 // Only release a hold when Mercado Pago confirms that payment cannot complete.
 if(!['cancelled','rejected','refunded','charged_back'].includes(pay.status))return;
 const ref=db().ref('rifa/reservas/'+id);
 const tx=await ref.transaction(old=>{if(!old||old.status==='confirmado'||old.status==='cancelado'||String(old.mpPaymentId)!==String(pay.id))return;return {...old,status:'cancelado',mpStatus:pay.status,atualizadoEm:Date.now()}},undefined,false);
 if(!tx.committed)return;
 await db().ref('rifa/numeros').transaction(map=>{map=map||{};for(const n of r.numeros||[])if(map[n]?.reservaId===id&&map[n]?.status==='reservado')delete map[n];return map},undefined,false);
 if(r.cpf)await db().ref('rifa/reservasPorCpf/'+r.cpf+'/'+id+'/status').set('cancelado');
}
async function reconcile(id,r){
 if(!r.mpPaymentId){console.warn('Reserva sem pagamento vinculado',id);return r;}
 let pay=await mp('/v1/payments/'+encodeURIComponent(r.mpPaymentId));
 console.info('Mercado Pago consultado',id,'payment',String(pay.id),'status',pay.status,'metodo',pay.payment_method_id||'indefinido');
 if(pay.status==='approved')await finalize(id,pay);
 else if(['cancelled','rejected','refunded','charged_back'].includes(pay.status))await expire(id,r,pay);
 else if(Date.now()-Number(r.criadoEm||0)>=HOLD_MS){
  // Never free a number until MP explicitly confirms the payment is cancelled.
  try{
   await mp('/v1/payments/'+encodeURIComponent(r.mpPaymentId),{method:'PUT',body:JSON.stringify({status:'cancelled'})});
  }catch(e){console.warn('Cancelamento nao concluido',id,e.message)}
  pay=await mp('/v1/payments/'+encodeURIComponent(r.mpPaymentId));
  if(pay.status==='approved')await finalize(id,pay);
  else if(['cancelled','rejected','refunded','charged_back'].includes(pay.status))await expire(id,r,pay);
  else console.warn('Reserva vencida mantida bloqueada ate confirmacao do MP',id,pay.status);
 }
 return (await db().ref('rifa/reservas/'+id).get()).val();
}
app.post('/api/pix/iniciar',user,async(req,res)=>{let id='';let locked=false;try{
 const nums=[...new Set((Array.isArray(req.body?.numeros)?req.body.numeros:[]).map(Number))].sort((a,b)=>a-b);
 const nome=String(req.body?.nome||'').trim().slice(0,150),telefone=String(req.body?.telefone||'').replace(/\D/g,''),cpf=String(req.body?.cpf||'').replace(/\D/g,''),email=String(req.body?.email||'').trim().slice(0,150);
 if(nome.length<3||telefone.length<10||cpf.length!==11||!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({error:'Informe nome, telefone, CPF e e-mail válido.'});
 if(!nums.length||nums.length>100||nums.some(n=>!Number.isSafeInteger(n)||n<1))return res.status(400).json({error:'Seleção de números inválida'});
 console.info('Pix iniciar: autenticado; consultando configuração');
 const cfg=(await db().ref('rifa/configPublica/rifa').get()).val()||{};
 if(cfg.vendasAbertas===false)return res.status(409).json({error:'Vendas encerradas'});
 const total=Number(cfg.quantidadeNumeros||100),unit=Number(cfg.precoNumero||cfg.preco||0);
 if(nums.some(n=>n>total)||!Number.isSafeInteger(cents(unit))||cents(unit)<100)return res.status(409).json({error:'Configuração de preço ou números inválida'});
 const valor=cents(unit)*nums.length/100;id='RIFA-'+crypto.randomUUID().replace(/-/g,'').slice(0,20).toUpperCase();const now=Date.now();
 const tx=await db().ref('rifa/numeros').transaction(map=>{map=map||{};if(nums.some(n=>map[n]&&map[n].status!=='livre'))return;for(const n of nums)map[n]={status:'reservado',reservaId:id,ownerUid:req.user.uid,atualizadoEm:now};return map},undefined,false);
 if(!tx.committed)return res.status(409).json({error:'Um dos números já está ocupado. Atualize a lista.'});locked=true;console.info('Pix iniciar: números bloqueados',id);
 const r={reservaId:id,ownerUid:req.user.uid,nome,telefone,cpf,email,numeros:nums,valor,status:'aguardando_pagamento',criadoEm:now,expiraEm:now+HOLD_MS,indicadorCodigo:String(req.body?.indicadorCodigo||'').slice(0,80),indicadorCpf:String(req.body?.indicadorCpf||'').replace(/\D/g,'').slice(0,11)};
 await db().ref('rifa/reservas/'+id).set(r);
 console.info('Pix iniciar: enviando solicitação ao Mercado Pago',id);
 const pay=await mp('/v1/payments',{method:'POST',headers:{'X-Idempotency-Key':crypto.createHash('sha256').update('rifa-pix-'+id).digest('hex')},body:JSON.stringify({transaction_amount:valor,description:'Rifa - pedido '+id,payment_method_id:'pix',external_reference:id,notification_url:process.env.PUBLIC_BACKEND_URL.replace(/\/$/,'')+'/api/mercadopago/webhook',date_of_expiration:new Date(now+HOLD_MS).toISOString(),payer:{email,first_name:nome.split(/\s+/)[0],last_name:nome.split(/\s+/).slice(1).join(' ')||'Cliente',identification:{type:'CPF',number:cpf}}})});
 console.info('Pix iniciar: Mercado Pago respondeu',id,String(pay.id),pay.status);
 await db().ref('rifa/reservas/'+id).update({mpPaymentId:String(pay.id),mpStatus:pay.status,mpCriadoEm:sv()});
 await db().ref('rifa/reservasPorCpf/'+cpf+'/'+id).set({reservaId:id,nome,numeros:nums,valor,status:'aguardando_pagamento',criadoEm:now});
 res.json({reservaId:id,numeros:nums,valor,...qr(pay)});
 }catch(e){console.error('Pix iniciar:',e.message,id);if(locked&&id){const r=(await db().ref('rifa/reservas/'+id).get().catch(()=>({val:()=>null}))).val();if(!r?.mpPaymentId && !String(e.message||'').match(/abort|timeout|fetch failed|network/i)){await db().ref('rifa/numeros').transaction(map=>{map=map||{};for(const [n,x] of Object.entries(map))if(x?.reservaId===id&&x?.status==='reservado')delete map[n];return map},undefined,false).catch(()=>{});await db().ref('rifa/reservas/'+id).remove().catch(()=>{})}}res.status(502).json({error:'Não foi possível criar o Pix. '+e.message.slice(0,180)})}});
// Backwards compatibility: existing pending reservations can still generate a Pix.
app.post('/api/pix/criar',user,async(req,res)=>{try{const id=String(req.body?.reservaId||'');if(!validId(id))return res.status(400).json({error:'Reserva inválida'});const ref=db().ref('rifa/reservas/'+id),r=(await ref.get()).val();if(!r||r.ownerUid!==req.user.uid)return res.status(404).json({error:'Reserva não encontrada'});if(r.mpPaymentId){const pay=await mp('/v1/payments/'+r.mpPaymentId);return res.json(qr(pay))}return res.status(409).json({error:'Reserva antiga sem cobrança. Contate o administrador.'})}catch(e){console.error('Pix legado:',e.message);res.status(502).json({error:'Falha ao consultar Pix'})}});
app.get('/api/pix/recuperar/:id',user,async(req,res)=>{try{const id=req.params.id;if(!validId(id))return res.sendStatus(400);const r=(await db().ref('rifa/reservas/'+id).get()).val();if(!r||r.ownerUid!==req.user.uid)return res.sendStatus(404);if(!r.mpPaymentId)return res.status(409).json({error:'Cobrança não encontrada'});const pay=await mp('/v1/payments/'+r.mpPaymentId);res.json({reservaId:id,numeros:r.numeros,valor:r.valor,status:r.status,...qr(pay)})}catch(e){res.status(502).json({error:'Falha ao recuperar cobrança'})}});
app.get('/api/pix/status/:id',user,async(req,res)=>{try{const id=req.params.id;if(!validId(id))return res.sendStatus(400);let r=(await db().ref('rifa/reservas/'+id).get()).val();if(!r||r.ownerUid!==req.user.uid)return res.sendStatus(404);if(r.status!=='confirmado'&&r.mpPaymentId)r=await reconcile(id,r);res.json({reservaId:id,status:r.status,mpStatus:r.mpStatus||'',valor:r.valor,numeros:r.numeros})}catch(e){console.error('Pix status:',e.message);res.status(502).json({error:'Consulta temporariamente indisponível'})}});
function verifiedWebhook(req){const secret=process.env.MP_WEBHOOK_SECRET;if(!secret)return false;const sig=req.headers['x-signature']||'',requestId=req.headers['x-request-id']||'';const ts=/ts=([^,]+)/.exec(sig)?.[1],v1=/v1=([^,]+)/.exec(sig)?.[1],id=String(req.query['data.id']||req.body?.data?.id||'').toLowerCase();if(!ts||!v1||!id||!requestId)return false;const manifest=`id:${id};request-id:${requestId};ts:${ts};`;const hash=crypto.createHmac('sha256',secret).update(manifest).digest('hex');try{return crypto.timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(v1,'hex'))}catch{return false}}
app.post('/api/mercadopago/webhook',async(req,res)=>{if(!verifiedWebhook(req))return res.sendStatus(401);const id=String(req.query['data.id']||req.body?.data?.id||'');try{if(!/^\d+$/.test(id))return res.sendStatus(200);const pay=await mp('/v1/payments/'+id);const rid=String(pay.external_reference||'');if(!validId(rid))return res.sendStatus(200);const r=(await db().ref('rifa/reservas/'+rid).get()).val();if(!r||String(r.mpPaymentId)!==id)return res.sendStatus(200);if(pay.status==='approved')await finalize(rid,pay);else await expire(rid,r,pay);res.sendStatus(200)}catch(e){console.error('Webhook:',e.message);res.sendStatus(500)}});
// Consulta as reservas sem depender de indice Firebase, navegador ou cliente conectado.
// O Render precisa estar acordado; configure um cron/monitor externo para instancias que dormem.
let checking=false;
async function reconcilePending(){
 if(!ready||checking)return;
 checking=true;
 try{
  const snap=await db().ref('rifa/reservas').get();
  const all=snap.val()||{};
  const pending=Object.entries(all).filter(([id,r])=>r&&r.status==='aguardando_pagamento');
  console.info('Reconciliação: reservas pendentes',pending.length);
  for(const [id,r] of pending.slice(0,100)){
   try{
    const updated=await reconcile(id,r);
    if(updated?.status==='confirmado')console.info('Reconciliação: aprovado',id,String(r.mpPaymentId));
   }catch(e){console.error('Reconciliação: falha',id,e.message)}
  }
 }catch(e){console.error('Reconciliação geral:',e.message)}
 finally{checking=false}
}
setTimeout(reconcilePending,5000).unref();
setInterval(reconcilePending,60000).unref();
app.use((e,req,res,next)=>res.status(400).json({error:'Requisição inválida ou origem não autorizada'}));
app.listen(process.env.PORT||10000,'0.0.0.0',()=>console.log('Rifa Pix v2.5 online'));
