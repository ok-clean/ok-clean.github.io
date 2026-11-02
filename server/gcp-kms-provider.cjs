'use strict';
// Google Cloud KMS REST provider for the existing google-auth-library stack.
// No key creation, import, state mutation, deletion, private-key access or IAM API.
// Supply a trusted keyless GoogleAuth instance from application bootstrap, never
// an HTTP parameter. getCredentials identifies the credential principal; a caller
// supplied serviceAccount string is merely an additional equality check.
// Production/readonly signing remains hard-denied in this PR. Contract-test mode
// is for an explicitly injected mock auth transport only; its marker is not a
// production approval or evidence of IAM. No production entrypoint imports this.
const crypto=require('node:crypto');
const KEY=/^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+\/cryptoKeyVersions\/[1-9][0-9]*$/;
const PROJECT=/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const EMAIL=/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;
const HASH=/^[a-f0-9]{64}$/;
const STATES=new Set(['PENDING_GENERATION','ENABLED','DISABLED','DESTROYED','DESTROY_SCHEDULED','PENDING_IMPORT','IMPORT_FAILED','GENERATION_FAILED','PENDING_EXTERNAL_DESTRUCTION','EXTERNAL_DESTRUCTION_FAILED']);
const CODES=new Set(['GCP_KMS_CONFIGURATION_REQUIRED','GCP_KMS_KEY_NOT_ALLOWED','GCP_KMS_IDENTITY_REJECTED','GCP_KMS_TIMEOUT','GCP_KMS_TRANSPORT_FAILED','GCP_KMS_METADATA_INVALID','GCP_KMS_PUBLIC_KEY_INVALID','GCP_KMS_INTEGRITY_FAILED','GCP_KMS_KEY_UNAVAILABLE','GCP_KMS_SIGNING_BLOCKED','GCP_KMS_SIGN_INPUT_INVALID','GCP_KMS_SIGNATURE_INVALID','GCP_KMS_IDENTITY_CHANGED']);
// Castagnoli CRC32C, reflected polynomial, unsigned output. No optional package.
const TABLE=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=(n&1)?0x82f63b78^(n>>>1):n>>>1;return n>>>0;});
function crc32c(data){if(!Buffer.isBuffer(data))throw Error('GCP_KMS_SIGN_INPUT_INVALID');let crc=0xffffffff;for(const b of data)crc=TABLE[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function sameCrc(value,data){return typeof value==='string'&&/^(0|[1-9][0-9]{0,9})$/.test(value)&&Number(value)<=0xffffffff&&Number(value)===crc32c(data);}
function createGcpKmsProvider({auth,projectId,serviceAccount,role,keyVersions,mode='readonly',signingEnabled=false,timeoutMs=5000,maxReadRetries=1}={}){
 if(typeof auth?.getClient!=='function'||typeof auth?.getCredentials!=='function'||!PROJECT.test(projectId||'')||!EMAIL.test(serviceAccount||'')||!serviceAccount.endsWith('@'+projectId+'.iam.gserviceaccount.com')||!['control','validator','issuer'].includes(role)||!['readonly','production','contract-test'].includes(mode)||typeof signingEnabled!=='boolean'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isInteger(maxReadRetries)||maxReadRetries<0||maxReadRetries>2||!Array.isArray(keyVersions)||!keyVersions.length||keyVersions.length>32)throw Error('GCP_KMS_CONFIGURATION_REQUIRED');
 const keys=new Map(),fingerprints=new Set();
 for(const item of keyVersions){const m=typeof item?.name==='string'&&item.name.match(KEY);if(!m||m[1]!==projectId||!HASH.test(item.publicKeySha256||'')||!['SOFTWARE','HSM'].includes(item.protectionLevel)||keys.has(item.name)||fingerprints.has(item.publicKeySha256))throw Error('GCP_KMS_CONFIGURATION_REQUIRED');keys.set(item.name,Object.freeze({name:item.name,publicKeySha256:item.publicKeySha256,protectionLevel:item.protectionLevel}));fingerprints.add(item.publicKeySha256);}
 const getKey=id=>{const k=keys.get(id);if(!k)throw Error('GCP_KMS_KEY_NOT_ALLOWED');return k;};
 async function execute(work){let active=true,timer;const controller=new AbortController(),started=Date.now(),deadline=started+timeoutMs;
  const alive=()=>{const left=deadline-Date.now();if(!active||left<=0||Date.now()<started)throw Error('GCP_KMS_TIMEOUT');return left;};
  async function identity(){const credentials=await auth.getCredentials();alive();if(credentials?.client_email!==serviceAccount||credentials.private_key||credentials.privateKey||credentials.refresh_token||credentials.universe_domain&&credentials.universe_domain!=='googleapis.com')throw Error('GCP_KMS_IDENTITY_REJECTED');}
  async function client(){await identity();const c=await auth.getClient();alive();if(typeof c?.request!=='function')throw Error('GCP_KMS_CONFIGURATION_REQUIRED');return c;}
  async function request(c,method,suffix,data){
   for(let attempt=0;;attempt++){
    alive();try{
     // Fixed host + validated path only. Never follow a response redirect with
     // credentials. Disable transport retries; only our bounded GET loop retries.
     const result=await c.request({url:'https://cloudkms.googleapis.com/v1/'+suffix,method,...(data?{data}:{}),responseType:'json',timeout:alive(),signal:controller.signal,retry:false,retryConfig:{retry:0},maxRedirects:0,redirect:'error',maxContentLength:65536});alive();
     if(result?.status!==undefined&&result.status!==200)throw Object.assign(Error(),{status:result.status});
     if(!result?.data||typeof result.data!=='object'||Array.isArray(result.data))throw Error('GCP_KMS_TRANSPORT_FAILED');return result.data;
    }catch(e){alive();const status=e?.response?.status??e?.status;
     if(method!=='GET'||attempt>=maxReadRetries||![429,500,502,503,504].includes(status))throw e;
     const delay=25*(attempt+1);if(alive()<=delay)throw Error('GCP_KMS_TIMEOUT');await new Promise(resolve=>setTimeout(resolve,delay));alive();
    }
   }
  }
  try{return await Promise.race([Promise.resolve().then(()=>work({alive,identity,client,request})),new Promise((_,reject)=>{timer=setTimeout(()=>{active=false;controller.abort();reject(Error('GCP_KMS_TIMEOUT'));},timeoutMs);})]);}
  catch(e){throw Error(CODES.has(e?.message)?e.message:'GCP_KMS_TRANSPORT_FAILED');}
  finally{active=false;controller.abort();clearTimeout(timer);}
 }
 function metadata(value,k){if(value?.name!==k.name||value.algorithm!=='EC_SIGN_ED25519'||value.protectionLevel!==k.protectionLevel||!STATES.has(value.state))throw Error('GCP_KMS_METADATA_INVALID');return value;}
 async function read(c,k,io){
  const first=metadata(await io.request(c,'GET',k.name),k);
  // Disabled/destroyed keys may not expose a public key. Return a rejecting state
  // using the trusted pin; do not manufacture an enabled/public-key verification.
  if(first.state!=='ENABLED')return {keyId:k.name,state:first.state,algorithm:first.algorithm,publicKeySha256:k.publicKeySha256,publicKeyVerified:false};
  const response=await io.request(c,'GET',k.name+'/publicKey');
  if(response.name!==k.name||response.algorithm!=='EC_SIGN_ED25519'||response.protectionLevel!==k.protectionLevel||typeof response.pem!=='string'||response.pem.length>4096||!/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/.test(response.pem))throw Error('GCP_KMS_PUBLIC_KEY_INVALID');
  if(!sameCrc(response.pemCrc32c,Buffer.from(response.pem,'utf8')))throw Error('GCP_KMS_INTEGRITY_FAILED');
  let key;try{key=crypto.createPublicKey(response.pem);}catch{throw Error('GCP_KMS_PUBLIC_KEY_INVALID');}
  const fp=crypto.createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
  if(key.asymmetricKeyType!=='ed25519'||fp!==k.publicKeySha256)throw Error('GCP_KMS_PUBLIC_KEY_INVALID');
  const final=metadata(await io.request(c,'GET',k.name),k);
  if(final.state!=='ENABLED')throw Error('GCP_KMS_KEY_UNAVAILABLE');
  return {keyId:k.name,state:final.state,algorithm:final.algorithm,publicKeySha256:fp,publicKeyVerified:true,publicKey:response.pem};
 }
 return Object.freeze({
  async inspect(keyId){const k=getKey(keyId);return execute(async io=>{const c=await io.client(),result=await read(c,k,io);await io.identity();io.alive();return result;});},
  async sign({keyId,serviceAccount:requestedIdentity,data}={}){
   // This is deliberately stronger than signingEnabled. Real production signing
   // needs a separately approved integration; a boolean cannot unlock this mode.
   if(mode!=='contract-test'||!signingEnabled||auth.contractTestTransport!==true||Object.getPrototypeOf(auth)!==Object.prototype)throw Error('GCP_KMS_SIGNING_BLOCKED');
   const k=getKey(keyId);
   if(requestedIdentity!==serviceAccount||!Buffer.isBuffer(data)||!data.length||data.length>65536)throw Error('GCP_KMS_SIGN_INPUT_INVALID');
   const bytes=Buffer.from(data); // freeze caller input before any await
   return execute(async io=>{
    const c=await io.client(),before=await read(c,k,io);if(before.state!=='ENABLED'||before.publicKeyVerified!==true)throw Error('GCP_KMS_KEY_UNAVAILABLE');
    await io.identity();io.alive();
    const result=await io.request(c,'POST',k.name+':asymmetricSign',{data:bytes.toString('base64'),dataCrc32c:String(crc32c(bytes))});
    if(result.name!==k.name||result.protectionLevel!==k.protectionLevel||result.verifiedDataCrc32c!==true)throw Error('GCP_KMS_INTEGRITY_FAILED');
    if(typeof result.signature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(result.signature))throw Error('GCP_KMS_SIGNATURE_INVALID');
    const signature=Buffer.from(result.signature,'base64');
    if(signature.length!==64||signature.toString('base64')!==result.signature||!sameCrc(result.signatureCrc32c,signature))throw Error('GCP_KMS_INTEGRITY_FAILED');
    if(!crypto.verify(null,bytes,crypto.createPublicKey(before.publicKey),signature))throw Error('GCP_KMS_SIGNATURE_INVALID');
    const after=metadata(await io.request(c,'GET',k.name),k);if(after.state!=='ENABLED')throw Error('GCP_KMS_KEY_UNAVAILABLE');
    await io.identity();io.alive();return signature;
   });
  }
 });
}
module.exports={createGcpKmsProvider,crc32c};
