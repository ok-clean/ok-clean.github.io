'use strict';
const express=require('express');
const {initializeApp,applicationDefault}=require('firebase-admin/app');
const {getAuth}=require('firebase-admin/auth');
const {getAppCheck}=require('firebase-admin/app-check');
const {restrictedAppCheck}=require('./app-check-policy.cjs');
const {getFirestore}=require('firebase-admin/firestore');
const {createHttpHandler}=require('./handler.cjs');
const {createRateLimit}=require('./rate-limit.cjs');
const {attachDemoRetentionRoute}=require('./demo-retention-route.cjs');
const {createRestoreGate,startRestoreHealthMonitor}=require('./restore-gate.cjs');
const services=require('./services.json');
// Fail closed before starting the listener when production settings are unsafe.
const runtimeErrors=require('./preflight.cjs').validateRuntime(process.env);
if(runtimeErrors.length)throw Error('Unsafe runtime configuration: '+runtimeErrors.join(', '));
// Cloud Run runtime identity supplies credentials; no private key is loaded from source.
initializeApp({credential:applicationDefault(),projectId:process.env.OKCLEAN_PROJECT_ID});
const db=getFirestore();const app=express();
app.disable('x-powered-by');app.use(express.json({limit:'8kb',strict:true}));
// Always disabled under production preflight; test harness can exercise it on demo emulators.
attachDemoRetentionRoute({app,db,createLedgerDb:()=>getFirestore(initializeApp({projectId:'demo-okclean-ledger'},'demo-retention-ledger'))});
// Separate IAM principal permissions must make this project's ledger strictly
// read-only to the reservation server; Firestore security rules do not constrain
// the Admin SDK. A gate check cannot replace a network fence during restore.
const restoreLedger=getFirestore(initializeApp({credential:applicationDefault(),projectId:process.env.OKCLEAN_LEDGER_PROJECT_ID},'restore-gate-ledger'));
const restoreGate=createRestoreGate({ledgerDb:restoreLedger,sourceProject:process.env.OKCLEAN_PROJECT_ID,ledgerProject:process.env.OKCLEAN_LEDGER_PROJECT_ID,restoreId:process.env.OKCLEAN_RESTORE_EPOCH,publicKey:process.env.OKCLEAN_RESTORE_PUBLIC_KEY});
let renew=null;
if(process.env.OKCLEAN_RESTORE_RENEWAL_ENABLED==='true'){
  // The default Cloud Run workload identity must have ONLY invoker access to
  // the dedicated issuer. Its independent validator and KMS are mandatory.
  const {GoogleAuth}=require('google-auth-library');
  const {createRestoreRenewer}=require('./restore-renewal.cjs');
  const google=new GoogleAuth();
  const controlProjectId=process.env.OKCLEAN_RESTORE_CONTROL_PROJECT_ID;
  const controlDb=getFirestore(initializeApp({credential:applicationDefault(),projectId:controlProjectId},'restore-renewal-control'));
  renew=createRestoreRenewer({controlDb,controlProjectId,sourceProjectId:process.env.OKCLEAN_PROJECT_ID,ledgerProjectId:process.env.OKCLEAN_LEDGER_PROJECT_ID,issuerOrigin:process.env.OKCLEAN_RESTORE_ISSUER_ORIGIN,createClient:audience=>google.getIdTokenClient(audience)});
}
const restoreMonitor=startRestoreHealthMonitor(restoreGate,{renew});
// Cloud Run can suspend CPU outside requests. Await the renewal check while a
// request is active, then independently revalidate before passing it through.
// Failed renewal does not extend expired/untrusted attestations.
app.use(async(req,res,next)=>{await restoreMonitor.check();return restoreGate.middleware(req,res,next);});
// Separate Scheduler identity; token recovery does not delete accounts.
// This route remains absent unless explicitly enabled after policy review.
if(process.env.OKCLEAN_WITHDRAWAL_RECOVERY_ENABLED==='true'){
  const {createWithdrawalRecoveryHandler}=require('./account-withdrawal.cjs');
  const {createGoogleOidcVerifier}=require('./demo-retention-route.cjs');
  const recover=createWithdrawalRecoveryHandler({db,auth:getAuth(),verifyOidc:createGoogleOidcVerifier(),config:{enabled:true,policyReviewed:process.env.OKCLEAN_WITHDRAWAL_POLICY_REVIEWED==='true',projectId:process.env.OKCLEAN_PROJECT_ID,audience:process.env.OKCLEAN_WITHDRAWAL_RECOVERY_AUDIENCE,serviceAccount:process.env.OKCLEAN_WITHDRAWAL_RECOVERY_ACCOUNT,protectedMemberAdminUid:process.env.OKCLEAN_MEMBER_ADMIN_UID}});
  app.post('/_internal/withdrawal/recover',recover);
}
app.use(createHttpHandler({auth:getAuth(),appCheck:restrictedAppCheck(getAppCheck(),process.env.OKCLEAN_FIREBASE_WEB_APP_ID),db,rateLimit:createRateLimit(db),allowedOrigin:process.env.ALLOWED_ORIGIN,services,consentVersion:process.env.CONSENT_VERSION,protectedMemberAdminUid:process.env.OKCLEAN_MEMBER_ADMIN_UID,withdrawalPolicyReviewed:process.env.OKCLEAN_WITHDRAWAL_POLICY_REVIEWED==='true',memberLinkEnabled:process.env.OKCLEAN_MEMBER_LINK_ENABLED==='true'&&process.env.OKCLEAN_MEMBER_LINK_POLICY_REVIEWED==='true',memberLinkPolicyVersion:process.env.OKCLEAN_MEMBER_LINK_POLICY_VERSION}));
app.use((err,req,res,next)=>{res.status(400).set('Cache-Control','no-store').json({status:'unavailable'});});
app.listen(Number(process.env.PORT)||8080,'0.0.0.0');
