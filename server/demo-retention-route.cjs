'use strict';
// Hard-isolated DEMO emulator route: no production project or scheduler can use it.
const {createRetentionService}=require('./retention.cjs');
const {createScheduledRetentionHandler}=require('./retention-scheduler.cjs');
function createGoogleOidcVerifier(Client){
 const C=Client||require('google-auth-library').OAuth2Client;
 const client=new C();
 return async (token,audience)=>{
  const ticket=await client.verifyIdToken({idToken:token,audience});
  return ticket.getPayload();
 };
}
function attachDemoRetentionRoute({app,db,env=process.env,verifyOidc}){
 if(env.OKCLEAN_DEMO_RETENTION_ENABLED!=='true')return false;
 // Production server preflight refuses emulator variables and demo project IDs.
 // This second guard also rejects forged configuration and wrong DB identity.
 if(env.GCLOUD_PROJECT!=='demo-okclean-integration'||env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099'||db?.projectId!=='demo-okclean-integration')throw Error('DEMO_EMULATOR_REQUIRED');
 const reservationDays=Number(env.OKCLEAN_DEMO_RESERVATION_DAYS),historyDays=Number(env.OKCLEAN_DEMO_HISTORY_DAYS);
 const policy={reservationDays,historyDays};
 const service=createRetentionService({db,projectId:'demo-okclean-integration',firestoreHost:'127.0.0.1:8085',policy,authorize:async()=>true});
 const handler=createScheduledRetentionHandler({db,service,verifyOidc:verifyOidc||createGoogleOidcVerifier(),config:{enabled:true,reviewed:env.OKCLEAN_DEMO_POLICY_REVIEWED==='true',projectId:'demo-okclean-integration',audience:env.OKCLEAN_DEMO_SCHEDULER_AUDIENCE,serviceAccount:env.OKCLEAN_DEMO_SCHEDULER_ACCOUNT,policyVersion:env.OKCLEAN_DEMO_POLICY_VERSION,reservationDays,historyDays}});
 app.post('/_internal/demo/retention/run',handler);
 return true;
}
module.exports={createGoogleOidcVerifier,attachDemoRetentionRoute};
