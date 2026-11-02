'use strict';
// Synthetic loopback emulator only. Neither fixture is deployed or asserted to
// be the currently configured production policy or administrator identity.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {createHash} = require('node:crypto');
const {initializeTestEnvironment, assertFails, assertSucceeds} = require('@firebase/rules-unit-testing');
const {doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp} = require('firebase/firestore');

const projectId = 'demo-okclean-member-paused';
if (!['127.0.0.1:8087', 'localhost:8087'].includes(process.env.FIRESTORE_EMULATOR_HOST))
  throw Error('A loopback Firestore emulator on port 8087 is required');

function checked(path, sha256) {
  const text = readFileSync(path, 'utf8');
  assert.equal(createHash('sha256').update(text).digest('hex'), sha256,
    `${path} changed; independently review and update this pinned test before using the proposal`);
  return text;
}
const baseline = checked('firestore.rules', '4ffb09ebfb1dd3d89de445ea49faf31e53ba51befa8b846a578dc05404750f02');
const paused = checked('tests/fixtures/member-signup-paused.test-only.rules', '8c6da0a5878c76ceeb03a1fadf37d9cee0a06707e24551b10797c9a24dcdac31');
const makeEnvironment = rules => initializeTestEnvironment({projectId, firestore:{host:'127.0.0.1', port:8087, rules}});
const member = uid => ({name:'합성고객',phone:'01000000000',area:'합성지역',free:'합성서비스',ad:false,
  code:'OK-ABC234',ref:'',joined:serverTimestamp(),status:'신규',couponStatus:'미사용',freeStatus:'미제공',
  memo:'',points:0,grade:'새싹',ownerUid:uid});
const identity = (environment, uid, provider) => environment.authenticatedContext(uid, {firebase:{sign_in_provider:provider}}).firestore();

test('legacy and direct client creates are denied while existing admin capability remains', async () => {
  // Positive control: prove that the synthetic payload is accepted by the
  // repository baseline rather than passing merely due to malformed input.
  let environment = await makeEnvironment(baseline);
  try {
    await environment.clearFirestore();
    const legacy = identity(environment,'synthetic-customer','anonymous');
    await assertSucceeds(setDoc(doc(legacy,'member_requests','old-control'),member('synthetic-customer')));
  } finally { await environment.cleanup(); }

  environment = await makeEnvironment(paused);
  try {
    await environment.clearFirestore();
    // Only the test harness seeds fabricated rows, bypassing the test rules.
    // This is not an assertion about Admin SDK/IAM in the operating project.
    await environment.withSecurityRulesDisabled(async context => {
      const db=context.firestore();
      await setDoc(doc(db,'member_requests','existing-fake'), {name:'기존 합성 회원',status:'신규'});
      await setDoc(doc(db,'member_requests','delete-fake'), {name:'합성 삭제 시험',status:'신규'});
    });
    const anon = identity(environment,'synthetic-customer','anonymous');
    const other = identity(environment,'synthetic-other','anonymous');
    const password = identity(environment,'synthetic-password','password');
    const google = identity(environment,'synthetic-google','google.com');
    const admin = identity(environment,'REPLACE_WITH_ADMIN_UID','google.com');
    const visitor = environment.unauthenticatedContext().firestore();

    for (const [db, uid] of [[anon,'synthetic-customer'],[other,'synthetic-other'],
      [password,'synthetic-password'],[google,'synthetic-google'],[admin,'REPLACE_WITH_ADMIN_UID']]) {
      await assertFails(setDoc(doc(db,'member_requests','new-'+uid),member(uid)));
    }
    await assertFails(setDoc(doc(visitor,'member_requests','new-visitor'),member('visitor')));
    // Same code path as a direct Firestore client, independent of the paused UI.
    await assertFails(setDoc(doc(anon,'member_requests','legacy-replay'),member('synthetic-customer')));
    await assertFails(setDoc(doc(anon,'member_requests','forged-owner'),member('REPLACE_WITH_ADMIN_UID')));
    const batch = writeBatch(anon);
    batch.set(doc(anon,'member_requests','batched-new'),member('synthetic-customer'));
    batch.update(doc(anon,'member_requests','existing-fake'),{status:'완료'});
    await assertFails(batch.commit());

    await assertFails(getDoc(doc(visitor,'member_requests','existing-fake')));
    await assertFails(getDoc(doc(anon,'member_requests','existing-fake')));
    await assertFails(getDocs(collection(other,'member_requests')));
    await assertFails(updateDoc(doc(password,'member_requests','existing-fake'),{status:'완료'}));
    await assertFails(deleteDoc(doc(anon,'member_requests','existing-fake')));
    await assertFails(setDoc(doc(admin,'other_collection','new-fake'),{synthetic:true}));
    const existing = await assertSucceeds(getDoc(doc(admin,'member_requests','existing-fake')));
    assert.equal(existing.data().name,'기존 합성 회원');
    await assertSucceeds(getDocs(collection(admin,'member_requests')));
    await assertSucceeds(updateDoc(doc(admin,'member_requests','existing-fake'),{status:'상담중'}));
    await assertSucceeds(deleteDoc(doc(admin,'member_requests','delete-fake')));
    const after = await assertSucceeds(getDoc(doc(admin,'member_requests','existing-fake')));
    assert.equal(after.data().status,'상담중');
  } finally {
    await environment.clearFirestore();
    await environment.cleanup();
  }
});
