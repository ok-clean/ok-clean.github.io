'use strict';
// Read-only validation only. No network calls, no deploy, never print configuration values.
const fs=require('node:fs');
const placeholders=/미정|미확정|확인\s*필요|설정\s*필요|TODO|TBD|PLACEHOLDER|REPLACE_ME/i;
const projectPattern=/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const appPattern=/^1:[0-9]+:web:[a-fA-F0-9]+$/;
const text=(v)=>typeof v==='string' && v.trim().length>=2 && v.trim().length<=200 && !placeholders.test(v);
function validateRuntime(env){
  const errors=[];const need=(condition,code)=>{if(!condition)errors.push(code);};
  const project=env.OKCLEAN_PROJECT_ID;
  need(env.NODE_ENV==='production','NODE_ENV_MUST_BE_PRODUCTION');
  need(typeof project==='string'&&projectPattern.test(project)&&! /^(demo|test|example)-/i.test(project),'PROJECT_ID_INVALID');
  need(typeof env.GOOGLE_CLOUD_PROJECT==='string'&&env.GOOGLE_CLOUD_PROJECT===project,'CLOUD_PROJECT_MISMATCH');
  if(env.GCLOUD_PROJECT)need(env.GCLOUD_PROJECT===project,'GCLOUD_PROJECT_MISMATCH');
  need(typeof env.CONSENT_VERSION==='string'&&/^[A-Za-z0-9._-]{1,80}$/.test(env.CONSENT_VERSION)&&!/^test[-_.]/i.test(env.CONSENT_VERSION),'CONSENT_VERSION_INVALID');
  need(env.ALLOWED_ORIGIN==='https://ok-clean.github.io','ALLOWED_ORIGIN_INVALID');
  need(typeof env.OKCLEAN_FIREBASE_WEB_APP_ID==='string'&&appPattern.test(env.OKCLEAN_FIREBASE_WEB_APP_ID),'WEB_APP_ID_INVALID');
  for(const name of ['FIREBASE_AUTH_EMULATOR_HOST','FIRESTORE_EMULATOR_HOST','FIREBASE_STORAGE_EMULATOR_HOST','FIREBASE_EMULATOR_HUB','FIREBASE_APP_CHECK_DEBUG_TOKEN','FIREBASE_APPCHECK_DEBUG_TOKEN','APP_CHECK_DEBUG_TOKEN','GOOGLE_APPLICATION_CREDENTIALS']){
    if(env[name])errors.push('FORBIDDEN_ENV_'+name);
  }
  return errors;
}
function validateConfig(c,env){
  const errors=validateRuntime(env);const need=(condition,code)=>{if(!condition)errors.push(code);};
  const f=c?.firebase||{},r=c?.reservation||{},p=r.privacy||{};
  const project=env.OKCLEAN_PROJECT_ID;
  need(env.OKCLEAN_TARGET==='production','TARGET_MUST_BE_PRODUCTION');
  need(f.projectId===project,'WEB_PROJECT_MISMATCH');
  need(typeof f.apiKey==='string'&&f.apiKey.trim().length>0&&!placeholders.test(f.apiKey),'WEB_API_CONFIG_MISSING');
  need(typeof f.appId==='string'&&appPattern.test(f.appId)&&f.appId===env.OKCLEAN_FIREBASE_WEB_APP_ID,'WEB_APP_ID_MISMATCH');
  need(r.enabled===true&&r.emulator!==true&&r.verifiedEmulator!==true,'RESERVATION_CONFIGURATION_NOT_PRODUCTION');
  let apiUrl;try{apiUrl=new URL(r.apiUrl);}catch{}
  need(!!apiUrl&&apiUrl.protocol==='https:'&&!apiUrl.username&&!apiUrl.password&&!apiUrl.port&&apiUrl.pathname==='/'&&!apiUrl.search&&!apiUrl.hash&&apiUrl.hostname.endsWith('.run.app'),'API_URL_INVALID');
  need(typeof r.appCheckSiteKey==='string'&&r.appCheckSiteKey.trim().length>0&&!placeholders.test(r.appCheckSiteKey),'APP_CHECK_CONFIGURATION_MISSING');
  need(p.reviewed===true&&text(p.operator)&&text(p.officer)&&text(p.retention),'PRIVACY_REVIEW_OR_FIELDS_MISSING');
  let policyUrl;try{policyUrl=new URL(p.policyUrl);}catch{}
  need(!!policyUrl&&policyUrl.protocol==='https:'&&!policyUrl.username&&!policyUrl.password,'PRIVACY_POLICY_URL_INVALID');
  need(typeof r.consentVersion==='string'&&/^[A-Za-z0-9._-]{1,80}$/.test(r.consentVersion)&&!/^test[-_.]/i.test(r.consentVersion)&&r.consentVersion===env.CONSENT_VERSION,'CONSENT_VERSION_MISMATCH');
  need(typeof env.OKCLEAN_REGION==='string'&&/^[a-z]+(?:-[a-z]+)*[0-9]$/.test(env.OKCLEAN_REGION),'CLOUD_RUN_REGION_MISSING');
  const account=env.OKCLEAN_SERVICE_ACCOUNT;
  need(typeof account==='string'&&typeof project==='string'&&account.endsWith('@'+project+'.iam.gserviceaccount.com')&&/^[a-z][a-z0-9-]{4,28}[a-z0-9]@/.test(account),'SERVICE_ACCOUNT_INVALID');
  need(Array.isArray(c?.services)&&c.services.length>0,'PRICE_POLICY_MISSING');
  return errors;
}
function run(argv,env){
 if(argv.length!==1){process.stderr.write('Usage: node server/preflight.cjs PATH_TO_SITE_CONFIG\n');return 2;}
 let config;try{config=JSON.parse(fs.readFileSync(argv[0],'utf8'));}catch{process.stderr.write('CONFIG_UNREADABLE\n');return 2;}
 const errors=validateConfig(config,env);if(errors.length){process.stderr.write('PRECHECK_FAILED: '+errors.join(', ')+'\n');return 1;}
 process.stdout.write('PRECHECK_OK: local settings are internally consistent. Firebase, IAM, retention enforcement, costs and deployed service are NOT verified. No deployment was performed.\n');return 0;
}
if(require.main===module)process.exitCode=run(process.argv.slice(2),process.env);
module.exports={validateConfig,validateRuntime,run};
