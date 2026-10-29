'use strict';
// Wrapper around Admin SDK verification; a project can contain multiple apps.
// This matches the intended web app, but cannot identify registered debug-token
// exchanges; audit/revoke debug tokens in the Firebase console before production.
function restrictedAppCheck(appCheck, expectedAppId){
  if(typeof appCheck?.verifyToken!=='function' || typeof expectedAppId!=='string' || !/^1:[0-9]+:web:[a-fA-F0-9]+$/.test(expectedAppId))throw new Error('App Check application configuration required');
  return {async verifyToken(token){
    if(typeof token!=='string' || !token)throw new Error('App Check unavailable');
    const verified=await appCheck.verifyToken(token);
    if(!verified || verified.appId!==expectedAppId)throw new Error('App Check unavailable');
    return verified;
  }};
}
module.exports={restrictedAppCheck};
