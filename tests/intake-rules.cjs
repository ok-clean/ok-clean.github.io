const fs=require('node:fs');const assert=require('node:assert/strict');
const {initializeTestEnvironment,assertSucceeds:yes,assertFails:no}=require('@firebase/rules-unit-testing');
const {doc,setDoc,getDoc,getDocs,collection,query,orderBy,limit,writeBatch,serverTimestamp,updateDoc,deleteDoc,deleteField}=require('firebase/firestore');
(async()=>{
 const env=await initializeTestEnvironment({projectId:'demo-okclean-intake',firestore:{host:'127.0.0.1',port:8088,rules:fs.readFileSync('firestore.rules','utf8')}});
 let checks=0;const pass=async(p)=>{await yes(p);checks++},deny=async(p)=>{await no(p);checks++};
 const db=uid=>env.authenticatedContext(uid,{firebase:{sign_in_provider:'anonymous'}}).firestore();
 const admin=env.authenticatedContext('H1MfdqGkFRZzU8qkqwXTsiKv3CO2',{firebase:{sign_in_provider:'google.com'}}).firestore();
 const data=uid=>({name:'합성테스트',phone:'010-0000-0000',area:'시험',free:'시험서비스',ad:false,code:'OK-ABC234',ref:'',joined:serverTimestamp(),status:'신규',couponStatus:'미사용',freeStatus:'미제공',memo:'',points:0,grade:'새싹',ownerUid:uid});
 const submit=(client,uid,patch={})=>{const b=writeBatch(client);b.set(doc(client,'member_requests',uid),{...data(uid),...patch});b.set(doc(client,'member_receipts',uid),{ownerUid:uid,requestId:uid,code:'OK-ABC234',joined:serverTimestamp()});return b.commit()};
 try{
 await env.clearFirestore();const a=db('a'),b=db('b'),guest=env.unauthenticatedContext().firestore();
 await pass(getDoc(doc(a,'member_receipts','a')));
 await pass(submit(a,'a'));
 await deny(submit(a,'a')); // cannot overwrite management state on retry
 await pass(getDoc(doc(a,'member_receipts','a')));
 await deny(getDoc(doc(a,'member_requests','a'))); // no internal notes even to owner
 await deny(getDoc(doc(b,'member_receipts','a')));await deny(getDocs(collection(a,'member_receipts')));
 await deny(getDocs(collection(a,'member_requests')));await deny(getDoc(doc(guest,'member_requests','a')));
 await deny(submit(b,'a'));await deny(submit(guest,'guest'));
 for(const patch of [{memo:'hack'},{status:'예약확정'},{points:1},{grade:'VIP'},{ownerUid:'other'},{extra:true},{name:'x'.repeat(31)},{phone:123},{joined:new Date(0)}])await deny(submit(b,'b',patch));
 await deny(setDoc(doc(b,'member_requests','b'),data('b'))); // atomic receipt required
 await pass(getDocs(query(collection(admin,'member_requests'),orderBy('joined','desc'),limit(500))));
 await pass(updateDoc(doc(admin,'member_requests','a'),{status:'상담중',memo:'합성 확인',points:5}));
 const saved=await getDoc(doc(admin,'member_requests','a'));assert.equal(saved.data().memo,'합성 확인');checks++;
 await deny(updateDoc(doc(a,'member_requests','a'),{memo:'hack'}));
 for(const patch of [{name:'changed'},{ownerUid:'b'},{memo:'x'.repeat(1001)},{status:deleteField()},{points:-1},{extra:'bad'}])await deny(updateDoc(doc(admin,'member_requests','a'),patch));
 await deny(deleteDoc(doc(admin,'member_requests','a')));
 assert.equal((await getDocs(collection(admin,'member_requests'))).size,1);checks++;
 console.log('INTAKE RULES PASS',checks);
 }finally{await env.clearFirestore();await env.cleanup()}
})().catch(e=>{console.error(e);process.exitCode=1});
