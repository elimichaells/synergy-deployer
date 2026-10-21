// Invoked in a fresh process during install and after reboot. Never prints credentials.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function credential(stateRoot) {
  const dataRoot=path.dirname(path.dirname(stateRoot));
  const engine=path.basename(stateRoot);
  if (!['mysql','mariadb','mongodb','sqlserver'].includes(engine)) throw Error('Unsupported service credential');
  return JSON.parse(execFileSync(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),[
    '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'offline-service.ps1'),
    '-Engine',engine,'-Action','Credential','-DataRoot',dataRoot,
  ],{encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','pipe','pipe']}));
}
async function check(mode, stateRoot, supplied) {
  if (!['initialize','verify'].includes(mode)) throw Error('Unsupported check');
  const receipt=read(path.join(stateRoot,'service.json'));
  const secret=supplied || credential(stateRoot);
  if (!/^[a-f0-9]{32}$/.test(receipt.verificationToken)) throw Error('Invalid persistence receipt');
  const initialize=mode==='initialize';
  const token=receipt.verificationToken;
  if (['mysql','mariadb'].includes(receipt.engine)) {
    const client=await require('mysql2/promise').createConnection({host:'127.0.0.1',port:receipt.port,user:secret.username,password:secret.password,connectTimeout:10000});
    try {
      if (initialize) {
        await client.query('CREATE DATABASE IF NOT EXISTS manager_install_check');
        await client.query('CREATE TABLE IF NOT EXISTS manager_install_check.persistence (id INT PRIMARY KEY, token VARCHAR(32) NOT NULL)');
        await client.execute('INSERT IGNORE INTO manager_install_check.persistence (id,token) VALUES (1,?)',[token]);
      }
      const [rows]=await client.query('SELECT token FROM manager_install_check.persistence WHERE id=1');
      if(rows[0]?.token!==token) throw Error('Database persistence marker does not match this installation');
    } finally {await client.end();}
  } else if (receipt.engine==='mongodb') {
    const {MongoClient}=require('mongodb');
    const options={serverSelectionTimeoutMS:10000,connectTimeoutMS:10000};
    const url=`mongodb://127.0.0.1:${receipt.port}/?authSource=admin`;
    let client=new MongoClient(url,{...options,auth:{username:secret.username,password:secret.password}});
    try {await client.connect();await client.db('admin').command({connectionStatus:1});}
    catch(error){
      await client.close();
      // MongoDB's localhost exception only permits creating the first account.
      if(!initialize || !['initialized'].includes(receipt.phase)) throw error;
      const bootstrap=new MongoClient(url,options);
      try{await bootstrap.connect();await bootstrap.db('admin').command({createUser:secret.username,pwd:secret.password,roles:[{role:'root',db:'admin'}]});}
      finally{await bootstrap.close();}
      client=new MongoClient(url,{...options,auth:{username:secret.username,password:secret.password}});await client.connect();
    }
    try{
      const markers=client.db('manager_install_check').collection('persistence');
      if(initialize)await markers.updateOne({_id:'installation'},{$setOnInsert:{token}},{upsert:true});
      const row=await markers.findOne({_id:'installation'});
      if(row?.token!==token)throw Error('Database persistence marker does not match this installation');
    }finally{await client.close();}
  } else if(receipt.engine==='sqlserver') {
    const sql=require('mssql');
    const pool=await new sql.ConnectionPool({server:'127.0.0.1',port:receipt.port,user:secret.username,password:secret.password,database:'master',connectionTimeout:15000,options:{encrypt:true,trustServerCertificate:true}}).connect();
    try{
      const version=await pool.request().query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS varchar(32)) AS version");
      if(!receipt.sqlVersion || version.recordset[0]?.version!==receipt.sqlVersion)throw Error('SQL Server did not apply its bundled security update');
      if(initialize){
        await pool.request().query("IF DB_ID('manager_install_check') IS NULL CREATE DATABASE manager_install_check");
        await pool.request().query("IF OBJECT_ID('manager_install_check.dbo.persistence') IS NULL CREATE TABLE manager_install_check.dbo.persistence (id INT PRIMARY KEY, token VARCHAR(32) NOT NULL)");
        await pool.request().input('token',sql.VarChar(32),token).query('IF NOT EXISTS (SELECT 1 FROM manager_install_check.dbo.persistence WHERE id=1) INSERT INTO manager_install_check.dbo.persistence (id,token) VALUES (1,@token)');
      }
      const result=await pool.request().query('SELECT token FROM manager_install_check.dbo.persistence WHERE id=1');
      if(result.recordset[0]?.token!==token)throw Error('Database persistence marker does not match this installation');
    }finally{await pool.close();}
  } else throw Error('Unsupported database check');
  return {engine:receipt.engine,port:receipt.port,authenticated:true,persistenceVerified:true};
}
module.exports={check,credential};
if(require.main===module)check(process.argv[2],process.argv[3]).then(result=>console.log('[verify] '+JSON.stringify(result))).catch(error=>{console.error('[verify] '+error.message);process.exitCode=1;});
