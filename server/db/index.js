'use strict';
/**
 * 数据库访问层适配器。
 *  - pglite : 进程内 PostgreSQL(WASM)，数据落盘到 data/pgdata，零依赖启动
 *  - pg     : 真实 PostgreSQL 连接池
 * 对外统一暴露 query / exec / close，SQL 完全一致。
 */
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const context = require('./context');
const { AsyncLocalStorage } = require('node:async_hooks');

let instance = null;

async function createPglite() {
  const { PGlite } = require('@electric-sql/pglite');
  fs.mkdirSync(cfg.pgliteDir, { recursive: true });
  // PGlite's filesystem adapter expects POSIX separators, including on Windows.
  const dataPath = path.relative(process.cwd(), path.resolve(cfg.pgliteDir)).replace(/\\/g, '/');
  const db = new PGlite(dataPath);
  await db.waitReady;
  const transactions = new AsyncLocalStorage();
  return {
    mode: 'pglite',
    label: `PGlite(PostgreSQL) @ ${cfg.pgliteDir}`,
    async query(sql, params = []) {
      const r = await (transactions.getStore() || db).query(sql, params);
      return { rows: r.rows || [], rowCount: r.affectedRows != null ? r.affectedRows : (r.rows || []).length };
    },
    async exec(sql) { return db.exec(sql); },
    async transaction(fn) {
      return db.transaction((tx) => transactions.run(tx, () => fn({
        async query(sql, params = []) { const r = await tx.query(sql, params); return { rows: r.rows || [], rowCount: r.affectedRows != null ? r.affectedRows : (r.rows || []).length }; }
      })));
    },
    async close() { await db.close(); }
  };
}

async function createPg() {
  const { Pool, types } = require('pg');
  types.setTypeParser(1082, (v) => v);
  types.setTypeParser(1114, (v) => v.replace(' ', 'T'));
  const pool = new Pool(cfg.pg);
  pool.on('error', (e) => console.error('[postgres pool]', e.message));
  const transactions = new AsyncLocalStorage();
  async function transaction(fn) {
    const existing = transactions.getStore();
    if (existing) return fn(existing);
    const client = await pool.connect();
    try {
      await client.query('begin');
      const actor = context.current();
      await client.query("select set_config('crm.user_id',$1,true), set_config('crm.data_scope',$2,true), set_config('crm.dept',$3,true), set_config('crm.role',$4,true)", [String(actor.id), actor.dataScope, actor.dept || '', actor.role]);
      const result = await transactions.run(client, () => fn(client));
      await client.query('commit');
      return result;
    } catch (e) { await client.query('rollback'); throw e; }
    finally { client.release(); }
  }
  // 连通性预检
  try {
    const role = (await pool.query('select rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
    if(role.rolsuper || role.rolbypassrls) throw new Error('Runtime PGUSER must be a non-superuser without BYPASSRLS. Use PGADMIN_USER only for migrations.');
  } catch(e) { await pool.end(); throw e; }
  return {
    mode: 'pg',
    label: `PostgreSQL @ ${cfg.pg.host}:${cfg.pg.port}/${cfg.pg.database}`,
    async query(sql, params = []) {
      const r = await transaction((client) => client.query(sql, params));
      return { rows: r.rows, rowCount: r.rowCount };
    },
    async exec(sql) { await transaction((client) => client.query(sql)); },
    transaction,
    poolStats() { return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: cfg.pg.max }; },
    async close() { await pool.end(); }
  };
}

async function getDb() {
  if (!instance) {
    instance = (cfg.dbMode === 'pg' ? createPg() : createPglite()).catch((e) => { instance = null; throw e; });
  }
  return instance;
}

/** 便捷方法 */
const q = (sql, params) => getDb().then((d) => d.query(sql, params));
const one = (sql, params) => q(sql, params).then((r) => r.rows[0] || null);
const many = (sql, params) => q(sql, params).then((r) => r.rows);

/** 统一数值转换：pg 的 numeric 返回字符串，PGlite 可能返回 number */
function num(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
/** 统一日期为 YYYY-MM-DD */
function dateOnly(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function timestamp(v) {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}/.test(v)) return v.replace('T', ' ').slice(0, 19);
  const d = new Date(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

module.exports = { getDb, q, one, many, num, dateOnly, timestamp, cfg };
