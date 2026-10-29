'use strict';
// EMULATOR ONLY. Trusted server context; never expose a privileged DB to browsers.
const {doc,getDocFromServer}=require('firebase/firestore');
const SAFE_ID=/^[A-Za-z0-9_-]{1,80}$/;
const STATES=new Map([
 ['신규','processing'],['검토중','processing'],['상담중','processing'],
 ['취소','cancelled'],['예약확정','booked'],['작업완료','completed'],['종료','closed']
]);
function createRequestStateReader(db) {
 if(!db)throw new TypeError('Database is required');
 return async function readOwnedState(requestId,uid) {
  if(typeof requestId!=='string' || !SAFE_ID.test(requestId) ||
     typeof uid!=='string' || !uid || uid.length>128)throw new TypeError('Invalid identifier');
  // Read the server, not an offline cache. The trusted reader never returns the full record.
  const snapshot=await getDocFromServer(doc(db,'quote_requests',requestId));
  if(!snapshot.exists())return null;
  const data=snapshot.data();
  if(data.ownerUid!==uid)return null;
  const state=STATES.get(data.status);
  if(!state)throw Error('Unsupported request state');
  return state;
 };
}
module.exports={createRequestStateReader};
