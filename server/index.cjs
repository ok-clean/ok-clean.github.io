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
const {createRestoreGate}=require('./restore-gate.cjs');
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
app.use(restoreGate.middleware);
app.use(createHttpHandler({auth:getAuth(),appCheck:restrictedAppCheck(getAppCheck(),process.env.OKCLEAN_FIREBASE_WEB_APP_ID),db,rateLimit:createRateLimit(db),allowedOrigin:process.env.ALLOWED_ORIGIN,services,consentVersion:process.env.CONSENT_VERSION,protectedMemberAdminUid:process.env.OKCLEAN_MEMBER_ADMIN_UID,withdrawalPolicyReviewed:process.env.OKCLEAN_WITHDRAWAL_POLICY_REVIEWED==='true',memberLinkEnabled:process.env.OKCLEAN_MEMBER_LINK_ENABLED==='true'&&process.env.OKCLEAN_MEMBER_LINK_POLICY_REVIEWED==='true',memberLinkPolicyVersion:process.env.OKCLEAN_MEMBER_LINK_POLICY_VERSION}));
app.use((err,req,res,next)=>{res.status(400).set('Cache-Control','no-store').json({status:'unavailable'});});
app.listen(Number(process.env.PORT)||8080,'0.0.0.0');
