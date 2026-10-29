'use strict';
// Separate Cloud Run service/identity for read-only planning. Never deploy or
// activate a schedule without explicit approval. Source and ledger access must
// be read-only; only the distinct control project may be written by this service.
const express=require('express');
const {GoogleAuth}=require('google-auth-library');
const {initializeApp,applicationDefault}=require('firebase-admin/app');
const {getFirestore}=require('firebase-admin/firestore');
const {createRestoreGate}=require('./restore-gate.cjs');
const {attachRetentionPreview,validateRetentionPreviewRuntime}=require('./retention-scheduler.cjs');
async function main(){
 const errors=validateRetentionPreviewRuntime(process.env);
 if(errors.length)throw Error('PREVIEW_CONFIGURATION_INVALID');
 // Unlike an environment variable alone, this checks the identity obtained from
 // workload credentials. IAM permissions still need independent review.
 const auth=new GoogleAuth();const identity=await auth.getCredentials();
 if(identity?.client_email!==process.env.OKCLEAN_RETENTION_PREVIEW_IDENTITY)throw Error('PREVIEW_IDENTITY_MISMATCH');
 const credentials=applicationDefault();
 const source=getFirestore(initializeApp({credential:credentials,projectId:process.env.OKCLEAN_PROJECT_ID},'retention-preview-source'));
 const control=getFirestore(initializeApp({credential:credentials,projectId:process.env.OKCLEAN_RETENTION_CONTROL_PROJECT_ID},'retention-preview-control'));
 const ledger=getFirestore(initializeApp({credential:credentials,projectId:process.env.OKCLEAN_LEDGER_PROJECT_ID},'retention-preview-ledger'));
 const gate=createRestoreGate({ledgerDb:ledger,sourceProject:process.env.OKCLEAN_PROJECT_ID,ledgerProject:process.env.OKCLEAN_LEDGER_PROJECT_ID,restoreId:process.env.OKCLEAN_RESTORE_EPOCH,publicKey:process.env.OKCLEAN_RESTORE_PUBLIC_KEY});
 const app=express();app.disable('x-powered-by');app.use(express.json({limit:'1kb',strict:true}));app.use(gate.middleware);
 attachRetentionPreview({app,db:source,controlDb:control});
 app.use((req,res)=>res.status(404).json({status:'unavailable'}));
 app.use((err,req,res,next)=>res.status(503).json({status:'unavailable'}));
 app.listen(Number(process.env.PORT)||8080,'0.0.0.0');
}
main().catch(()=>{console.error('PREVIEW_STARTUP_BLOCKED');process.exitCode=1;});
