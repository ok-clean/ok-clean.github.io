'use strict';
// Read-only identity of the *actual* served Firestore database. A database
// name can be reused after deletion/restoration; its system-generated UID
// binds the short-lived restore certificate to a specific database instance.
// IAM/network fencing and backup provenance remain independently required.
const project=/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const database=/^(?:\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function createFirestoreIdentityResolver({auth,timeoutMs=5000}){
 if(typeof auth?.getClient!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw Error('DATABASE_IDENTITY_CONFIGURATION_INVALID');
 return async function resolve({projectId,databaseId}={}){
  if(!project.test(projectId||'')||!database.test(databaseId||''))throw Error('DATABASE_IDENTITY_CONFIGURATION_INVALID');
  const name=`projects/${projectId}/databases/${databaseId}`;
  const controller=new AbortController();let timer;
  try{
   const read=(async()=>{
    const client=await auth.getClient();
    const response=await client.request({url:`https://firestore.googleapis.com/v1/${name}`,method:'GET',timeout:timeoutMs,maxRedirects:0,signal:controller.signal});
    const data=response?.data;
    if(data?.name!==name||typeof data.uid!=='string'||!uuid.test(data.uid))throw Error('DATABASE_IDENTITY_INVALID');
    return {projectId,databaseId,uid:data.uid};
   })();
   return await Promise.race([read,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('DATABASE_IDENTITY_TIMEOUT'));},timeoutMs);})]);
  }finally{clearTimeout(timer);}
 };
}
module.exports={createFirestoreIdentityResolver};
