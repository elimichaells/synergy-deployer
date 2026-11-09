export const REMOTE_SERVICES=[
  {id:'postgresql',name:'PostgreSQL',tool:'psql',port:5432,engine:true},
  {id:'mysql',name:'MySQL',tool:'mysql',port:3306,engine:true},
  {id:'mariadb',name:'MariaDB',tool:'mariadb',port:3306,engine:true},
  {id:'node',name:'Node.js',tool:'node'}, {id:'git',name:'Git',tool:'git'},
  {id:'caddy',name:'Caddy',tool:'caddy'}, {id:'pm2',name:'PM2',tool:'pm2'},
  {id:'go',name:'Go',tool:'go'}, {id:'php',name:'PHP',tool:'php'},
  {id:'python',name:'Python',tool:'python'}, {id:'composer',name:'Composer',tool:'composer'},
  {id:'angular',name:'Angular CLI',tool:'ng'},
  {id:'sling',name:'Sling migration engine',tool:'sling'},
] as const
export type RemoteServiceId=typeof REMOTE_SERVICES[number]['id']
export type RemoteServicePlan={service:RemoteServiceId;mode:'reuse'|'install'|'install-version';version:string;path:string;port:number;agentRoot:string;dataRoot:string}
