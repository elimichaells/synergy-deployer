'use strict';
const q=require('./postgres-ownership.cjs').quoteIdent;
const user="n.nspname !~ '^pg_' and n.nspname <> 'information_schema'";
const notExtension=(catalog,column)=>`not exists(select 1 from pg_depend d where d.classid='${catalog}'::regclass and d.objid=${column} and d.deptype='e')`;
async function tables(client){return(await client.query(`select n.nspname as schema,c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${user} and c.relkind='r' and ${notExtension('pg_class','c.oid')} order by 1,2`)).rows;}
async function facts(client){
  const rows={};
  for(const table of await tables(client)){
    // Counts stay strings for bigint safety. Two independent 64-bit sums also
    // detect changed values when row counts happen to match, without retaining
    // application rows or building an unbounded in-memory result.
    rows[JSON.stringify([table.schema,table.name])]=(await client.query(`select count(*)::text as count,coalesce(sum(('x'||substr(h,1,16))::bit(64)::bigint::numeric),0)::text as a,coalesce(sum(('x'||substr(h,17,16))::bit(64)::bigint::numeric),0)::text as b from(select md5(to_jsonb(t)::text) as h from only ${q(table.schema)}.${q(table.name)} t) records`)).rows[0];
  }
  const sequences={};
  for(const s of(await client.query("select schemaname as schema,sequencename as name from pg_sequences where schemaname !~ '^pg_' and schemaname <> 'information_schema' order by 1,2")).rows)sequences[JSON.stringify([s.schema,s.name])]=(await client.query(`select last_value::text,is_called from ${q(s.schema)}.${q(s.name)}`)).rows[0];
  const objects=(await client.query(`select c.relkind::text as kind,n.nspname as schema,c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace where ${user} and c.relkind in ('r','p','v','m','i','S','f') and ${notExtension('pg_class','c.oid')} union all select 'function',n.nspname,p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where ${user} and ${notExtension('pg_proc','p.oid')} order by 1,2,3`)).rows;
  return{rows,sequences,objects};
}
const matches=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const filterRestoreList=list=>list.split(/\r?\n/).filter(line=>!/^\s*\d+;\s*\d+\s+\d+\s+(EXTENSION -|COMMENT - EXTENSION)\s/.test(line)).join('\n');
module.exports={tables,facts,matches,filterRestoreList};
