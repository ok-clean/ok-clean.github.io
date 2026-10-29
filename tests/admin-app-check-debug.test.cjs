'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('administrator view refuses an enabled App Check debug provider',async()=>{
 const src=fs.readFileSync(path.join(__dirname,'../admin/admin.js'),'utf8');
 const start=src.indexOf('async function startProductionReservationView('),end=src.indexOf('\nconst option=',start);assert.ok(start>=0&&end>start);
 let cleared=0,claims=0;const ctx={FIREBASE_APPCHECK_DEBUG_TOKEN:true,validAuth:()=>true,clearReservations:()=>{cleared++},settings:{reservation:{appCheckSiteKey:'fake'}},productionAppCheck:null};
 vm.runInNewContext(src.slice(start,end)+';this.start=startProductionReservationView;',ctx);
 await ctx.start(1,{getIdTokenResult:async()=>{claims++;return {claims:{admin:true}};}},{});
 assert.equal(cleared,1);assert.equal(claims,0);
});
