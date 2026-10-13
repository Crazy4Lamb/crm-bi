'use strict';
/** 服务入口：静态前端 + REST API */
const path = require('path');
const express = require('express');
const cfg = require('./config');
const { getDb, one } = require('./db');
const { auth, asyncGuard } = require('./middleware/auth');
const scheduler = require('./services/scheduler');

const authRoutes = require('./routes/auth');
const sysRoutes = require('./routes/sys');
const crmRoutes = require('./routes/crm');
const dashboardRoutes = require('./routes/dashboard');
const reportRoutes = require('./routes/report');
const chartRoutes = require('./routes/chart');
const metricRoutes = require('./routes/metric');
const taskRoutes = require('./routes/task');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use('/api/auth', asyncGuard(authRoutes.router));
  app.use('/api/sys', auth, asyncGuard(sysRoutes.router));
  app.use('/api/crm', auth, asyncGuard(crmRoutes.router));
  app.use('/api/dashboard', auth, asyncGuard(dashboardRoutes.router));
  app.use('/api/report', auth, asyncGuard(reportRoutes.router));
  app.use('/api/chart', auth, asyncGuard(chartRoutes.router));
  app.use('/api/metric', auth, asyncGuard(metricRoutes.router));
  app.use('/api/task', auth, asyncGuard(taskRoutes.router));

  app.get('/api/health', async (req, res) => {
    try {
      const db = await getDb();
      const c = await one('select count(*)::int as c from sys_user');
      res.json({ code: 0, data: { status: 'up', db: db.label, mode: db.mode, timezone: cfg.tz, users: c.c, time: new Date().toISOString() } });
    } catch (e) {
      res.status(500).json({ code: 500, message: '数据库未初始化：' + e.message });
    }
  });

  app.use(express.static(path.join(cfg.root, 'web')));
  app.get('/', (req, res) => res.sendFile(path.join(cfg.root, 'web', 'login.html')));

  app.use('/api', (req, res) => res.status(404).json({ code: 404, message: '接口不存在：' + req.path }));
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    const status = ['23514','23503','23505','22023','22007','22008'].includes(err.code) ? 400 : err.code === '42501' ? 403 : err.code === 'P0002' ? 404 : 500;
    res.status(status).json({ code: status, message: String(err.message || err) });
  });
  return app;
}

async function start() {
  const app = createApp();
  try {
    const db = await getDb();
    console.log(`[crm-bi] 数据库就绪：${db.label}`);
    const { scheduled } = await scheduler.reload();
    console.log(`[crm-bi] 任务调度：${scheduled} 个定时任务已注册（时区 ${cfg.tz}）`);
  } catch (e) {
    console.error('[crm-bi] 数据库初始化失败，请先执行 npm run initdb');
    console.error('  ', e.message);
    throw e;
  }
  return new Promise((resolve) => {
    const server = app.listen(cfg.port, () => {
      console.log(`[crm-bi] 服务已启动： http://127.0.0.1:${cfg.port}/  (登录页 /login.html)`);
      resolve(server);
    });
    const shutdown = async () => {
      server.close();
      await (await getDb()).close();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

if (require.main === module) {
  start().catch(() => { process.exitCode = 1; });
}

module.exports = { createApp, start };
