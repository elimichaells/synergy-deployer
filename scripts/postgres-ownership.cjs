// Shared PostgreSQL object inventory and ownership statements.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inventory = inventory;
exports.quoteIdent = quoteIdent;
exports.ownershipStatement = ownershipStatement;
async function inventory(client) {
    const { rows } = await client.query(`
    with objects as (
      select 'schema'::text as kind, n.nspname as schema, n.nspname as name, null::text as args, n.nspowner as owner_oid from pg_namespace n
       where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
         and not exists (select 1 from pg_depend d where d.classid='pg_namespace'::regclass and d.objid=n.oid and d.deptype='e')
      union all
      select c.relkind::text, n.nspname, c.relname, null, c.relowner from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','S','f')
         and not exists (select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
         -- Serial and identity sequences follow their table automatically.
         and not (c.relkind='S' and exists (select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype in ('a','i')))
      union all
      select case p.prokind when 'p' then 'procedure' when 'a' then 'aggregate' else 'function' end, n.nspname, p.proname,
             pg_get_function_identity_arguments(p.oid), p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
         and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
      union all
      select case t.typtype when 'd' then 'domain' else 'type' end, n.nspname, t.typname, null, t.typowner from pg_type t join pg_namespace n on n.oid=t.typnamespace
       where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and t.typtype in ('e','d','r') and t.typrelid = 0
         and not exists (select 1 from pg_depend d where d.classid='pg_type'::regclass and d.objid=t.oid and d.deptype='e')
    )
    -- pg_database_owner (the default owner of "public" since PostgreSQL 15) follows the database owner automatically.
    select o.kind, o.schema, o.name, o.args, r.rolname as owner, r.rolsuper as owner_is_super
      from objects o join pg_roles r on r.oid=o.owner_oid where r.rolname <> 'pg_database_owner'`);
    return rows;
}
function quoteIdent(value) {
    return `"${value.replace(/"/g, '""')}"`;
}
const KEYWORDS = {
    r: 'TABLE', p: 'TABLE', v: 'VIEW', m: 'MATERIALIZED VIEW', S: 'SEQUENCE', f: 'FOREIGN TABLE',
    schema: 'SCHEMA', function: 'FUNCTION', procedure: 'PROCEDURE', aggregate: 'AGGREGATE', type: 'TYPE', domain: 'DOMAIN',
};
/** ALTER ... OWNER TO statement for one object. */
function ownershipStatement(object, owner) {
    const keyword = KEYWORDS[object.kind];
    if (!keyword)
        throw new Error(`Unsupported object kind: ${object.kind}`);
    const target = object.kind === 'schema'
        ? quoteIdent(object.name)
        : `${quoteIdent(object.schema)}.${quoteIdent(object.name)}${['function', 'procedure', 'aggregate'].includes(object.kind) ? `(${object.args || ''})` : ''}`;
    return `ALTER ${keyword} ${target} OWNER TO ${quoteIdent(owner)}`;
}
