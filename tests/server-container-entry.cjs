'use strict';
// Test-only harness for the production HTTP adapter; never included in the production image.
const express=require('express');
const admin=require('firebase-admin');
const {createHttpHandler}=require('../server/handler.cjs');
const {createRateLimit}=require('../server/rate-limit.cjs');
const project='demo-okclean-integration';
if(process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099'||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.GCLOUD_PROJECT!==project)throw Error('Loopback demo emulators required');
const app=admin.initializeApp({projectId:project}),db=admin.firestore(app),auth=admin.auth(app);
const handler=createHttpHandler({auth,db,appCheck:{verifyToken:async value=>{if(value!=='test-app-check')throw Error('invalid test App Check');}},rateLimit:createRateLimit(db),services:require('../server/services.json'),consentVersion:'test-v1',allowedOrigin:'https://ok-clean.github.io'});
const server=express();server.disable('x-powered-by');server.use(express.json({limit:'8kb',strict:true}));server.use(handler);server.listen(8799,'127.0.0.1');
