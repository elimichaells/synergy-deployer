'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
test('production-compiled Manager distributes exactly the tested standalone agent source',{skip:process.env.TEST_PRODUCTION_BUILD!=='1'},async()=>{
  const actual=await require('./fixtures/production-agent-bundle.cjs')();
  const expected=await require('../scripts/agent-bundle.cjs').agentBundle();
  assert.equal(actual,expected,'Production compilation changed the distributed agent');
});
