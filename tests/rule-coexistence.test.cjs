/*
 * Local emulator only. This deliberately composes two PINNED rule snapshots
 * as a research fixture. It is not a deployment policy or an approval to
 * change the production rules, authentication, Firebase project or IAM.
 * The existing member admin UID placeholder and the prototype admin claim are
 * independent in this fixture; neither is asserted to represent a real user.
 */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {createHash} = require('node:crypto');
const vm = require('node:vm');
const {initializeTestEnvironment} = require('@firebase/rules-unit-testing');
const {doc, collection, getDoc, getDocs, setDoc, updateDoc, writeBatch, serverTimestamp, Timestamp} = require('firebase/firestore');

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (host !== '127.0.0.1:8080' && host !== 'localhost:8080') {
  throw new Error('A loopback Firestore emulator on port 8080 is required; cloud execution is forbidden');
}
const PINNED = {
  // #49: 877d02c1500019ae177508763e1f18cf0a8266e6 (member rules)
  memberRules: '4ffb09ebfb1dd3d89de445ea49faf31e53ba51befa8b846a578dc05404750f02',
  // Updated alongside the auth initialization fix; the VM runs this exact client.
  memberClient: '0bd219f10ddd43e5a0a0a0152d805383e0c22023c86f22d26590770c7d2c51a3',
  // Updated test-only matching policy including optional notes and indicative estimates.
  matchingRules: 'c678d29472071d7f645592e1c659d9f9a6624d22b9ef0c5ead65b4e206fe3d84',
};
function pinned(path, expected) {
  const text = readFileSync(path, 'utf8');
  assert.equal(createHash('sha256').update(text).digest('hex'), expected,
    `${path}: source changed; review and explicitly update the pinned fixture before testing`);
  return text;
}
const memberRules = pinned('firestore.rules', PINNED.memberRules);
const memberClient = pinned('member-sync.js', PINNED.memberClient);
const matchingRules = pinned('tests/fixtures/matching-test-only.rules', PINNED.matchingRules);
assert.equal(pinned('prototype/security/firestore.rules', PINNED.matchingRules), matchingRules, 'test fixture must match prototype rules');
const head = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n";
const tail = '  }\n}\n';
function body(policy) {
  const source = policy.replace(/^\/\/ TEST ONLY:[^\n]*\n/, '');
  assert.ok(source.startsWith(head) && source.endsWith(tail), 'Unexpected policy wrapper; do not compose');
  return source.slice(head.length, -tail.length);
}
// Keep the original member and prototype function/match bodies unchanged.
// Both catch-all deny statements remain: matching Firestore allows are ORed.
const combined = head + body(memberRules) + body(matchingRules) + tail;
const broadMutation = head + body(memberRules) + body(matchingRules)
  + '    match /{unsafe=**} { allow read, write: if true; }\n' + tail;

const anonymous = uid => ({uid, claims:{firebase:{sign_in_provider:'anonymous'}}});
const password = (uid, verified=true) => ({uid, claims:{email_verified:verified,firebase:{sign_in_provider:'password'}}});
const google = uid => ({uid, claims:{firebase:{sign_in_provider:'google.com'}}});
const claimAdmin = {uid:'fake-claim-admin',claims:{admin:true,firebase:{sign_in_provider:'google.com'}}};
const memberAdmin = google('REPLACE_WITH_ADMIN_UID'); // literal test placeholder, not an actual administrator
const dualAdmin = {uid:'REPLACE_WITH_ADMIN_UID',claims:{admin:true,firebase:{sign_in_provider:'google.com'}}};
const roles = {
  visitor:null, anon:anonymous('fake-customer-a'), other:anonymous('fake-customer-b'),
  partner:password('fake-partner-a'), partnerOther:password('fake-partner-b'), partnerPending:password('fake-partner-c'),
  unverified:password('fake-partner-a',false), google:google('fake-google-user'),
  claim:claimAdmin, memberAdmin, dual:dualAdmin,
};
const fakeMember = {
  name:'가상고객',phone:'01000000000',area:'춘천',free:'가상 서비스',ad:false,code:'OK-ABC234',ref:'',
  joined:Timestamp.fromMillis(0),status:'신규',couponStatus:'미사용',freeStatus:'미제공',memo:'',points:0,grade:'새싹',ownerUid:'fake-customer-a'
};
const date = Timestamp.fromMillis(Date.now()+7*86400000);
const fakeQuote = {service:'입주·이사 청소',area:'춘천',size:25,date,name:'가상고객',phone:'01000000000',consentVersion:'test-v1',
  consentAt:Timestamp.fromMillis(0),createdAt:Timestamp.fromMillis(0),ownerUid:'fake-customer-a',status:'신규'};
const memberPayload = uid => ({...fakeMember,joined:serverTimestamp(),ownerUid:uid});
const quotePayload = uid => ({...fakeQuote,consentAt:serverTimestamp(),createdAt:serverTimestamp(),ownerUid:uid});
async function seed(env) {
  await env.withSecurityRulesDisabled(async ctx => {
    const db=ctx.firestore();
    await Promise.all([
      setDoc(doc(db,'member_requests','sample'),fakeMember),
      setDoc(doc(db,'quote_requests','sample'),fakeQuote),
      setDoc(doc(db,'quote_requests','new-offer'),fakeQuote),
      setDoc(doc(db,'quote_requests','pending-offer'),fakeQuote),
      setDoc(doc(db,'quote_requests','batch-good'),fakeQuote),
      setDoc(doc(db,'quote_requests','batch-dual'),fakeQuote),
      setDoc(doc(db,'quote_requests','batch-invalid'),fakeQuote),
      setDoc(doc(db,'quote_requests','batch-forbidden'),fakeQuote),
      setDoc(doc(db,'partner_profiles','fake-partner-a'),{company:'가상업체',areas:['춘천'],specialties:['입주·이사 청소'],status:'승인',approvalVersion:1}),
      setDoc(doc(db,'partner_profiles','fake-partner-b'),{company:'가상업체2',areas:['춘천'],specialties:['입주·이사 청소'],status:'승인',approvalVersion:1}),
      setDoc(doc(db,'partner_profiles','fake-partner-c'),{company:'가상업체3',areas:['춘천'],specialties:['입주·이사 청소'],status:'검토중',approvalVersion:0}),
      setDoc(doc(db,'quote_requests','sample','slots','0'),{partnerUid:'fake-partner-a',grantId:'sample-grant'}),
      setDoc(doc(db,'quote_requests','sample','assignments','fake-partner-a'),{grantId:'sample-grant',slotId:'0'}),
      setDoc(doc(db,'quote_requests','sample','grants','sample-grant'),{partnerUid:'fake-partner-a',approvalVersion:1,slotId:'0',service:fakeQuote.service,area:fakeQuote.area,size:fakeQuote.size,date,createdAt:Timestamp.fromMillis(0)}),
      setDoc(doc(db,'quote_requests','sample','offers','sample-grant'),{price:250000,note:'가상',createdAt:Timestamp.fromMillis(0)}),
      setDoc(doc(db,'quote_requests','new-offer','slots','0'),{partnerUid:'fake-partner-a',grantId:'new-grant'}),
      setDoc(doc(db,'quote_requests','new-offer','assignments','fake-partner-a'),{grantId:'new-grant',slotId:'0'}),
      setDoc(doc(db,'quote_requests','new-offer','grants','new-grant'),{partnerUid:'fake-partner-a',approvalVersion:1,slotId:'0',service:fakeQuote.service,area:fakeQuote.area,size:fakeQuote.size,date,createdAt:Timestamp.fromMillis(0)}),
      setDoc(doc(db,'quote_requests','pending-offer','slots','0'),{partnerUid:'fake-partner-c',grantId:'pending-grant'}),
      setDoc(doc(db,'quote_requests','pending-offer','assignments','fake-partner-c'),{grantId:'pending-grant',slotId:'0'}),
      setDoc(doc(db,'quote_requests','pending-offer','grants','pending-grant'),{partnerUid:'fake-partner-c',approvalVersion:0,slotId:'0',service:fakeQuote.service,area:fakeQuote.area,size:fakeQuote.size,date,createdAt:Timestamp.fromMillis(0)})
    ]);
  });
}
function contexts(env){
  return Object.fromEntries(Object.entries(roles).map(([name,role]) => [name, role
    ? env.authenticatedContext(role.uid,role.claims).firestore() : env.unauthenticatedContext().firestore()]));
}

// Every case runs against both original policies independently and against
// their composition. A policy must never gain the other domain's permission.
const cases = [];
const add = (name,family,role,allowed,run) => cases.push({name,family,role,allowed,run});
function assignBatch(db,requestId,includePrivate=false) {
  const uid='fake-partner-a', grantId='batch-grant', slotId='1';
  const batch=writeBatch(db);
  batch.set(doc(db,'quote_requests',requestId,'slots',slotId),{partnerUid:uid,grantId});
  batch.set(doc(db,'quote_requests',requestId,'assignments',uid),{grantId,slotId});
  const grant={partnerUid:uid,approvalVersion:1,slotId,service:fakeQuote.service,area:fakeQuote.area,
    size:fakeQuote.size,date,createdAt:serverTimestamp()};
  if(includePrivate) grant.phone='01000000000';
  batch.set(doc(db,'quote_requests',requestId,'grants',grantId),grant);
  return batch.commit();
}
for(const [role,ok] of [['visitor',false],['anon',false],['other',false],['partner',false],['google',false],['claim',false],['memberAdmin',true],['dual',true]]) {
  add('member read '+role,'member',role,ok,db=>getDoc(doc(db,'member_requests','sample')));
  add('member list '+role,'member',role,ok,db=>getDocs(collection(db,'member_requests')));
}
for(const [role,ok] of [['visitor',false],['anon',false],['other',false],['partner',false],['google',false],['memberAdmin',false],['claim',true],['dual',true]]) {
  add('quote read '+role,'matching',role,ok,db=>getDoc(doc(db,'quote_requests','sample')));
  add('quote list '+role,'matching',role,ok,db=>getDocs(collection(db,'quote_requests')));
}
add('member create anonymous','member','anon',true,db=>setDoc(doc(db,'member_requests','valid-anon'),memberPayload('fake-customer-a')));
add('member create owner mismatch','member','anon',false,db=>setDoc(doc(db,'member_requests','wrong-owner'),memberPayload('fake-customer-b')));
add('member create unverified signed-out','member','visitor',false,db=>setDoc(doc(db,'member_requests','visitor-create'),memberPayload('fake-customer-a')));
add('member create partner password','member','partner',false,db=>setDoc(doc(db,'member_requests','partner-create'),memberPayload('fake-partner-a')));
add('member create google account','member','google',false,db=>setDoc(doc(db,'member_requests','google-create'),memberPayload('fake-google-user')));
add('member privileged update uid admin','member','memberAdmin',true,db=>updateDoc(doc(db,'member_requests','sample'),{memo:'가상 변경'}));
add('member privileged update claim admin','member','claim',false,db=>updateDoc(doc(db,'member_requests','sample'),{memo:'가상 금지'}));
add('quote create anonymous','matching','anon',true,db=>setDoc(doc(db,'quote_requests','new-anon'),quotePayload('fake-customer-a')));
add('quote create with valid details','matching','anon',true,db=>setDoc(doc(db,'quote_requests','new-details'),{...quotePayload('fake-customer-a'),notes:'가상 요청',estimateMin:100,estimateMax:200}));
add('quote rejects invalid estimate','matching','anon',false,db=>setDoc(doc(db,'quote_requests','bad-details'),{...quotePayload('fake-customer-a'),estimateMin:200,estimateMax:100}));
add('quote create owner mismatch','matching','anon',false,db=>setDoc(doc(db,'quote_requests','wrong-owner'),quotePayload('fake-customer-b')));
add('quote create partner password','matching','partner',false,db=>setDoc(doc(db,'quote_requests','partner-create'),quotePayload('fake-partner-a')));
add('quote status change claim admin','matching','claim',true,db=>updateDoc(doc(db,'quote_requests','sample'),{status:'상담중'}));
add('quote status change uid admin','matching','memberAdmin',false,db=>updateDoc(doc(db,'quote_requests','sample'),{status:'예약확정'}));
add('partner own profile','matching','partner',true,db=>getDoc(doc(db,'partner_profiles','fake-partner-a')));
add('other partner profile','matching','partnerOther',false,db=>getDoc(doc(db,'partner_profiles','fake-partner-a')));
add('unverified partner own profile','matching','unverified',false,db=>getDoc(doc(db,'partner_profiles','fake-partner-a')));
add('partner profile list','matching','partner',false,db=>getDocs(collection(db,'partner_profiles')));
add('claim admin profile list','matching','claim',true,db=>getDocs(collection(db,'partner_profiles')));
add('uid admin profile list','matching','memberAdmin',false,db=>getDocs(collection(db,'partner_profiles')));
// Unlike bypass-seeded records, these three related documents are actually
// created together under the tested rules, including their getAfter checks.
add('uid-only admin cannot create assignment batch','matching','memberAdmin',false,db=>assignBatch(db,'batch-forbidden'));
add('claim admin can create same previously denied assignment','matching','claim',true,db=>assignBatch(db,'batch-forbidden'));
add('claim admin cannot include customer phone in grant','matching','claim',false,db=>assignBatch(db,'batch-invalid',true));
add('claim admin can create same assignment without phone','matching','claim',true,db=>assignBatch(db,'batch-invalid'));
add('claim admin creates valid assignment batch','matching','claim',true,db=>assignBatch(db,'batch-good'));
add('dual admin creates valid assignment batch','matching','dual',true,db=>assignBatch(db,'batch-dual'));
add('assigned partner grant','matching','partner',true,db=>getDoc(doc(db,'quote_requests','sample','grants','sample-grant')));
add('other partner grant','matching','partnerOther',false,db=>getDoc(doc(db,'quote_requests','sample','grants','sample-grant')));
add('unverified partner grant','matching','unverified',false,db=>getDoc(doc(db,'quote_requests','sample','grants','sample-grant')));
add('assigned partner offer','matching','partner',true,db=>getDoc(doc(db,'quote_requests','sample','offers','sample-grant')));
add('other partner offer','matching','partnerOther',false,db=>getDoc(doc(db,'quote_requests','sample','offers','sample-grant')));
add('partner cannot list grants','matching','partner',false,db=>getDocs(collection(db,'quote_requests','sample','grants')));
add('other partner cannot create offer','matching','partnerOther',false,db=>setDoc(doc(db,'quote_requests','new-offer','offers','new-grant'),{price:250000,note:'가상',createdAt:serverTimestamp()}));
add('unapproved partner cannot create offer','matching','partnerPending',false,db=>setDoc(doc(db,'quote_requests','pending-offer','offers','pending-grant'),{price:250000,note:'가상',createdAt:serverTimestamp()}));
add('unverified partner cannot create offer','matching','unverified',false,db=>setDoc(doc(db,'quote_requests','new-offer','offers','new-grant'),{price:250000,note:'가상',createdAt:serverTimestamp()}));
add('anonymous customer cannot create offer','matching','anon',false,db=>setDoc(doc(db,'quote_requests','new-offer','offers','new-grant'),{price:250000,note:'가상',createdAt:serverTimestamp()}));
add('assigned partner cannot add phone to offer','matching','partner',false,db=>setDoc(doc(db,'quote_requests','new-offer','offers','new-grant'),{price:250000,note:'가상',phone:'01000000000',createdAt:serverTimestamp()}));
add('assigned partner can create valid offer','matching','partner',true,db=>setDoc(doc(db,'quote_requests','new-offer','offers','new-grant'),{price:250000,note:'가상',createdAt:serverTimestamp()}));
add('member nested unrelated path','member','dual',false,db=>getDoc(doc(db,'member_requests','sample','grants','sample-grant')));

async function permitted(action) {
  try { await action(); return true; }
  catch(err) {
    if(err && (err.code === 'permission-denied' || err.code === 'firestore/permission-denied')) return false;
    throw err;
  }
}
async function matrix(env,mode) {
  const db=contexts(env), mismatches=[];
  for(const entry of cases) {
    const expected = mode === 'combined' ? entry.allowed : mode === entry.family && entry.allowed;
    const actual = await permitted(()=>entry.run(db[entry.role]));
    if(actual !== expected) mismatches.push(`${entry.name}: expected ${expected}, got ${actual}`);
  }
  return mismatches;
}

// Run the actual checked-in member client body with only its three Firebase
// imports replaced by local test adapters. The Firestore write itself uses the
// emulator SDK and the chosen synthetic authentication context.
function memberEntry(db, existing, uid, recordId) {
  const auth={currentUser:existing ? {uid} : null, authStateReady:async()=>{}};
  let signIns=0;
  const imports = memberClient.match(/^import [^\n]+;$/gm) || [];
  assert.equal(imports.length,3,'Unexpected member client imports');
  let program = memberClient.replace(/^import [^\n]+;\n/gm,'');
  assert.ok(program.includes('export async function submitMember'));
  program = program.replace('export async function submitMember','async function submitMember');
  const context={
    initializeApp:()=>({}),getApps:()=>[],getApp:()=>({}),getAuth:()=>auth,getFirestore:()=>db,
    signInAnonymously:async()=>{signIns++;auth.currentUser={uid};},
    // The pinned client runs in a VM realm; Firestore accepts a host-realm
    // plain object. Preserve its exact fields and host SDK timestamp sentinel.
    crypto:{randomUUID:()=>recordId},doc,setDoc:(ref,data)=>setDoc(ref,Object.fromEntries(Object.entries(data))),serverTimestamp,
    setTimeout,clearTimeout,
  };
  vm.runInNewContext(program+'\nthis.submitMember = submitMember;',context,{filename:'member-sync.js'});
  return {submit:()=>context.submitMember({apiKey:'fake-test-identifier',projectId:'demo-okclean-coexist'},
    {name:'가상고객',phone:'01000000000',area:'춘천',free:'가상 서비스',ad:false,code:'OK-ABC234',ref:''}),getSignIns:()=>signIns};
}

test('pinned member and matching policies remain isolated under composition', {timeout:180000}, async () => {
  for(const [mode, rules] of [['member',memberRules],['matching',matchingRules],['combined',combined]]) {
    const projectId=`demo-okclean-${mode}`;
    const env=await initializeTestEnvironment({projectId,firestore:{rules}});
    try {
      await env.clearFirestore(); await seed(env);
      assert.deepEqual(await matrix(env,mode),[],`${mode} permission matrix`);
      if(mode === 'matching' || mode === 'combined') {
        const grant = await getDoc(doc(contexts(env).partner,'quote_requests','sample','grants','sample-grant'));
        assert.equal(grant.data().area,'춘천');
        assert.deepEqual(Object.keys(grant.data()).sort(),['approvalVersion','area','createdAt','date','partnerUid','service','size','slotId'].sort());
        assert.equal(Object.hasOwn(grant.data(),'name'),false,'grant must not expose customer name');
        assert.equal(Object.hasOwn(grant.data(),'phone'),false,'grant must not expose customer phone');
        const writtenGrant=await getDoc(doc(contexts(env).partner,'quote_requests','batch-good','grants','batch-grant'));
        assert.equal(writtenGrant.exists(),true,'rules-tested assignment batch must create a readable grant');
        assert.deepEqual(Object.keys(writtenGrant.data()).sort(),['approvalVersion','area','createdAt','date','partnerUid','service','size','slotId'].sort());
        assert.equal(Object.hasOwn(writtenGrant.data(),'name'),false);
        assert.equal(Object.hasOwn(writtenGrant.data(),'phone'),false);
      }
      if(mode === 'member' || mode === 'combined') {
        const db=contexts(env);
        const anonymousClient=memberEntry(db.anon,false,'fake-customer-a','client-anonymous');
        assert.equal(await permitted(anonymousClient.submit),true);
        assert.equal(anonymousClient.getSignIns(),1);
        const alreadyAnonymous=memberEntry(db.anon,true,'fake-customer-a','client-existing-anonymous');
        assert.equal(await permitted(alreadyAnonymous.submit),true);
        assert.equal(alreadyAnonymous.getSignIns(),0);
        const partnerClient=memberEntry(db.partner,true,'fake-partner-a','client-password');
        assert.equal(await permitted(partnerClient.submit),false);
        assert.equal(partnerClient.getSignIns(),0);
        const googleClient=memberEntry(db.google,true,'fake-google-user','client-google');
        assert.equal(await permitted(googleClient.submit),false);
        assert.equal(googleClient.getSignIns(),0);
      }
    } finally { await env.cleanup(); }
  }
});

test('the same matrix detects an intentionally broad overlapping allow', {timeout:180000}, async () => {
  const env=await initializeTestEnvironment({projectId:'demo-okclean-mutation',firestore:{rules:broadMutation}});
  try {
    await env.clearFirestore(); await seed(env);
    const mismatches=await matrix(env,'combined');
    assert.ok(mismatches.some(x=>x.startsWith('member read visitor:')),'broad wildcard must break the member deny check');
    assert.ok(mismatches.some(x=>x.startsWith('quote read visitor:')),'broad wildcard must break the quote deny check');
    assert.ok(mismatches.some(x=>x.startsWith('uid-only admin cannot create assignment batch:')),'broad wildcard must break administrator separation');
    assert.ok(mismatches.some(x=>x.startsWith('claim admin cannot include customer phone in grant:')),'broad wildcard must break grant data minimization');
    assert.ok(mismatches.some(x=>x.startsWith('other partner grant:')),'broad wildcard must break partner isolation');
    assert.ok(mismatches.some(x=>x.startsWith('other partner cannot create offer:')),'broad wildcard must break offer creation isolation');
    assert.ok(mismatches.some(x=>x.startsWith('unapproved partner cannot create offer:')),'broad wildcard must break approval isolation');
    assert.ok(mismatches.some(x=>x.startsWith('unverified partner cannot create offer:')),'broad wildcard must break partner verification');
  } finally { await env.cleanup(); }
});
