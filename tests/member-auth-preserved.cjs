// Test-only extraction. Never imported by production. Public signup remains paused.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const crypto=require('node:crypto');
function reviewedClient(){
 const source=fs.readFileSync('member-sync.js','utf8');
 assert.ok(source.includes("throw new Error('MEMBER_SIGNUP_PAUSED');"),'public pause must remain');
 const marker='/* Retained implementation for a future reviewed reactivation:';
 assert.equal(source.split(marker).length,2,'exactly one preserved implementation');
 const body=source.split(marker)[1].split('*/')[0];
 const imports=(source.match(/^\/\/ import [^\n]+;$/gm)||[]).map(s=>s.slice(3)).join('\n');
 assert.equal(imports.split('\n').length,3);
 const current=imports+'\nexport async function submitMember(config, m){'+body+'}\n';
 const archived=fs.readFileSync('tests/fixtures/auth-homepage/member-sync.js','utf8');
 const archivedBody=archived.slice(archived.indexOf('  const app='),archived.lastIndexOf('}')).trim();
 const core=body.split('  // Only a newly written document')[0].trim();
 const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
 assert.equal(hash(core),hash(archivedBody),'preserved auth/write core must match reviewed PR58 code');
 assert.equal(imports,(archived.match(/^import [^\n]+;$/gm)||[]).join('\n'),'preserved SDK imports must match');
 return current;
}
module.exports={reviewedClient};
