'use strict';
// SDK-backed verification only; no users/claims/tokens are created or modified.
// Existing server may supply its initialized app after separate rollout approval.
const {restrictedAppCheck}=require('./app-check-policy.cjs');
function createFirebaseSdkIdentity({app,projectId,appId,clock=Date.now,sdk}={}){
 if(!app||app.options?.projectId!==projectId||typeof projectId!=='string'||!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)||!/^1:[0-9]+:web:[a-fA-F0-9]+$/.test(appId||'')||typeof clock!=='function')throw Error('SDK_IDENTITY_CONFIGURATION_REQUIRED');
 const modules=sdk||{getAuth:require('firebase-admin/auth').getAuth,getAppCheck:require('firebase-admin/app-check').getAppCheck};
 const auth=modules.getAuth(app),check=restrictedAppCheck(modules.getAppCheck(app),appId);
 const productionVerification=()=>!process.env.FIREBASE_AUTH_EMULATOR_HOST&&auth.emulatorMode!==true&&!['FIREBASE_APP_CHECK_DEBUG_TOKEN','FIREBASE_APPCHECK_DEBUG_TOKEN','APP_CHECK_DEBUG_TOKEN'].some(k=>process.env[k]);
 if(!productionVerification())throw Error('SDK_EMULATOR_OR_DEBUG_REJECTED');
 async function verifyIdToken(token){
  try{
   if(!productionVerification()||typeof token!=='string'||!token||token.length>16384)throw Error();
   const c=await auth.verifyIdToken(token,true),now=clock();
   if(!productionVerification()||!Number.isSafeInteger(now)||!c||c.aud!==projectId||c.iss!=='https://securetoken.google.com/'+projectId||typeof c.uid!=='string'||!c.uid||c.uid.length>128||!Number.isSafeInteger(c.exp)||c.exp*1000<=now||!Number.isSafeInteger(c.iat)||c.iat*1000>now)throw Error();
   return c;
  }catch{throw Error('SDK_IDENTITY_REJECTED');}
 }
 async function verifyToken(token){
  try{if(!productionVerification()||typeof token!=='string'||!token||token.length>16384)throw Error();const c=await check.verifyToken(token),now=clock();if(!productionVerification()||!Number.isSafeInteger(now)||!Number.isSafeInteger(c.token?.exp)||c.token.exp*1000<=now||!Number.isSafeInteger(c.token?.iat)||c.token.iat*1000>now)throw Error();return c;}catch{throw Error('SDK_APPCHECK_REJECTED');}
 }
 return Object.freeze({auth:Object.freeze({verifyIdToken}),appCheck:Object.freeze({verifyToken}),
  async verifyIdentity(token){const c=await verifyIdToken(token);if(!Number.isSafeInteger(c.authVersion)||c.authVersion<0)throw Error('SDK_AUTH_VERSION_REQUIRED');return {uid:c.uid,revoked:false,authVersion:c.authVersion,expiresAt:c.exp*1000};},
  async verifyAppCheck(token){const c=await verifyToken(token);return {appId:c.appId,expiresAt:c.token.exp*1000};}
 });
}
module.exports={createFirebaseSdkIdentity};
