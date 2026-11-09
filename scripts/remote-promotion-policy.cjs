'use strict';
const {createHash}=require('node:crypto');
function promotionReview(serverId,staging,production){
  return createHash('sha256').update(JSON.stringify([serverId,staging.id,staging.production_id,staging.live_commit,staging.repo_url,staging.branch,production.id,production.live_commit,production.repo_url,production.branch,production.git_connection_id])).digest('hex');
}
function promotionProblem(staging,production){
  if(!staging||staging.environment_name!=='staging'||!staging.production_id||staging.production_id!==production?.id||production.environment_name!=='production')return 'Choose a staging application linked to production on this server.';
  if(staging.repo_url.replace(/\.git$/,'')!==production.repo_url.replace(/\.git$/,''))return 'Staging and production must use the same repository.';
  if(!/^[a-f0-9]{40,64}$/.test(staging.live_commit||''))return 'Staging has not been deployed successfully yet. Deploy staging first.';
  if(staging.live_commit===production.live_commit)return 'Production already runs this commit.';
  return null;
}
module.exports={promotionReview,promotionProblem};
