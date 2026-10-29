'use strict';
const express=require('express');
const {initializeApp,applicationDefault}=require('firebase-admin/app');
const {getAuth}=require('firebase-admin/auth');
const {getAppCheck}=require('firebase-admin/app-check');
const {restrictedAppCheck}=require('./app-check-policy.cjs');
const {getFirestore}=require('firebase-admin/firestore');
const {createHttpHandler}=require('./handler.cjs');
const {createRateLimit}=require('./rate-limit.cjs');
const services=require('./services.json');
// Fail closed before starting the listener when production settings are unsafe.
const runtimeErrors=require('./preflight.cjs').validateRuntime(process.env);
if(runtimeErrors.length)throw Error('Unsafe runtime configuration: '+runtimeErrors.join(', '));
// Cloud Run runtime identity supplies credentials; no private key is loaded from source.
initializeApp({credential:applicationDefault(),projectId:process.env.OKCLEAN_PROJECT_ID});
const db=getFirestore();const app=express();
app.disable('x-powered-by');app.use(express.json({limit:'8kb',strict:true}));
app.use(createHttpHandler({auth:getAuth(),appCheck:restrictedAppCheck(getAppCheck(),process.env.OKCLEAN_FIREBASE_WEB_APP_ID),db,rateLimit:createRateLimit(db),allowedOrigin:process.env.ALLOWED_ORIGIN,services,consentVersion:process.env.CONSENT_VERSION,protectedMemberAdminUid:process.env.OKCLEAN_MEMBER_ADMIN_UID,withdrawalPolicyReviewed:process.env.OKCLEAN_WITHDRAWAL_POLICY_REVIEWED==='true'}));
app.use((err,req,res,next)=>{res.status(400).set('Cache-Control','no-store').json({status:'unavailable'});});
app.listen(Number(process.env.PORT)||8080,'0.0.0.0');
