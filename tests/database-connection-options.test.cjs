'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {connectionOptions}=require('../scripts/database-connection-options.cjs');
const providers=require('../scripts/remote-storage-providers.cjs');

test('connection settings retain public authentication options without TLS bypasses or credentials',()=>{
  assert.deepEqual(connectionOptions({database:'inventory',authSource:'identity',password:'private',rejectUnauthorized:false}),{database:'inventory',authSource:'identity'});
  for(const value of [[],{authSource:'a\nb'},{database:2},{caPem:'-----BEGIN PRIVATE KEY-----\nprivate'}])assert.throws(()=>connectionOptions(value));
});

test('MongoDB uses the saved authentication database and trusted CA with existing credentials',async()=>{
  let observed;
  class MongoClient {
    constructor(url,options){observed={url,options}}
    async connect(){}
    db(){return {command:async()=>({ok:1})}}
    async close(){}
  }
  const result=await providers.execute('',{operation:'test',connection:{provider:'mongodb',host:'::1',port:27017,username:'existing@user',password:'private',database:'inventory',authSource:'identity',tls:true,caPem:'public fixture CA'}},{},async()=>({MongoClient}));
  assert.equal(result.connected,true);assert.equal(new URL(observed.url).searchParams.get('authSource'),'identity');assert.equal(observed.options.tls,true);assert.equal(observed.options.ca,'public fixture CA');assert.equal(observed.options.tlsAllowInvalidCertificates,undefined);
});
