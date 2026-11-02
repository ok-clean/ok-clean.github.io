'use strict';
// Explicit, keyless, read-only CLI. Never imported by the customer server.
const fs=require('node:fs');
const crypto=require('node:crypto');
const {createGcpReadOnlyInspector}=require('./gcp-readonly-inspector.cjs');
const {createGcpKmsProvider}=require('./gcp-kms-provider.cjs');
const {createGcsCheckpointProvider}=require('./gcs-checkpoint-provider.cjs');
const FORBIDDEN=['GOOGLE_APPLICATION_CREDENTIALS','FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST','FIREBASE_STORAGE_EMULATOR_HOST','FIREBASE_EMULATOR_HUB','FIREBASE_APP_CHECK_DEBUG_TOKEN','FIREBASE_APPCHECK_DEBUG_TOKEN','APP_CHECK_DEBUG_TOKEN'];
function environment(env){if(FORBIDDEN.some(k=>env[k])||env.OKCLEAN_OPERATIONAL_WRITES!=='false'||env.OKCLEAN_RESTORE_ISSUANCE!=='false')throw Error('CLOUD_READ_ENVIRONMENT_REJECTED');}
function prepare(config,env=process.env){
 environment(env);
 if(!config||config.version!==1||config.mode!=='readonly'||!['staging','production'].includes(config.environment)||!Number.isInteger(config.timeoutMs)||config.timeoutMs<1||config.timeoutMs>10000||config.projectId!==env.GOOGLE_CLOUD_PROJECT||config.projectId!==env.OKCLEAN_PROJECT_ID||!config.region||!/^[a-z][a-z0-9-]{1,62}$/.test(config.region)||!config.serviceAccounts?.includes(config.readerServiceAccount)||!Array.isArray(config.kms?.keyVersions)||config.kms.keyVersions.length!==1||!config.kms.keyVersions.every(k=>k.name.includes('/locations/'+config.region+'/'))||!config.checkpoint||typeof config.checkpoint.objectName!=='string'||!/^checkpoints\/[a-f0-9]{64}\/[A-Za-z0-9_-]{16,100}\.json$/.test(config.checkpoint.objectName)||!/^[a-f0-9]{64}$/.test(config.checkpoint.expectedHash)||!Number.isSafeInteger(config.checkpoint.retentionUntil)||typeof config.checkpoint.legalHold!=='boolean')throw Error('CLOUD_READ_CONFIGURATION_REQUIRED');
 const c=structuredClone(config),dummy={getClient:async()=>{throw Error();},getCredentials:async()=>{throw Error();}};
 // Constructors validate all target identifiers before credentials or network access.
 createGcpReadOnlyInspector({...c,auth:dummy});
 createGcpKmsProvider({...c.kms,projectId:c.projectId,serviceAccount:c.readerServiceAccount,timeoutMs:c.timeoutMs,auth:dummy,mode:'readonly'});
 createGcsCheckpointProvider({bucket:c.bucket,projectNumber:c.projectNumber,auth:dummy,mode:'readonly',timeoutMs:c.timeoutMs});
 return c;
}
async function runReadiness(config,{env=process.env,auth,clock=Date.now}={}){
 const c=prepare(config,env),traceId=crypto.randomUUID();
 const google=auth||new (require('google-auth-library').GoogleAuth)({scopes:['https://www.googleapis.com/auth/cloud-platform']});
 // Bind both runtime identity and DB location without allowing caller-provided URLs.
 let active=true;
 const guarded={async getCredentials(){const credentials=await google.getCredentials();environment(env);if(!active||credentials?.client_email!==c.readerServiceAccount||credentials.private_key||credentials.refresh_token||credentials.universe_domain&&credentials.universe_domain!=='googleapis.com')throw Error();return credentials;},async getClient(){await this.getCredentials();const client=await google.getClient();return {request:async options=>{await guarded.getCredentials();if(options.url==='https://storage.googleapis.com/storage/v1/b/'+c.bucket)options={...options,params:{...options.params,fields:options.params.fields+',location'}};const result=await client.request(options);environment(env);if(!active)throw Error();if(options.url==='https://storage.googleapis.com/storage/v1/b/'+c.bucket&&result.data?.location?.toLowerCase()!==c.region)throw Error();if(options.url.includes('firestore.googleapis.com/v1/projects/')&&result.data?.locationId!==c.region)throw Error();await guarded.getCredentials();return result;}};}};
 let timer;
 const results=[];
 const check=async(name,work)=>{try{await work();results.push({name,status:'passed'});}catch{results.push({name,status:'failed',code:'CLOUD_READ_CHECK_FAILED'});}};
 try{
 await Promise.race([(async()=>{
 await check('project_iam_appcheck_database',async()=>{const r=await createGcpReadOnlyInspector({...c,auth:guarded}).inspect();if(!r.metadataChecksPassed)throw Error();});
 await check('kms_public_key',async()=>{const r=await createGcpKmsProvider({...c.kms,auth:guarded,projectId:c.projectId,serviceAccount:c.readerServiceAccount,mode:'readonly',timeoutMs:c.timeoutMs}).inspect(c.kms.keyVersions[0].name);if(!r.publicKeyVerified||r.state!=='ENABLED')throw Error();});
 await check('checkpoint_retention_bytes',async()=>{await createGcsCheckpointProvider({auth:guarded,bucket:c.bucket,projectNumber:c.projectNumber,mode:'readonly',timeoutMs:c.timeoutMs}).read(c.checkpoint);});
 })(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error()),c.timeoutMs*3+1000);})]);
 }catch{results.push({name:'run',status:'failed',code:'CLOUD_READ_TIMEOUT'});}finally{active=false;clearTimeout(timer);}
 return {version:1,traceId,observedAt:clock(),mode:'readonly',checks:structuredClone(results),metadataChecksPassed:results.length===3&&results.every(r=>r.status==='passed'),productionVerified:false,deployAllowed:false,writeAllowed:false,restoreIssuanceAllowed:false,blockers:['EFFECTIVE_IAM_UNVERIFIED','EXTERNAL_WRITER_FENCE_UNVERIFIED','WORM_DESTRUCTIVE_CONTRACT_UNEXECUTED','LIVE_AUTH_APPCHECK_UNEXECUTED','LIVE_WRITE_SIGN_RESTORE_UNEXECUTED']};
}
async function main(argv=process.argv.slice(2),env=process.env){
 try{if(argv.length!==2||!['--validate','--read-only'].includes(argv[0]))throw Error();const stat=fs.statSync(argv[1]);if(!stat.isFile()||stat.size>32768)throw Error();const config=JSON.parse(fs.readFileSync(argv[1],'utf8'));prepare(config,env);if(argv[0]==='--validate'){console.log(JSON.stringify({configurationValid:true,cloudContacted:false,deployAllowed:false}));return 0;}if(env.OKCLEAN_READONLY_APPROVAL!=='approved')throw Error();const result=await runReadiness(config,{env});console.log(JSON.stringify(result));return result.metadataChecksPassed?2:1;
 }catch{console.error(JSON.stringify({code:'CLOUD_READ_STARTUP_REJECTED',deployAllowed:false}));return 1;}
}
if(require.main===module)main().then(code=>{process.exitCode=code;});
module.exports={prepare,runReadiness,main};
