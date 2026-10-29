'use strict';
const crypto=require('node:crypto');
// Shared durable per-account limit: a transaction prevents concurrent instances bypassing it.
function createRateLimit(db,clock=()=>Date.now()){
  const limits={submit:10,status:30,admin:120};
  return async(uid,action)=>{
    if(typeof uid!=='string'||!uid||!limits[action])return false;
    const window=Math.floor(clock()/60000),key=crypto.createHash('sha256').update(uid+'\0'+action+'\0'+window).digest('hex');
    const ref=db.collection('server_rate_limits').doc(key);
    return db.runTransaction(async tx=>{const snap=await tx.get(ref);const count=snap.exists?snap.data().count:0;if(count>=limits[action])return false;tx.set(ref,{count:count+1,expiresAt:new Date((window+10)*60000)});return true;});
  };
}
module.exports={createRateLimit};
