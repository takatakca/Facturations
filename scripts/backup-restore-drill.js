'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');

const SOURCE_DB = 'facturations_test';
const RESTORE_DB = 'facturations_restore_test';
const DOCKER_IMAGE = 'postgres:16';

function validateTestDatabaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('FACTURATIONS_TEST_DATABASE_URL is required');
  }
  let url;
  try { url = new URL(raw); }
  catch { throw new Error('Invalid FACTURATIONS_TEST_DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/' + SOURCE_DB) {
    throw new Error('Refusing backup/restore drill outside localhost/facturations_test');
  }
  const port = url.port || '5432';
  if (port !== '5432') {
    throw new Error('Backup/restore drill requires isolated PostgreSQL on port 5432');
  }
  if (!url.username || !url.password) {
    throw new Error('Backup/restore drill requires disposable database credentials');
  }
  return Object.freeze({
    raw: url.toString(),
    host: '127.0.0.1',
    port,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  });
}

function restoredDatabaseUrl(sourceRaw) {
  const url = new URL(sourceRaw);
  url.pathname = '/' + RESTORE_DB;
  return url.toString();
}

function adminDatabaseUrl(sourceRaw) {
  const url = new URL(sourceRaw);
  url.pathname = '/postgres';
  return url.toString();
}

function quoteIdent(value) {
  return '"' + String(value).replaceAll('"', '""') + '"';
}

async function captureDatabaseProof(pool) {
  const [
    columns,
    constraints,
    indexes,
    triggers,
    views,
    functions,
    sequences,
    tables,
  ] = await Promise.all([
    pool.query(`
      SELECT table_name,column_name,ordinal_position,data_type,udt_name,is_nullable,column_default
        FROM information_schema.columns
       WHERE table_schema='public'
       ORDER BY table_name,ordinal_position
    `),
    pool.query(`
      SELECT c.conrelid::regclass::text AS table_name,c.conname,c.contype,
             pg_get_constraintdef(c.oid,true) AS definition
        FROM pg_constraint AS c
        JOIN pg_namespace AS n ON n.oid=c.connamespace
       WHERE n.nspname='public'
       ORDER BY table_name,c.conname
    `),
    pool.query(`
      SELECT tablename,indexname,indexdef
        FROM pg_indexes
       WHERE schemaname='public'
       ORDER BY tablename,indexname
    `),
    pool.query(`
      SELECT event_object_table,trigger_name,event_manipulation,action_timing,action_statement
        FROM information_schema.triggers
       WHERE trigger_schema='public'
       ORDER BY event_object_table,trigger_name,event_manipulation
    `),
    pool.query(`
      SELECT table_name,view_definition
        FROM information_schema.views
       WHERE table_schema='public'
       ORDER BY table_name
    `),
    pool.query(`
      SELECT p.proname,
             pg_get_function_identity_arguments(p.oid) AS arguments,
             pg_get_functiondef(p.oid) AS definition
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid=p.pronamespace
       WHERE n.nspname='public'
       ORDER BY p.proname,arguments
    `),
    pool.query(`
      SELECT sequencename,start_value,min_value,max_value,increment_by,cycle,cache_size,last_value
        FROM pg_sequences
       WHERE schemaname='public'
       ORDER BY sequencename
    `),
    pool.query(`
      SELECT tablename
        FROM pg_tables
       WHERE schemaname='public'
       ORDER BY tablename
    `),
  ]);

  const rowCounts = [];
  let totalRows = 0;
  for (const { tablename } of tables.rows) {
    const result = await pool.query(
      'SELECT count(*)::bigint::text AS count FROM ' + quoteIdent(tablename)
    );
    const count = result.rows[0].count;
    rowCounts.push({ table: tablename, count });
    totalRows += Number(count);
  }

  return Object.freeze({
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    triggers: triggers.rows,
    views: views.rows,
    functions: functions.rows,
    sequences: sequences.rows,
    rowCounts,
    totals: Object.freeze({
      tables: tables.rows.length,
      rows: totalRows,
    }),
  });
}

function runDockerPostgresTool({ tool, args, password, backupDir }) {
  const result = spawnSync('docker', [
    'run', '--rm', '--network', 'host',
    '--env', 'PGPASSWORD',
    '-v', backupDir + ':/backup',
    DOCKER_IMAGE,
    tool,
    ...args,
  ], {
    env: { ...process.env, PGPASSWORD: password },
    stdio: 'ignore',
    timeout: 120000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(tool + ' failed during isolated backup/restore drill');
  }
}

async function main() {
  const target = validateTestDatabaseUrl(process.env.FACTURATIONS_TEST_DATABASE_URL);
  if (process.env.FACTURATIONS_DATABASE_URL) {
    throw new Error('Refusing drill while FACTURATIONS_DATABASE_URL is defined');
  }

  const source = new Pool({ connectionString: target.raw, connectionTimeoutMillis: 5000 });
  const admin = new Pool({ connectionString: adminDatabaseUrl(target.raw), connectionTimeoutMillis: 5000 });
  let restored = null;
  const backupDir = fs.mkdtempSync(path.join(process.cwd(), '.facturations-backup-drill-'));
  const dumpPath = path.join(backupDir, 'facturations.dump');
  const markerId = crypto.randomUUID();
  const markerHash = crypto.createHash('sha256')
    .update('facturations-backup-drill\0' + markerId)
    .digest('hex');

  try {
    await source.query(`
      CREATE TABLE IF NOT EXISTS facturations_backup_drill_marker (
        id uuid PRIMARY KEY,
        marker_hash text NOT NULL CHECK (marker_hash ~ '^[a-f0-9]{64}$')
      )
    `);
    await source.query(
      'INSERT INTO facturations_backup_drill_marker(id,marker_hash) VALUES ($1,$2)',
      [markerId, markerHash]
    );

    const before = await captureDatabaseProof(source);
    const beforeHash = crypto.createHash('sha256')
      .update(JSON.stringify(before))
      .digest('hex');

    runDockerPostgresTool({
      tool: 'pg_dump',
      password: target.password,
      backupDir,
      args: [
        '--host=' + target.host,
        '--port=' + target.port,
        '--username=' + target.username,
        '--dbname=' + SOURCE_DB,
        '--format=custom',
        '--no-owner',
        '--no-acl',
        '--file=/backup/facturations.dump',
      ],
    });
    const stat = fs.statSync(dumpPath);
    if (!stat.isFile() || stat.size < 1024) {
      throw new Error('Backup artifact is unexpectedly small');
    }

    await admin.query(`DROP DATABASE IF EXISTS ${RESTORE_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${RESTORE_DB}`);

    runDockerPostgresTool({
      tool: 'pg_restore',
      password: target.password,
      backupDir,
      args: [
        '--host=' + target.host,
        '--port=' + target.port,
        '--username=' + target.username,
        '--dbname=' + RESTORE_DB,
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        '/backup/facturations.dump',
      ],
    });

    restored = new Pool({
      connectionString: restoredDatabaseUrl(target.raw),
      connectionTimeoutMillis: 5000,
      max: 1,
    });
    restored.on('error', () => { /* Isolated drill cleanup must not leak connection details. */ });
    const marker = await restored.query(
      'SELECT marker_hash FROM facturations_backup_drill_marker WHERE id=$1',
      [markerId]
    );
    if (marker.rows.length !== 1 || marker.rows[0].marker_hash !== markerHash) {
      throw new Error('Restored synthetic marker does not match source');
    }

    const after = await captureDatabaseProof(restored);
    const afterHash = crypto.createHash('sha256')
      .update(JSON.stringify(after))
      .digest('hex');

    if (beforeHash !== afterHash || JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('Restored schema/data proof differs from source');
    }

    console.info(
      'PASS: isolated PostgreSQL backup/restore drill restored ' +
      before.totals.tables + ' tables and ' + before.totals.rows +
      ' rows; proof SHA-256 ' + beforeHash
    );
    console.info('Synthetic CI evidence only; this is not proof of production backup coverage.');
  } finally {
    if (restored) await restored.end();
    try { await admin.query(`DROP DATABASE IF EXISTS ${RESTORE_DB}`); } catch {}
    await admin.end();
    await source.end();
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error('FAIL: isolated PostgreSQL backup/restore drill');
    process.exitCode = 1;
  });
}

module.exports = {
  SOURCE_DB,
  RESTORE_DB,
  validateTestDatabaseUrl,
  restoredDatabaseUrl,
  adminDatabaseUrl,
  captureDatabaseProof,
};
