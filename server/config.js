'use strict';
/**
 * 全局配置。默认接入独立 PostgreSQL 服务；.env 提供本地配置，环境变量可覆盖。
 * 显式 DB_MODE=pglite 仅用于便携演示。
 */
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const dbMode = (process.env.DB_MODE || 'pg').toLowerCase();
if (!['pg', 'pglite'].includes(dbMode)) throw new Error('DB_MODE must be pg or pglite');
const jwtSecret = process.env.JWT_SECRET || (dbMode === 'pglite' ? 'crm-bi-local-demo-only-secret-2026' : '');
if (jwtSecret.length < 32) throw new Error('Set JWT_SECRET to at least 32 characters, or run npm run setup.');

module.exports = {
  root,
  port: Number(process.env.PORT || 8787),
  jwtSecret,
  jwtExpires: process.env.JWT_EXPIRES || '12h',

  // pglite | pg
  dbMode,
  pgliteDir: process.env.PGLITE_DIR || path.join(root, 'data', 'pgdata'),
  pg: {
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5433),
    user: process.env.PGUSER || 'crm_app',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'crm_bi',
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {}),
    max: Number(process.env.PGPOOL_MAX || 15),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 15000),
    idle_in_transaction_session_timeout: 15000,
    application_name: 'crm-bi',
    options: '-c timezone=' + (process.env.APP_TZ || 'Asia/Shanghai')
  },

  // 业务时区（T+1 计算基准）
  tz: process.env.APP_TZ || 'Asia/Shanghai',
  scheduler: (process.env.SCHEDULER || 'on') !== 'off'
};
