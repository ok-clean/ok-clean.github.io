'use strict';
// Offline preparation only. Never grants access, issues proof, or contacts GCP.
const fs=require('node:fs');
const path=require('node:path');
const {validateRuntime}=require('./preflight.cjs');
const project=/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const db=/^(\(default\)|[a-z][a-z0-9-]{2,61}[a-z0-9])$/;
const uid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const kms=/^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/([A-Za-z0-9_-]+)\/cryptoKeyVersions\/[1-9][0-9]*$/;
const roles=['control','validator','issuer'];
function inspect(m,env,site){
 const errors=validateRuntime(env);const need=(ok,code)=>{if(!ok)errors.push(code);};
 if(!m||typeof m!=='object'||Array.isArray(m))m={};
 need(m.schemaVersion===1,'MANIFEST_VERSION_INVALID');
 need(site?.firebase?.projectId===env.OKCLEAN_PROJECT_ID,'SITE_PROJECT_MISMATCH');
 need(site?.firebase?.appId===env.OKCLEAN_FIREBASE_WEB_APP_ID,'SITE_APP_MISMATCH');
 const p=m.projects||{};
 need(p.source===env.OKCLEAN_PROJECT_ID&&p.ledger===env.OKCLEAN_LEDGER_PROJECT_ID&&p.control===env.OKCLEAN_RESTORE_CONTROL_PROJECT_ID,'PROJECT_BINDING_MISMATCH');
 need([p.source,p.ledger,p.control].every(x=>typeof x==='string'&&project.test(x)&&! /^(demo|test|example)-/.test(x))&&new Set(Object.values(p)).size===3,'PROJECT_SEPARATION_REQUIRED');
 const d=m.databases||{};
 need(db.test(d.source||'')&&db.test(d.restore||'')&&d.source!==d.restore&&d.restore===env.OKCLEAN_RESTORE_SERVING_DATABASE_ID&&d.source===env.OKCLEAN_FIRESTORE_DATABASE_ID,'DATABASE_BINDING_INVALID');
 need(uid.test(d.sourceUid||'')&&uid.test(d.restoreUid||'')&&d.sourceUid!==d.restoreUid,'DATABASE_UID_REQUIRED');
 const accounts=[],keys=[];
 for(const role of roles){
  const v=m.authorities?.[role]||{},owner=role==='control'?p.control:p.ledger;
  need(typeof v.serviceAccount==='string'&&/^[a-z][a-z0-9-]{4,28}[a-z0-9]@/.test(v.serviceAccount)&&v.serviceAccount.endsWith('@'+owner+'.iam.gserviceaccount.com'),'AUTHORITY_'+role.toUpperCase()+'_INVALID');
  const match=typeof v.keyVersion==='string'&&v.keyVersion.match(kms);
  need(!!match&&match[1]===owner,'KEY_'+role.toUpperCase()+'_INVALID');
  accounts.push(v.serviceAccount);keys.push(match?v.keyVersion.replace(/\/cryptoKeyVersions\/[0-9]+$/,''):null);
  need(v.algorithm==='EC_SIGN_ED25519'&&v.state==='ENABLED','KEY_'+role.toUpperCase()+'_STATE_INVALID');
 }
 need(accounts.every(Boolean)&&new Set(accounts).size===3,'INDEPENDENT_IDENTITIES_REQUIRED');
 need(keys.every(Boolean)&&new Set(keys).size===3,'INDEPENDENT_KEYS_REQUIRED');
 const c=m.checkpoint||{};
 need(typeof c.bucket==='string'&&/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(c.bucket)&&c.project===p.control,'CHECKPOINT_RESOURCE_INVALID');
 need(c.retentionLocked===true&&Number.isSafeInteger(c.retentionSeconds)&&c.retentionSeconds>0&&c.writerAccess==='create-only','CHECKPOINT_IMMUTABILITY_PLAN_REQUIRED');
 const f=m.fence||{};
 need(f.mode==='deny-all-writers'&&f.onExpiry==='remain-closed'&&f.coversAdminSdk===true&&f.coversRestoreAndDelete===true,'FENCE_PLAN_INCOMPLETE');
 const a=m.authentication||{};
 need(a.checkRevoked===true&&a.appCheckEnforced===true&&a.debugTokensDisabled===true&&a.directClientWrites===false,'AUTHENTICATION_PLAN_INCOMPLETE');
 need(m.audit?.mode==='codes-and-hashes-only'&&m.audit?.separateSink===true&&typeof m.audit?.sink==='string'&&/^projects\/[a-z0-9-]+\/sinks\/[A-Za-z0-9_-]+$/.test(m.audit.sink),'AUDIT_PLAN_INCOMPLETE');
 need(m.backup?.sourceReadOnly===true&&m.backup?.restoreTargetQuarantined===true&&m.backup?.automaticRelease===false,'BACKUP_PLAN_INCOMPLETE');
 need(m.keyLifecycle?.unknownKey==='reject'&&m.keyLifecycle?.revokedKey==='reject'&&m.keyLifecycle?.rotation==='explicit-version-review'&&m.keyLifecycle?.expiredProof==='reject','KEY_LIFECYCLE_PLAN_INCOMPLETE');
 // A minimal capability contract, NOT a claim about effective cloud IAM.
 const allowed={control:['fence.observe','checkpoint.create','control.sign'],validator:['checkpoint.read','restore.read','ledger.read','validation.create','validator.sign'],issuer:['validation.read','ledger.read','attestation.create','issuer.sign']};
 for(const role of roles){const caps=m.authorities?.[role]?.capabilities;need(Array.isArray(caps)&&caps.length===allowed[role].length&&new Set(caps).size===caps.length&&caps.every(x=>allowed[role].includes(x)),'CAPABILITY_'+role.toUpperCase()+'_INVALID');}
 need(env.OKCLEAN_RESTORE_ISSUER_ENABLED==='false'&&env.OKCLEAN_RESTORE_RENEWAL_ENABLED==='false'&&m.publishAllowed===false,'ISSUANCE_MUST_REMAIN_BLOCKED');
 const encoded=JSON.stringify(m);
 need(!/-----BEGIN [^-]*PRIVATE KEY-----|"(?:private_key|access_token|refresh_token|client_secret|password)"\s*:/i.test(encoded),'SECRET_MATERIAL_FORBIDDEN');
 return {staticValid:errors.length===0,productionVerified:false,deployAllowed:false,errors:[...new Set(errors)],blockers:['LIVE_IAM_APPCHECK_UNVERIFIED','EXTERNAL_FENCE_WORM_UNVERIFIED','KEY_LIFECYCLE_ADAPTER_UNIMPLEMENTED','RETENTION_SCOPE_EFFECTIVE_DATE_UNAPPROVED','PRODUCTION_ISSUER_HARDGUARD']};
}
function run(argv,env){
 // No raw paths, supplied values, exception messages or tokens in diagnostics.
 if(argv.length!==3||!['--prepare','--deployment'].includes(argv[0])){console.error('USAGE: --prepare|--deployment MANIFEST_JSON SITE_CONFIG_JSON');return 2;}
 let m,site;try{m=JSON.parse(fs.readFileSync(argv[1],'utf8'));site=JSON.parse(fs.readFileSync(argv[2],'utf8'));}catch{console.error('INPUT_UNREADABLE');return 2;}
 const result=inspect(m,env,site);
 try{require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname,'restore-issuer-index.cjs'),'utf8'),Object.create(null),{timeout:100});result.errors.push('ISSUER_GUARD_NOT_BLOCKING');}catch(e){if(e.message!=='INDEPENDENT_RESTORE_VERIFIER_REQUIRED')result.errors.push('ISSUER_GUARD_UNEXPECTED');}
 result.staticValid=result.errors.length===0;
 console.log(JSON.stringify(result));
 return result.staticValid&&argv[0]==='--prepare'?0:1;
}
if(require.main===module)process.exitCode=run(process.argv.slice(2),process.env);
module.exports={inspect,run};
