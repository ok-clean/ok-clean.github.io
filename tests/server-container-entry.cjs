'use strict';
// Test-only harness for the production HTTP adapter; never included in the production image.
const express=require('express');
const {initializeApp}=require('firebase-admin/app');
const {getAuth}=require('firebase-admin/auth');
const {getFirestore}=require('firebase-admin/firestore');
const {createHttpHandler}=require('../server/handler.cjs');
const {createRateLimit}=require('../server/rate-limit.cjs');
const project='demo-okclean-integration';
if(process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099'||process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.GCLOUD_PROJECT!==project)throw Error('Loopback demo emulators required');
const app=initializeApp({projectId:project}),db=getFirestore(app),auth=getAuth(app);
const handler=createHttpHandler({auth,db,appCheck:{verifyToken:async value=>{if(value!=='test-app-check')throw Error('invalid test App Check');}},rateLimit:createRateLimit(db),services:require('../server/services.json'),consentVersion:'test-v1',protectedMemberAdminUid:'synthetic-protected-admin',withdrawalPolicyReviewed:true,memberLinkEnabled:true,memberLinkPolicyVersion:'test-member-v1',allowedOrigin:'https://ok-clean.github.io'});
const server=express();server.disable('x-powered-by');server.use(express.json({limit:'8kb',strict:true}));server.use(handler);server.listen(8799,'127.0.0.1');
