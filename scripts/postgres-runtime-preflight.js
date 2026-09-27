'use strict';

const {runPostgresRuntimeSecurityPreflight}=require('../src/postgres-runtime-security');

async function main(){
  const result=await runPostgresRuntimeSecurityPreflight();
  console.info(
    'PASS: PostgreSQL runtime role satisfies least-privilege policy; transport='+
    result.transport
  );
  console.info('No database role name, URL, host or credential is printed by this preflight.');
}

if(require.main===module){
  main().catch(()=>{
    console.error('FAIL: PostgreSQL runtime role does not satisfy least-privilege policy');
    process.exitCode=1;
  });
}

module.exports={main};
