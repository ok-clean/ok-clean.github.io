'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../admin/admin.js'),'utf8');
const start=source.indexOf('function reservationApiUrl('),end=source.indexOf('\nconst productionReservation=',start);assert.ok(start>=0&&end>start);
const reservationApiUrl=vm.runInNewContext('('+source.slice(start,end)+')',{URL});
test('administrator API remains off unless valid HTTPS Cloud Run configuration is explicitly enabled',()=>{
 const config={reservation:{enabled:true,apiUrl:'https://test-service.run.app/',appCheckSiteKey:'sitekey'}};
 assert.equal(reservationApiUrl(config),'https://test-service.run.app');
 for(const overrides of [{enabled:false},{apiUrl:'http://test-service.run.app/'},{apiUrl:'https://test-service.run.app.evil.invalid/'},{apiUrl:'https://user@test-service.run.app/'},{apiUrl:'https://test-service.run.app/admin/'},{appCheckSiteKey:''}])assert.equal(reservationApiUrl({reservation:{...config.reservation,...overrides}}),null);
});
