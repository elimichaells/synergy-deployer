'use strict';
const identifier=value=>{if(typeof value!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value))throw Error('Use letters, numbers and underscores for database and user names');return value;};
const literal=value=>"'"+String(value).replace(/'/g,"''")+"'";
const sqlName=value=>'['+identifier(value)+']';
async function execute(root,input,h,driver){
  const d=input.connection,a=input.administrator;
  if(!['test','provision','rotate'].includes(input.operation))throw Error('Explorer and backup controls require PostgreSQL');
  if(!d||!['mysql','mariadb','sqlserver','mongodb','redis'].includes(d.provider)||typeof d.host!=='string'||/[\s/\\\0]/.test(d.host)||!Number.isInteger(d.port)||d.port<1||d.port>65535||typeof d.password!=='string')throw Error('Invalid database connection');
  if(d.provider!=='redis'){for(const value of [d.database,d.username])if(typeof value!=='string'||!value||value.length>128||/[\0\r\n]/.test(value))throw Error('Invalid database or user name');if(input.operation==='provision'){identifier(d.database);identifier(d.username);}}else if(!/^\d{1,2}$/.test(d.database)||Number(d.database)>15)throw Error('Redis database must be between 0 and 15');
  const provisioning=input.operation==='provision',rotating=input.operation==='rotate';
  if((provisioning||rotating)&&(!a||a.provider!==d.provider||a.host!==d.host||a.port!==d.port))throw Error('Database administrator does not match the selected server');
  const verify=async()=>execute(root,{...input,operation:'test',connection:{...d,...(rotating?{password:input.password}:{})}},h,driver);
  try{
    if(['mysql','mariadb'].includes(d.provider)){
      const mysql=await driver(root,h,'mysql2/promise',input.driverArchive),c=provisioning||rotating?a:d;
      const client=await mysql.createConnection({host:c.host,port:c.port,user:c.username,password:c.password,...(provisioning||rotating?{}:{database:d.database}),ssl:c.tls?{rejectUnauthorized:true,...(c.caPem?{ca:c.caPem}:{})}:undefined,connectTimeout:10000,enableKeepAlive:true,multipleStatements:false});
      try{
        const query=(sql,args)=>client.query({sql,timeout:20000},args);
        if(provisioning){
          if(!['127.0.0.1','localhost','::1'].includes(d.host))throw Error('Create MySQL databases using this server’s loopback address; attach external databases with existing credentials');
          const [rows]=await query('select 1 from information_schema.schemata where schema_name=? union all select 1 from mysql.user where user=?',[d.database,d.username]);if(rows.length)throw Error('The database or account already exists. Nothing was changed.');
          // Numeric loopback entries are required when skip_name_resolve is on.
          // No wildcard or network login is created.
          const hosts=['localhost','127.0.0.1','::1'];
          await query('create user '+hosts.map(()=>'?@? identified by ?').join(', '),hosts.flatMap(host=>[d.username,host,d.password]));await query('create database `'+identifier(d.database)+'`');
          for(const host of hosts)await query('grant all privileges on `'+identifier(d.database)+'`.* to ?@?',[d.username,host]);
        }else if(rotating){
          if(d.username===a.username)throw Error('The administrator password cannot be changed here');
          const [accounts]=await query('select host as account_host from mysql.user where user=?',[d.username]);if(!accounts.length||accounts.length>3||accounts.some(account=>!['localhost','127.0.0.1','::1'].includes(account.account_host)))throw Error('Only a dedicated local application account can be rotated');
          await query('alter user '+accounts.map(()=>'?@? identified by ?').join(', '),accounts.flatMap(account=>[d.username,account.account_host,input.password]));
        }else await query('select 1');
      }finally{await client.end();}
      if(provisioning||rotating)await verify();
    }else if(d.provider==='sqlserver'){
      const sql=await driver(root,h,'mssql',input.driverArchive),c=provisioning||rotating?a:d;
      const config={server:c.host,port:c.port,user:c.username,password:c.password,database:provisioning||rotating?'master':d.database,options:{encrypt:c.tls===true,trustServerCertificate:!c.tls,...(c.tls&&c.caPem?{cryptoCredentialsDetails:{ca:c.caPem}}:{})},connectionTimeout:10000,requestTimeout:20000,pool:{max:1,min:0}};
      const client=await new sql.ConnectionPool(config).connect();
      try{
        if(provisioning){
          const existing=await client.request().input('database',d.database).input('username',d.username).query('select 1 as found from sys.databases where name=@database union all select 1 from sys.server_principals where name=@username');if(existing.recordset.length)throw Error('The database or account already exists. Nothing was changed.');
          await client.request().query(`create login ${sqlName(d.username)} with password=N${literal(d.password)}`);await client.request().query(`create database ${sqlName(d.database)}`);
          const app=await new sql.ConnectionPool({...config,database:d.database}).connect();try{await app.request().query(`create user ${sqlName(d.username)} for login ${sqlName(d.username)}; alter role db_owner add member ${sqlName(d.username)}`);}finally{await app.close();}
        }else if(rotating){
          const check=await client.request().input('username',d.username).query("select IS_SRVROLEMEMBER('sysadmin',@username) as elevated");if(d.username===a.username||check.recordset[0]?.elevated!==0)throw Error('Only a dedicated application account can be rotated');
          await client.request().query(`alter login ${sqlName(d.username)} with password=N${literal(input.password)}`);
        }else await client.request().query('select 1 as ok');
      }finally{await client.close();}if(provisioning||rotating)await verify();
    }else if(d.provider==='mongodb'){
      const {MongoClient}=await driver(root,h,'mongodb',input.driverArchive),c=provisioning||rotating?a:d,host=c.host.includes(':')?'['+c.host+']':c.host;
      const client=new MongoClient(`mongodb://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${host}:${c.port}/?authSource=${encodeURIComponent(c.authSource||(provisioning||rotating?'admin':d.database))}`,{tls:c.tls===true,...(c.tls&&c.caPem?{ca:c.caPem}:{}),connectTimeoutMS:10000,serverSelectionTimeoutMS:10000,socketTimeoutMS:20000});
      try{await client.connect();if(provisioning){const existing=await client.db('admin').admin().listDatabases({nameOnly:true}),users=await client.db(d.database).command({usersInfo:d.username});if(existing.databases.some(db=>db.name===d.database)||users.users?.length)throw Error('The database or account already exists. Nothing was changed.');await client.db(d.database).command({createUser:d.username,pwd:d.password,roles:[{role:'readWrite',db:d.database}]});}
        else if(rotating){if(d.username===a.username)throw Error('The administrator password cannot be changed here');await client.db(d.database).command({updateUser:d.username,pwd:input.password});}
        else await client.db(d.database).command({ping:1});
      }finally{await client.close();}if(provisioning||rotating)await verify();
    }else{
      if(rotating)throw Error('Manage Redis account passwords on the database server');
      const {createClient}=await driver(root,h,'redis',input.driverArchive),host=d.host.includes(':')?'['+d.host+']':d.host,auth=d.username?`${encodeURIComponent(d.username)}:${encodeURIComponent(d.password)}@`:d.password?`:${encodeURIComponent(d.password)}@`:'';
      const client=createClient({url:`${d.tls?'rediss':'redis'}://${auth}${host}:${d.port}/${d.database}`,socket:{connectTimeout:10000,reconnectStrategy:false,...(d.tls?{tls:true,rejectUnauthorized:true,...(d.caPem?{ca:d.caPem}:{})}:{})}});client.on('error',()=>{});
      let timer;try{await Promise.race([(async()=>{await client.connect();await client.ping();})(),new Promise((_,reject)=>{timer=setTimeout(()=>{if(client.isOpen)client.destroy();reject(Error('Database connection timed out'));},15000);})]);}finally{clearTimeout(timer);if(client.isOpen)client.destroy();}
    }
    return{ok:true,connected:true,database:d.database,...(provisioning?{username:d.username}:{}),...(rotating?{rotated:true}:{})};
  }catch(error){
    const safe=/^(?:The database|The administrator|Only a dedicated|Create MySQL|Database connection timed out)/.test(error.message);
    throw Error(safe?error.message:`Database operation failed${error.code?' ('+String(error.code).replace(/[^A-Z0-9_]/gi,'').slice(0,30)+')':''}. Check the saved connection and permissions.`,{cause:error});
  }
}
module.exports={execute};
