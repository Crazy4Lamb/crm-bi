'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cfg = require('../config');
async function migrate() {
  if (cfg.dbMode !== 'pg') {
    const db = await require('./index').getDb();
    const existing = await db.query("select to_regclass('public.sys_user') as name");
    if (!existing.rows[0].name) await db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    return;
  }
  const { Pool } = require('pg');
  const pool = new Pool({ ...cfg.pg, connectionString: process.env.MIGRATION_DATABASE_URL || undefined, user: process.env.PGADMIN_USER || cfg.pg.user, password: process.env.PGADMIN_PASSWORD || cfg.pg.password, max: 1, application_name: 'crm-bi-migrations' });
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('crm-bi:migrations'))");
    await client.query('create table if not exists app_migration (version text primary key, checksum text not null, applied_at timestamptz not null default now())');
    const steps = [{ version: '001_schema', file: path.join(__dirname, 'schema.sql') }, ...fs.readdirSync(path.join(__dirname, 'migrations')).filter((f) => f.endsWith('.sql')).sort().map((f) => ({ version: f.replace('.sql', ''), file: path.join(__dirname, 'migrations', f) }))];
    for (const step of steps) {
      const sql = fs.readFileSync(step.file, 'utf8');
      const checksum = crypto.createHash('sha256').update(sql.replace(/\r\n/g,'\n')).digest('hex');
      const legacyChecksum = crypto.createHash('sha256').update(sql).digest('hex');
      const applied = (await client.query('select checksum from app_migration where version=$1', [step.version])).rows[0];
      if (applied) {
        if(applied.checksum!==checksum && applied.checksum===legacyChecksum) await client.query('update app_migration set checksum=$1 where version=$2',[checksum,step.version]);
        else if (applied.checksum !== checksum) throw new Error('Applied migration changed: ' + step.version + '. Add a new migration instead.');
        continue;
      }
      await client.query('begin');
      try {
        if (step.version === '001_schema' && (await client.query("select to_regclass('public.sys_user') as name")).rows[0].name) {
          throw new Error('Unmanaged existing schema detected. Use a new database or perform an explicit reviewed baseline; no tables were dropped.');
        }
        await client.query(sql);
        await client.query('insert into app_migration (version,checksum) values ($1,$2)', [step.version, checksum]);
        await client.query('commit');
        console.log('[migrate] ' + step.version);
      } catch (e) { await client.query('rollback'); throw e; }
    }
    const appUser = cfg.pg.user;
    if (!/^[a-z_][a-z0-9_]*$/.test(appUser)) throw new Error('PGUSER must be a simple PostgreSQL role name');
    await client.query(`grant usage on schema public to "${appUser}"; grant select,insert,update,delete on all tables in schema public to "${appUser}"; grant usage,select on all sequences in schema public to "${appUser}"; grant execute on all functions in schema public to "${appUser}"; revoke all on bi_sales_daily from "${appUser}"; revoke insert,update,delete on crm_audit,bi_refresh_state,app_migration from "${appUser}";`);
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('crm-bi:migrations'))");
    client.release(); await pool.end();
  }
}
if (require.main === module) migrate().catch((e) => { console.error('[migrate]', e.message); process.exitCode = 1; });
module.exports = { migrate };

