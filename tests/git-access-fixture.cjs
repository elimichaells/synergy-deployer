const load = require('./server-module.cjs');
module.exports = function(getToken=async()=> 'fixture-token', host={provider:'github',base_url:'https://github.com',account_login:'x-access-token'}) {
 return load('lib/git-access.ts',{'./github-connections':{getGitConnection:async()=>host,getGitHubConnectionToken:getToken},'./git-provider-policy':require('../lib/git-provider-policy.ts'),'./paths':require('../lib/paths.ts')});
};
