import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import admin from 'firebase-admin';

// Prefer a single Firebase service-account JSON environment variable.
// Legacy separate variables remain supported for existing deployments.
const hasJson=!!process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
const legacy=['FIREBASE_PROJECT_ID','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY'];
const required=['MP_ACCESS_TOKEN','FIREBASE_DATABASE_URL','PUBLIC_SITE_URL','PUBLIC_BACKEND_URL','MP_WEBHOOK_SECRET'];
const missing=required.filter(k=>!process.env[k]);
if(!hasJson)missing.push(...legacy.filter(k=>!process.env[k]));
if(missing.length)console.warn('Variáveis ausentes:',missing.join(', '));
if(!admin.apps.length && !missing.some(k=>k.startsWith('FIREBASE_'))){
 try {
  const credentials=hasJson?JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON):{
   project_id:process.env.FIREBASE_PROJECT_ID,
   client_email:process.env.FIREBASE_CLIENT_EMAIL,
   private_key:process.env.FIREBASE_PRIVATE_KEY
  };
  const privateKey=String(credentials.private_key||'').replace(/\\n/g,'\n');
  if(!credentials.project_id||!credentials.client_email||!privateKey.includes('BEGIN PRIVATE KEY'))throw new Error('JSON da conta de serviço incompleto');
  admin.initializeApp({credential:admin.credential.cert({projectId:credentials.project_id,clientEmail:credentials.client_email,privateKey}),databaseURL:process.env.FIREBASE_DATABASE_URL});
 }catch(e){console.error('Falha ao configurar Firebase:',e.message);}
}
const db=()=>admin.database();
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'32kb'}));
// CORS: normaliza URL completa ou origem e permite os sites oficiais da rifa.
const allowed=new Set((process.env.PUBLIC_SITE_URL||'').split(',').map(s=>s.trim()).filter(Boolean).map(s=>{try{return new URL(s).origin;}catch{return s.replace(/\/$/,'');}}));
allowed.add('https://dielzinho25.github.io');
const corsOptions={origin(origin,cb){if(!origin||allowed.has(origin))return cb(null,true);console.warn('CORS bloqueado para origem:',origin);return cb(null,false);},methods:['GET','POST','OPTIONS'],allowedHeaders:['Authorization','Content-Type'],optionsSuccessStatus:204};
app.use(cors(corsOptions));
app.options('/api/pix/criar',cors(corsOptions));
app.get('/api/diagnostico',(_req,res)=>res.json({online:true,version:'1.3.0',mercadoPagoConfigured:!!process.env.MP_ACCESS_TOKEN,firebaseConfigured:admin.apps.length>0,siteAutorizado:allowed.has('https://dielzinho25.github.io')}));
app.get('/',(req,res)=>res.json({online:true,service:'Rifa Pix Render',version:'1.3.0',mercadoPagoConfigured:!!process.env.MP_ACCESS_TOKEN,firebaseConfigured:admin.apps.length>0}));
async function mp(path,options={}){const r=await fetch('https://api.mercadopago.com'+path,{...options,headers:{Authorization:'Bearer '+process.env.MP_ACCESS_TOKEN,'Content-Type':'application/json',...(options.headers||{})},signal:AbortSignal.timeout(18000)});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error('Mercado Pago: '+(data.message||r.status));return data;}
async function requireUser(req,res,next){try{const m=/^Bearer (.+)$/.exec(req.headers.authorization||'');if(!m)return res.status(401).json({error:'Autenticação necessária'});req.user=await admin.auth().verifyIdToken(m[1]);next();}catch{return res.status(401).json({error:'Sessão inválida'});}}
function cents(v){return Math.round(Number(v)*100);}
app.post('/api/pix/criar',requireUser,async(req,res)=>{try{
 const id=String(req.body?.reservaId||'');if(!/^[a-zA-Z0-9_-]{8,100}$/.test(id))return res.status(400).json({error:'Reserva inválida'});
 const ref=db().ref('rifa/reservas/'+id);const snap=await ref.get();const r=snap.val();if(!r||r.ownerUid!==req.user.uid)return res.status(404).json({error:'Reserva não encontrada'});
 if(['confirmado','cancelado'].includes(r.status))return res.status(409).json({error:'Reserva já finalizada'});
 const cfg=(await db().ref('rifa/configPublica/rifa').get()).val()||{};
 const unit=Number(cfg.precoNumero||cfg.preco||0);
 const nums=Array.isArray(r.numeros)?r.numeros:[];
 const expected=cents(unit)*nums.length;
 if(!Number.isSafeInteger(expected)||expected<100||!nums.length||expected!==cents(r.valor))return res.status(409).json({error:'Valor da reserva divergente. Contate o administrador.'});
 const locks=await Promise.all(nums.map(n=>db().ref('rifa/numeros/'+n).get()));
 if(locks.some(s=>!s.exists()||s.val().reservaId!==id))return res.status(409).json({error:'Os números não estão mais reservados'});
 // Reuse an existing pending charge to avoid charging the same reservation twice.
 if(r.mpPaymentId){const existing=await mp('/v1/payments/'+encodeURIComponent(r.mpPaymentId));if(existing.status==='pending'||existing.status==='in_process')return res.json({paymentId:existing.id,pixCopiaECola:existing.point_of_interaction?.transaction_data?.qr_code||'',qrCodeBase64:existing.point_of_interaction?.transaction_data?.qr_code_base64||''});return res.status(409).json({error:'Cobrança já processada. Consulte o status da reserva.'});}
 const email=String(r.email||'').trim();if(!/^\S+@\S+\.\S+$/.test(email))return res.status(400).json({error:'Informe um e-mail válido na reserva para pagar via Pix'});
 const name=String(r.nome||'Cliente').trim().split(/\s+/);
 const cpf=String(r.cpf||'').replace(/\D/g,'');
 const payload={transaction_amount:expected/100,description:'Rifa - reserva '+id,payment_method_id:'pix',external_reference:id,notification_url:process.env.PUBLIC_BACKEND_URL.replace(/\/$/,'')+'/api/mercadopago/webhook',payer:{email,first_name:name[0],last_name:name.slice(1).join(' ')||'Cliente',...(cpf.length===11?{identification:{type:'CPF',number:cpf}}:{})}};
 const pay=await mp('/v1/payments',{method:'POST',headers:{'X-Idempotency-Key':crypto.createHash('sha256').update('rifa-pix-'+id).digest('hex')},body:JSON.stringify(payload)});
 await ref.update({mpPaymentId:String(pay.id),mpStatus:pay.status,mpCriadoEm:admin.database.ServerValue.TIMESTAMP});
 res.json({paymentId:pay.id,pixCopiaECola:pay.point_of_interaction?.transaction_data?.qr_code||'',qrCodeBase64:pay.point_of_interaction?.transaction_data?.qr_code_base64||''});
 }catch(e){console.error('Pix criar:',e.message);res.status(502).json({error:'Falha ao criar Pix. Confira a configuração e tente novamente.'});}});
function verifiedWebhook(req){const secret=process.env.MP_WEBHOOK_SECRET;if(!secret)return false;const sig=req.headers['x-signature']||'';const requestId=req.headers['x-request-id']||'';const ts=/ts=([^,]+)/.exec(sig)?.[1];const v1=/v1=([^,]+)/.exec(sig)?.[1];const id=String(req.query['data.id']||req.body?.data?.id||'').toLowerCase();if(!ts||!v1||!id||!requestId)return false;const manifest=`id:${id};request-id:${requestId};ts:${ts};`;const expected=crypto.createHmac('sha256',secret).update(manifest).digest('hex');try{return crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(v1,'hex'));}catch{return false;}}
app.post('/api/mercadopago/webhook',async(req,res)=>{if(!verifiedWebhook(req))return res.sendStatus(401);const id=String(req.query['data.id']||req.body?.data?.id||'');try{
 if(!/^\d+$/.test(id))return res.sendStatus(200);
 const pay=await mp('/v1/payments/'+id);if(pay.status!=='approved'||pay.payment_method_id!=='pix')return res.sendStatus(200);
 const rid=String(pay.external_reference||'');if(!/^[a-zA-Z0-9_-]{8,100}$/.test(rid))return res.sendStatus(200);
 const ref=db().ref('rifa/reservas/'+rid);const r=(await ref.get()).val();if(!r||String(r.mpPaymentId)!==String(pay.id)||cents(r.valor)!==cents(pay.transaction_amount))return res.sendStatus(200);
 const now=Date.now();const tx=await ref.transaction(old=>{if(!old||old.status==='confirmado'||old.status==='cancelado'||String(old.mpPaymentId)!==String(pay.id))return;return {...old,status:'confirmado',mpStatus:'approved',mpConfirmadoEm:now,atualizadoEm:now};},undefined,false);
 if(tx.committed){const updates={};if(r.cpf)updates['rifa/reservasPorCpf/'+r.cpf+'/'+rid+'/status']='confirmado';for(const n of r.numeros||[])updates['rifa/numeros/'+n]={status:'confirmado',reservaId:rid,ownerUid:r.ownerUid,atualizadoEm:now};await db().ref().update(updates);}
 // Affiliate credits are left to the admin workflow to avoid duplicate credits with existing admin.js.
 res.sendStatus(200);
 }catch(e){console.error('Webhook:',e.message);res.sendStatus(500);}});
app.use((err,req,res,next)=>res.status(400).json({error:'Requisição inválida'}));
app.listen(process.env.PORT||10000,'0.0.0.0',()=>console.log('Rifa Pix online'));
