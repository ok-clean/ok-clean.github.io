'use strict';
const express=require('express');
const {initializeApp,applicationDefault}=require('firebase-admin/app');
const {getAuth}=require('firebase-admin/auth');
const {getAppCheck}=require('firebase-admin/app-check');
const {getFirestore}=require('firebase-admin/firestore');
const {createHttpHandler}=require('./handler.cjs');
const {createRateLimit}=require('./rate-limit.cjs');
// Cloud Run runtime identity supplies credentials; no private key is loaded from source.
initializeApp({credential:applicationDefault()});
const db=getFirestore();const app=express();
app.disable('x-powered-by');app.use(express.json({limit:'8kb',strict:true}));
app.use(createHttpHandler({auth:getAuth(),appCheck:getAppCheck(),db,rateLimit:createRateLimit(db),allowedOrigin:process.env.ALLOWED_ORIGIN}));
app.use((err,req,res,next)=>{res.status(400).set('Cache-Control','no-store').json({status:'unavailable'});});
app.listen(Number(process.env.PORT)||8080,'0.0.0.0');
