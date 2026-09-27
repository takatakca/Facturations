'use strict';

const { Pool } = require('pg');

const PREDEFINED_DANGEROUS_ROLES = Object.freeze([
  'pg_read_all_data',
  'pg_write_all_data',
  'pg_read_all_settings',
  'pg_read_all_stats',
  'pg_stat_scan_tables',
  'pg_monitor',
  'pg_signal_backend',
  'pg_read_server_files',
  'pg_write_server_files',
  'pg_execute_server_program',
  'pg_checkpoint',
  'pg_maintain',
  'pg_use_reserved_connections',
  'pg_create_subscription',
]);

class PostgresRuntimeSecurityError extends Error {
  constructor(code){
    super(code);
    this.name='PostgresRuntimeSecurityError';
    this.code=code;
  }
}

function databaseTarget(raw){
  if(typeof raw!=='string' || !raw.trim()){
    throw new PostgresRuntimeSecurityError('DATABASE_URL_REQUIRED');
  }
  let url;
  try{url=new URL(raw);}
  catch{throw new PostgresRuntimeSecurityError('DATABASE_URL_INVALID');}
  if(!['postgres:','postgresql:'].includes(url.protocol) ||
     !url.username || !url.pathname || url.pathname==='/' ||
     url.hash || url.searchParams.has('password')){
    throw new PostgresRuntimeSecurityError('DATABASE_URL_INVALID');
  }
  const hostname=url.hostname.toLowerCase();
  const loopback=['localhost','127.0.0.1','::1'].includes(hostname);
  return Object.freeze({
    database:decodeURIComponent(url.pathname.slice(1)),
    loopback,
  });
}

async function inspectRuntimeRole(pool){
  if(!pool || typeof pool.query!=='function'){
    throw new TypeError('PostgreSQL pool required');
  }
  const result=await pool.query(`
    SELECT
      current_database() AS database_name,
      r.rolcanlogin AS can_login,
      r.rolsuper AS is_superuser,
      r.rolcreaterole AS can_create_role,
      r.rolcreatedb AS can_create_database,
      r.rolreplication AS can_replicate,
      r.rolbypassrls AS can_bypass_rls,
      has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
      has_schema_privilege(current_user,'public','CREATE') AS schema_create,
      has_schema_privilege(current_user,'public','USAGE') AS schema_usage,
      COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()),false) AS connection_ssl,
      (
        SELECT count(*)::integer
          FROM pg_class AS c
          JOIN pg_namespace AS n ON n.oid=c.relnamespace
         WHERE n.nspname='public'
           AND c.relkind IN ('r','p','S','v','m')
           AND c.relowner=r.oid
      ) AS owned_relations,
      (
        SELECT count(*)::integer
          FROM pg_proc AS p
          JOIN pg_namespace AS n ON n.oid=p.pronamespace
         WHERE n.nspname='public'
           AND p.proowner=r.oid
      ) AS owned_functions,
      (
        SELECT count(*)::integer
          FROM pg_roles AS inherited
         WHERE inherited.oid<>r.oid
           AND pg_has_role(current_user,inherited.oid,'MEMBER')
           AND (
             inherited.rolsuper OR inherited.rolcreaterole OR inherited.rolcreatedb OR
             inherited.rolreplication OR inherited.rolbypassrls OR
             inherited.rolname=ANY($1::text[]) OR
             has_database_privilege(inherited.rolname,current_database(),'CREATE') OR
             has_schema_privilege(inherited.rolname,'public','CREATE') OR
             EXISTS(
               SELECT 1
                 FROM pg_class AS c2
                 JOIN pg_namespace AS n2 ON n2.oid=c2.relnamespace
                WHERE n2.nspname='public'
                  AND c2.relkind IN ('r','p','S','v','m')
                  AND c2.relowner=inherited.oid
             ) OR
             EXISTS(
               SELECT 1
                 FROM pg_proc AS p2
                 JOIN pg_namespace AS n3 ON n3.oid=p2.pronamespace
                WHERE n3.nspname='public'
                  AND p2.proowner=inherited.oid
             )
           )
      ) AS dangerous_memberships
      FROM pg_roles AS r
     WHERE r.rolname=current_user
  `,[PREDEFINED_DANGEROUS_ROLES]);
  if(result.rows.length!==1){
    throw new PostgresRuntimeSecurityError('RUNTIME_ROLE_NOT_FOUND');
  }
  return result.rows[0];
}

function evaluateRuntimeRole(row,target){
  if(!row || typeof row!=='object' || !target || typeof target!=='object'){
    throw new TypeError('Runtime role inspection and target required');
  }
  const failures=[];
  if(row.database_name!==target.database) failures.push('DATABASE_NAME_MISMATCH');
  if(row.can_login!==true) failures.push('ROLE_LOGIN_REQUIRED');
  if(row.is_superuser===true) failures.push('ROLE_SUPERUSER_FORBIDDEN');
  if(row.can_create_role===true) failures.push('ROLE_CREATE_ROLE_FORBIDDEN');
  if(row.can_create_database===true) failures.push('ROLE_CREATE_DATABASE_FORBIDDEN');
  if(row.can_replicate===true) failures.push('ROLE_REPLICATION_FORBIDDEN');
  if(row.can_bypass_rls===true) failures.push('ROLE_BYPASS_RLS_FORBIDDEN');
  if(row.database_create===true) failures.push('DATABASE_CREATE_FORBIDDEN');
  if(row.schema_create===true) failures.push('SCHEMA_CREATE_FORBIDDEN');
  if(row.schema_usage!==true) failures.push('SCHEMA_USAGE_REQUIRED');
  if(Number(row.owned_relations)!==0 || Number(row.owned_functions)!==0){
    failures.push('RUNTIME_OBJECT_OWNERSHIP_FORBIDDEN');
  }
  if(Number(row.dangerous_memberships)!==0){
    failures.push('DANGEROUS_ROLE_MEMBERSHIP_FORBIDDEN');
  }
  if(!target.loopback && row.connection_ssl!==true){
    failures.push('REMOTE_DATABASE_TLS_REQUIRED');
  }
  return Object.freeze({
    ok:failures.length===0,
    failures:Object.freeze(failures),
    transport:target.loopback?'LOOPBACK':(row.connection_ssl===true?'TLS':'INSECURE_REMOTE'),
  });
}

async function runPostgresRuntimeSecurityPreflight({
  databaseUrl=process.env.FACTURATIONS_DATABASE_URL,
  poolFactory=options=>new Pool(options),
}={}){
  const target=databaseTarget(databaseUrl);
  const pool=poolFactory({
    connectionString:databaseUrl,
    max:1,
    connectionTimeoutMillis:5000,
    idleTimeoutMillis:5000,
  });
  if(!pool || typeof pool.query!=='function' || typeof pool.end!=='function'){
    throw new TypeError('PostgreSQL pool factory returned invalid pool');
  }
  pool.on?.('error',()=>{ /* Never log connection details. */ });
  try{
    const row=await inspectRuntimeRole(pool);
    const evaluation=evaluateRuntimeRole(row,target);
    if(!evaluation.ok){
      throw new PostgresRuntimeSecurityError('RUNTIME_DATABASE_PRIVILEGES_UNSAFE');
    }
    return evaluation;
  }finally{
    await pool.end();
  }
}

module.exports={
  PREDEFINED_DANGEROUS_ROLES,
  PostgresRuntimeSecurityError,
  databaseTarget,
  inspectRuntimeRole,
  evaluateRuntimeRole,
  runPostgresRuntimeSecurityPreflight,
};
