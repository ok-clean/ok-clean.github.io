'use strict';
// Google Cloud Storage JSON API bridge using an injected GoogleAuth client.
// Read-only with real credentials. Insert is reachable ONLY with explicit mock
// transport; no deployment activation, bucket creation, lock/update/delete API.
// https://docs.cloud.google.com/storage/docs/json_api/v1/objects/insert
// https://docs.cloud.google.com/storage/docs/json_api/v1/objects
// Storage object creation is NOT atomic with Firestore anchors or key registries.
const crypto=require('node:crypto');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const validName=x=>typeof x==='string'&&/^checkpoints\/[a-f0-9]{64}\/[A-Za-z0-9_-]{16,100}\.json$/.test(x);
function createGcsCheckpointProvider({auth,bucket,projectNumber,mode='readonly',mockTransport,clock=Date.now,timeoutMs=5000,maxBytes=500000}={}){
 if(!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket||'')||! /^[1-9][0-9]{5,20}$/.test(projectNumber||'')||!['readonly','mock'].includes(mode)||typeof clock!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>1000000||(mode==='readonly'&&(typeof auth?.getClient!=='function'||mockTransport))||(mode==='mock'&&(typeof mockTransport?.request!=='function'||auth)))throw Error('GCS_CHECKPOINT_CONFIGURATION');
 const base='https://storage.googleapis.com/storage/v1/b/'+bucket;
 async function session(fn){const controller=new AbortController();let timer;try{return await Promise.race([(async()=>{const client=mode==='mock'?mockTransport:await auth.getClient();if(controller.signal.aborted)throw Error();return fn(async options=>{if(controller.signal.aborted)throw Error();const r=await client.request({...options,timeout:timeoutMs,maxRedirects:0,redirect:'error',retry:false,retryConfig:{retry:0},signal:controller.signal});if(controller.signal.aborted)throw Error();return r;});})(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('GCS_CHECKPOINT_UNAVAILABLE'));},timeoutMs);})]);}catch{throw Error('GCS_CHECKPOINT_UNAVAILABLE');}finally{clearTimeout(timer);controller.abort();}}
 async function bucketPolicy(request,retentionUntil){const data=(await request({url:base,method:'GET',params:{fields:'name,projectNumber,retentionPolicy,iamConfiguration'}})).data;const now=clock();if(!Number.isSafeInteger(now)||!Number.isSafeInteger(retentionUntil)||retentionUntil<0||data?.name!==bucket||String(data.projectNumber)!==projectNumber||data.retentionPolicy?.isLocked!==true||! /^[1-9][0-9]*$/.test(String(data.retentionPolicy.retentionPeriod||''))||Number(data.retentionPolicy.retentionPeriod)*1000<retentionUntil-now||data.iamConfiguration?.uniformBucketLevelAccess?.enabled!==true)throw Error();}
 function input({objectName,expectedHash,retentionUntil,legalHold}={}){if(!validName(objectName)||! /^[a-f0-9]{64}$/.test(expectedHash||'')||!Number.isSafeInteger(retentionUntil)||typeof legalHold!=='boolean')throw Error('GCS_CHECKPOINT_INPUT');}
 async function readObject(request,expected){
  const {objectName,expectedHash,retentionUntil,legalHold}=expected;const url=base+'/o/'+encodeURIComponent(objectName);
  const meta=(await request({url,method:'GET'})).data;
  if(meta?.bucket!==bucket||meta.name!==objectName||! /^[1-9][0-9]*$/.test(meta.generation||'')||! /^[1-9][0-9]*$/.test(meta.metageneration||'')||meta.metadata?.sha256!==expectedHash||meta.contentType!=='application/json'||! /^[0-9]+$/.test(String(meta.size))||Number(meta.size)>maxBytes||!Number.isFinite(Date.parse(meta.retentionExpirationTime))||Date.parse(meta.retentionExpirationTime)<retentionUntil||(legalHold&&meta.temporaryHold!==true))throw Error();
  const raw=await request({url,method:'GET',params:{alt:'media',generation:meta.generation},responseType:'arraybuffer',maxContentLength:maxBytes});const bytes=Buffer.from(raw.data);
  if(bytes.length!==Number(meta.size)||bytes.length>maxBytes||sha(bytes)!==expectedHash)throw Error();
  const fresh=(await request({url,method:'GET',params:{generation:meta.generation}})).data;
  if(fresh?.generation!==meta.generation||fresh.metageneration!==meta.metageneration||fresh.metadata?.sha256!==expectedHash||fresh.retentionExpirationTime!==meta.retentionExpirationTime||fresh.temporaryHold!==meta.temporaryHold)throw Error();
  return {objectName,generation:meta.generation,metageneration:meta.metageneration,sha256:expectedHash,retentionUntil:Date.parse(meta.retentionExpirationTime),legalHold:meta.temporaryHold===true,bytes,publishAllowed:false};
 }
 return Object.freeze({
  async read(expected){input(expected);return session(async request=>{await bucketPolicy(request,expected.retentionUntil);return readObject(request,expected);});},
  async create({objectName,bytes,retentionUntil,legalHold,traceId}={}){
   if(mode!=='mock')throw Error('GCS_CHECKPOINT_WRITES_BLOCKED');
   if(!Buffer.isBuffer(bytes)||bytes.length>maxBytes||! /^[A-Za-z0-9_-]{16,100}$/.test(traceId||''))throw Error('GCS_CHECKPOINT_INPUT');
   if(retentionUntil<=clock())throw Error('GCS_CHECKPOINT_INPUT');
   const payload=Buffer.from(bytes),expectedHash=sha(payload),expected={objectName,expectedHash,retentionUntil,legalHold};input(expected);
   // No client credentials or arbitrary URLs enter multipart metadata.
   const metadata={name:objectName,contentType:'application/json',temporaryHold:legalHold,metadata:{sha256:expectedHash,traceId}};
   const boundary='okclean_'+crypto.randomBytes(18).toString('hex'),body=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(metadata)+'\r\n--'+boundary+'\r\nContent-Type: application/json\r\n\r\n'),payload,Buffer.from('\r\n--'+boundary+'--\r\n')]);
   return session(async request=>{
    await bucketPolicy(request,retentionUntil);let uncertain=false;
    try{await request({url:'https://storage.googleapis.com/upload/storage/v1/b/'+bucket+'/o',method:'POST',params:{uploadType:'multipart',ifGenerationMatch:0},headers:{'Content-Type':'multipart/related; boundary='+boundary},data:body});}catch{uncertain=true;}
    // Exact retry/lost-ack recovery accepts only independently fetched bytes and
    // required retention/hold, never merely a 412 or successful upload response.
    const stored=await readObject(request,expected);return {...stored,recovered:uncertain};
   });
  }
 });
}
module.exports={createGcsCheckpointProvider};
