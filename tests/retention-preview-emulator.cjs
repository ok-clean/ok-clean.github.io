'use strict';
// Local synthetic Firestore only. OIDC verifier is a test double, not a real token.
const assert=require('node:assert/strict'),admin=require('firebase-admin');
const {createRetentionService}=require('../server/retention.cjs');
const {createRetentionPreviewHandler}=require('../server/retention-scheduler.cjs');
const project='demo-okclean-integration',controlProject='demo-okclean-control',host='127.0.0.1:8085';
if(process.env.GCLOUD_PROJECT!==project||process.env.FIRESTORE_EMULATOR_HOST!==host)throw Error('DEMO_EMULATOR_REQUIRED');
async function main(){
 const app=admin.initializeApp({projectId:project},'preview-source'),other=admin.initializeApp({projectId:controlProject},'preview-control');
 const db=admin.firestore(app),controlDb=admin.firestore(other),ref=db.collection('quote_requests').doc('preview-synthetic');
 try{
  await ref.create({status:'종료',legalHold:false,name:'가상고객',ownerUid:'fake-owner'});
  await ref.collection('status_history').doc('event').create({from:'상담중',to:'종료',at:new Date('2030-01-01T00:00:00Z')});
  const service=createRetentionService({db,projectId:project,firestoreHost:host,policy:{reservationDays:30,historyDays:90},previewOnly:true,clock:()=>new Date('2030-03-01T00:00:00Z')});
  await assert.rejects(service.process(ref.id,{apply:true}),/PREVIEW_READ_ONLY/);
  const audience='https://preview.example.test/_internal/retention/preview',email='scheduler@demo-ok.iam.gserviceaccount.com';
  const h=createRetentionPreviewHandler({db,controlDb,service,verifyOidc:async()=>({aud:audience,iss:'https://accounts.google.com',email_verified:true,email}),config:{enabled:true,reviewed:true,projectId:project,controlProjectId:controlProject,ledgerProjectId:'demo-okclean-ledger',audience,serviceAccount:email,policyVersion:'preview-v1',reservationDays:30,historyDays:90},clock:()=>new Date('2030-03-01T00:00:00Z'),newId:()=> 'synthetic-run'});
  const res={code:0,body:null,set(){return this},status(c){this.code=c;return this},json(v){this.body=v;return this}};
  await h({method:'POST',headers:{authorization:'Bearer synthetic'}},res);
  assert.equal(res.code,200);assert.equal(res.body.counts.would_redact,1);assert.doesNotMatch(JSON.stringify(res.body),/가상고객|fake-owner|preview-synthetic/);
  assert.equal((await ref.get()).data().name,'가상고객');assert.equal((await ref.collection('status_history').get()).size,1);
  const audit=(await controlDb.collection('retention_preview_runs').get());assert.equal(audit.size,1);assert.doesNotMatch(JSON.stringify(audit.docs[0].data()),/가상고객|fake-owner|preview-synthetic/);
  console.log('PASS read-only retention preview via synthetic Firestore projects; OIDC test double');
 }finally{await Promise.all([app.delete(),other.delete()]);}
}
main().catch(()=>{console.error('PREVIEW_EMULATOR_FAILED');process.exitCode=1});
