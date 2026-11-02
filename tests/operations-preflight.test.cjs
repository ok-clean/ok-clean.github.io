'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {inspect}=require('../server/operations-preflight.cjs');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
function fixture(){
 const p={source:'sample-source-prod',ledger:'sample-ledger-prod',control:'sample-control-prod'};
 const authorities={};
 const caps={control:['fence.observe','checkpoint.create','control.sign'],validator:['checkpoint.read','restore.read','ledger.read','validation.create','validator.sign'],issuer:['validation.read','ledger.read','attestation.create','issuer.sign']};
 for(const role of Object.keys(caps)){const owner=role==='control'?p.control:p.ledger;authorities[role]={serviceAccount:role+'-agent@'+owner+'.iam.gserviceaccount.com',keyVersion:`projects/${owner}/locations/global/keyRings/sample/cryptoKeys/${role}/cryptoKeyVersions/1`,algorithm:'EC_SIGN_ED25519',state:'ENABLED',capabilities:caps[role]};}
 const env={NODE_ENV:'production',OKCLEAN_PROJECT_ID:p.source,GOOGLE_CLOUD_PROJECT:p.source,OKCLEAN_LEDGER_PROJECT_ID:p.ledger,OKCLEAN_RESTORE_CONTROL_PROJECT_ID:p.control,CONSENT_VERSION:'privacy-v1',ALLOWED_ORIGIN:'https://ok-clean.github.io',OKCLEAN_FIREBASE_WEB_APP_ID:'1:123:web:abcdef',OKCLEAN_RESTORE_EPOCH:'synthetic-epoch-001',OKCLEAN_RESTORE_PUBLIC_KEY:crypto.generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}),OKCLEAN_FIRESTORE_DATABASE_ID:'(default)',OKCLEAN_RESTORE_SERVING_DATABASE_ID:'restore-db',OKCLEAN_RESTORE_ISSUER_ENABLED:'false',OKCLEAN_RESTORE_RENEWAL_ENABLED:'false'};
 const m={schemaVersion:1,projects:p,databases:{source:'(default)',restore:'restore-db',sourceUid:'11111111-1111-4111-8111-111111111111',restoreUid:'22222222-2222-4222-8222-222222222222'},authorities,checkpoint:{bucket:'sample-checkpoints',project:p.control,retentionLocked:true,retentionSeconds:86400,writerAccess:'create-only'},fence:{mode:'deny-all-writers',onExpiry:'remain-closed',coversAdminSdk:true,coversRestoreAndDelete:true},authentication:{checkRevoked:true,appCheckEnforced:true,debugTokensDisabled:true,directClientWrites:false},audit:{mode:'codes-and-hashes-only',separateSink:true,sink:`projects/${p.control}/sinks/sample-audit`},backup:{sourceReadOnly:true,restoreTargetQuarantined:true,automaticRelease:false},keyLifecycle:{unknownKey:'reject',revokedKey:'reject',rotation:'explicit-version-review',expiredProof:'reject'},publishAllowed:false};
 for(const [i,role] of Object.keys(authorities).entries()){authorities[role].notBefore=Date.now()-60000;authorities[role].expiresAt=Date.now()+60000;authorities[role].publicKeySha256=String(i+1).repeat(64);}
 authorities.issuer.publicKeySha256=crypto.createHash('sha256').update(crypto.createPublicKey(env.OKCLEAN_RESTORE_PUBLIC_KEY).export({format:'der',type:'spki'})).digest('hex');
 return {m,env,site:{firebase:{projectId:p.source,appId:env.OKCLEAN_FIREBASE_WEB_APP_ID}}};
}
test('synthetic plan validates without claiming cloud verification or deployment',()=>{const {m,env,site}=fixture(),r=inspect(m,env,site);assert.deepEqual(r.errors,[]);assert.equal(r.deployAllowed,false);assert.equal(r.productionVerified,false);});
const cases=[
 ['expired key',f=>f.m.authorities.control.expiresAt=Date.now()-1,'KEY_CONTROL_VALIDITY_INVALID'],
 ['future key',f=>f.m.authorities.validator.notBefore=Date.now()+3600000,'KEY_VALIDATOR_VALIDITY_INVALID'],
 ['missing expiry',f=>delete f.m.authorities.issuer.expiresAt,'KEY_ISSUER_VALIDITY_INVALID'],
 ['identical public key',f=>f.m.authorities.validator.publicKeySha256=f.m.authorities.control.publicKeySha256,'INDEPENDENT_PUBLIC_KEYS_REQUIRED'],
 ['wrong issuer public key',f=>f.m.authorities.issuer.publicKeySha256='f'.repeat(64),'ISSUER_PUBLIC_KEY_BINDING_MISMATCH'],
 ['malformed fingerprint',f=>f.m.authorities.control.publicKeySha256='invalid','KEY_CONTROL_FINGERPRINT_INVALID'],
 ['inline camelCase key',f=>f.m.nested={privateKey:'SYNTHETIC_CANARY'},'SECRET_MATERIAL_FORBIDDEN'],
 ['inline auth token',f=>f.m.nested={idToken:'SYNTHETIC_CANARY'},'SECRET_MATERIAL_FORBIDDEN'],
 ['credential environment',f=>f.env.EXTRA_ACCESS_TOKEN='SYNTHETIC_CANARY','SECRET_ENV_FORBIDDEN'],
 ['missing environment',f=>f.env={},'PROJECT_ID_INVALID'],
 ['site mismatch',f=>f.site.firebase.projectId='wrong-project','SITE_PROJECT_MISMATCH'],
 ['restore aliases source',f=>f.m.databases.restore='(default)','DATABASE_BINDING_INVALID'],
 ['replacement identity absent',f=>delete f.m.databases.restoreUid,'DATABASE_UID_REQUIRED'],
 ['project overlap',f=>f.m.projects.control=f.m.projects.ledger,'PROJECT_SEPARATION_REQUIRED'],
 ['same signer identity',f=>f.m.authorities.issuer.serviceAccount=f.m.authorities.validator.serviceAccount,'INDEPENDENT_IDENTITIES_REQUIRED'],
 ['different versions of same key',f=>f.m.authorities.issuer.keyVersion=f.m.authorities.validator.keyVersion.replace('/1','/2'),'INDEPENDENT_KEYS_REQUIRED'],
 ['disabled signing key',f=>f.m.authorities.issuer.state='DISABLED','KEY_ISSUER_STATE_INVALID'],
 ['unlocked checkpoint',f=>f.m.checkpoint.retentionLocked=false,'CHECKPOINT_IMMUTABILITY_PLAN_REQUIRED'],
 ['admin SDK bypass',f=>f.m.fence.coversAdminSdk=false,'FENCE_PLAN_INCOMPLETE'],
 ['expiry releases fence',f=>f.m.fence.onExpiry='release','FENCE_PLAN_INCOMPLETE'],
 ['appcheck absent',f=>f.m.authentication.appCheckEnforced=false,'AUTHENTICATION_PLAN_INCOMPLETE'],
 ['token revocation disabled',f=>f.m.authentication.checkRevoked=false,'AUTHENTICATION_PLAN_INCOMPLETE'],
 ['direct client writes',f=>f.m.authentication.directClientWrites=true,'AUTHENTICATION_PLAN_INCOMPLETE'],
 ['audit raw data',f=>f.m.audit.mode='raw','AUDIT_PLAN_INCOMPLETE'],
 ['backup auto release',f=>f.m.backup.automaticRelease=true,'BACKUP_PLAN_INCOMPLETE'],
 ['revoked key accepted',f=>f.m.keyLifecycle.revokedKey='allow','KEY_LIFECYCLE_PLAN_INCOMPLETE'],
 ['issuer gets control signing',f=>f.m.authorities.issuer.capabilities.push('control.sign'),'CAPABILITY_ISSUER_INVALID'],
 ['wildcard permission',f=>f.m.authorities.control.capabilities=['*'],'CAPABILITY_CONTROL_INVALID'],
 ['issuer enabled',f=>f.env.OKCLEAN_RESTORE_ISSUER_ENABLED='true','ISSUANCE_MUST_REMAIN_BLOCKED'],
 ['renewal enabled',f=>f.env.OKCLEAN_RESTORE_RENEWAL_ENABLED='true','ISSUANCE_MUST_REMAIN_BLOCKED'],
 ['embedded credential',f=>f.m.private_key='synthetic-never-log','SECRET_MATERIAL_FORBIDDEN']
];
for(const [name,mutate,code] of cases)test(name,()=>{const f=fixture();mutate(f);const r=inspect(f.m,f.env,f.site);assert.ok(r.errors.includes(code),JSON.stringify(r.errors));assert.equal(r.deployAllowed,false);});
test('CLI preparation passes only synthetic plan, deployment always fails, output redacts supplied secrets',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'okclean-preflight-'));try{
 const f=fixture(),m=path.join(dir,'m.json'),s=path.join(dir,'s.json');fs.writeFileSync(s,JSON.stringify(f.site));fs.writeFileSync(m,JSON.stringify(f.m));
 const run=mode=>spawnSync(process.execPath,['server/operations-preflight.cjs',mode,m,s],{env:f.env,encoding:'utf8'});
 assert.equal(run('--prepare').status,0);assert.equal(run('--deployment').status,1);
 f.m.private_key='synthetic-secret-marker';fs.writeFileSync(m,JSON.stringify(f.m));const r=run('--prepare');assert.equal(r.status,1);assert.ok(!r.stdout.includes('synthetic-secret-marker'));assert.ok(!r.stderr.includes('synthetic-secret-marker'));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('missing input file yields fixed diagnostic only',()=>{const r=spawnSync(process.execPath,['server/operations-preflight.cjs','--prepare','secret-path-marker','missing'],{encoding:'utf8'});assert.equal(r.status,2);assert.equal(r.stderr.trim(),'INPUT_UNREADABLE');});

test('invalid clock cannot validate key lifetimes',()=>{const f=fixture();assert.ok(inspect(f.m,f.env,f.site,NaN).errors.includes('CLOCK_INVALID'));});
test('oversized input fails with no supplied data in diagnostics',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'okclean-limit-'));try{const p=path.join(dir,'manifest.json');fs.writeFileSync(p,JSON.stringify({secret:'SYNTHETIC_CANARY',padding:'x'.repeat(65536)}));const r=spawnSync(process.execPath,['server/operations-preflight.cjs','--prepare',p,p],{encoding:'utf8',env:{}});assert.equal(r.status,2);assert.equal(r.stderr.trim(),'INPUT_UNREADABLE');assert.ok(!r.stdout.includes('SYNTHETIC_CANARY'));}finally{fs.rmSync(dir,{recursive:true});}});
