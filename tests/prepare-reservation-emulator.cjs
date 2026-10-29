// Produce an isolated policy from the two reviewed test fixtures. Never deploy it.
const fs=require('node:fs');
const head="rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n";
const tail='  }\n}\n';
function body(path){
  const source=fs.readFileSync(path,'utf8').replace(/^\/\/ TEST ONLY:[^\n]*\n/,'');
  if(!source.startsWith(head)||!source.endsWith(tail))throw new Error('Unexpected test rules wrapper');
  return source.slice(head.length,-tail.length);
}
const rules=head+body('firestore.rules')+body('prototype/security/firestore.rules')+tail;
fs.writeFileSync('tests/fixtures/.reservation-e2e.rules',rules);
fs.writeFileSync('tests/fixtures/.reservation-e2e.json',JSON.stringify({
  firestore:{rules:'.reservation-e2e.rules'},
  emulators:{auth:{host:'127.0.0.1',port:9099},firestore:{host:'127.0.0.1',port:8085},ui:{enabled:false},singleProjectMode:true}
}));
