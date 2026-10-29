'use strict';
// No independently verified fence/replay driver exists yet. Do not permit a
// deployed issuer to mint attestations based only on externally asserted state.
// This is a hard code-level guard, not an operator-controlled setting.
const INDEPENDENT_RESTORE_VERIFIER_IMPLEMENTED=false;
if(!INDEPENDENT_RESTORE_VERIFIER_IMPLEMENTED)throw Error('INDEPENDENT_RESTORE_VERIFIER_REQUIRED');
// Separate Cloud Run entrypoint; never started by the customer API. No key files.
const express=require('express');
const {initializeApp,applicationDefault}=require('firebase-admin/app');
const {getFirestore}=require('firebase-admin/firestore');
const {OAuth2Client,GoogleAuth}=require('google-auth-library');
const {createDeletionLedger}=require('./deletion-ledger.cjs');
const {createRestoreIssuer}=require('./restore-issuer.cjs');
const env=process.env;
if(env.OKCLEAN_RESTORE_ISSUER_ENABLED!=='true'||!env.GOOGLE_CLOUD_PROJECT||env.GOOGLE_CLOUD_PROJECT!==env.OKCLEAN_LEDGER_PROJECT_ID||Object.keys(env).some(k=>/FIREBASE.*EMULATOR|FIRESTORE_EMULATOR|APP.?CHECK.*DEBUG|GOOGLE_APPLICATION_CREDENTIALS/i.test(k)&&env[k]))throw Error('ISSUER_RUNTIME_NOT_CONFIGURED');
const key=env.OKCLEAN_RESTORE_KMS_KEY_VERSION;
if(typeof key!=='string'||!/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+\/cryptoKeyVersions\/[1-9][0-9]*$/.test(key))throw Error('KMS_KEY_VERSION_REQUIRED');
const sourceProject=env.OKCLEAN_PROJECT_ID,ledgerProject=env.OKCLEAN_LEDGER_PROJECT_ID,restoreId=env.OKCLEAN_RESTORE_EPOCH;
const db=getFirestore(initializeApp({credential:applicationDefault(),projectId:ledgerProject},'restore-issuer'));
const ledger=createDeletionLedger({ledgerDb:db,primaryProjectId:sourceProject,ledgerProjectId:ledgerProject});
const oidc=new OAuth2Client(),gcp=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});
const handler=createRestoreIssuer({ledgerDb:db,ledger,sourceProject,ledgerProject,restoreId,authorityPublicKey:env.OKCLEAN_RESTORE_VALIDATOR_PUBLIC_KEY,gatePublicKey:env.OKCLEAN_RESTORE_PUBLIC_KEY,callerEmail:env.OKCLEAN_RESTORE_ISSUER_CALLER,audience:env.OKCLEAN_RESTORE_ISSUER_AUDIENCE,
 verifyOidc:async(token,audience)=>(await oidc.verifyIdToken({idToken:token,audience})).getPayload(),
 sign:async data=>{const client=await gcp.getClient();const result=await client.request({url:`https://cloudkms.googleapis.com/v1/${key}:asymmetricSign`,method:'POST',data:{data:data.toString('base64')}});const value=result.data?.signature;if(typeof value!=='string')throw Error('KMS_SIGN_FAILED');return Buffer.from(value,'base64');}
});
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'2kb',strict:true}));app.post('/_internal/restore/issue',handler);app.use((req,res)=>res.status(404).json({status:'unavailable'}));app.listen(Number(env.PORT)||8080,'0.0.0.0');
