'use strict';
/** 系统管理：用户 / 角色 / 权限矩阵 / 运行信息 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { q, one, many } = require('../db');
const { getDb } = require('../db');
const acl = require('../services/acl');

const router = express.Router();
const guard = (req, res) => {
  if (req.user.role !== 'admin') { res.status(403).json({ code: 403, message: '无权限：仅系统管理员可访问' }); return false; }
  return true;
};

router.get('/roles', async (req, res) => {
  if (!guard(req, res)) return;
  const roles = await many('select * from sys_role order by sort_no');
  const counts = await many(`select role_code, count(*)::int as c from sys_user group by role_code`);
  const map = new Map(counts.map((c) => [c.role_code, c.c]));
  res.json({ code: 0, data: roles.map((r) => ({ ...r, userCount: map.get(r.code) || 0 })) });
});

router.get('/users', async (req, res) => {
  if (!guard(req, res)) return;
  const rows = await many(`select u.id, u.username, u.real_name, u.role_code, r.name as role_name, u.dept, u.phone, u.email,
      u.data_scope, u.status, u.last_login_at, u.created_at
    from sys_user u left join sys_role r on r.code = u.role_code order by u.id`);
  res.json({ code: 0, data: rows });
});

router.post('/users', async (req, res) => {
  if (!guard(req, res)) return;
  const b = req.body || {};
  if (!b.username || !b.real_name || !b.role_code) return res.status(400).json({ code: 400, message: '用户名/姓名/角色必填' });
  const exists = await one('select id from sys_user where username = $1', [b.username]);
  if (exists) return res.status(400).json({ code: 400, message: '用户名已存在' });
  const row = await one(`insert into sys_user (username, password, real_name, role_code, dept, phone, email, data_scope, status)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [b.username, bcrypt.hashSync(b.password || '123456', 8), b.real_name, b.role_code, b.dept || null, b.phone || null, b.email || null, b.data_scope || 'self', b.status || '1']);
  res.json({ code: 0, data: { id: row.id }, message: '用户已创建，初始密码 ' + (b.password || '123456') });
});

router.put('/users/:id', async (req, res) => {
  if (!guard(req, res)) return;
  const b = req.body || {};
  const id = Number(req.params.id);
  await q(`update sys_user set real_name = coalesce($1, real_name), role_code = coalesce($2, role_code), dept = coalesce($3, dept),
      phone = coalesce($4, phone), email = coalesce($5, email), data_scope = coalesce($6, data_scope), status = coalesce($7, status) where id = $8`,
    [b.real_name || null, b.role_code || null, b.dept || null, b.phone || null, b.email || null, b.data_scope || null, b.status || null, id]);
  if (b.password) await q('update sys_user set password = $1 where id = $2', [bcrypt.hashSync(b.password, 8), id]);
  acl.clear();
  res.json({ code: 0, message: '已保存' });
});

router.delete('/users/:id', async (req, res) => {
  if (!guard(req, res)) return;
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ code: 400, message: '不能删除当前登录账号' });
  await q('delete from sys_user where id = $1', [id]);
  res.json({ code: 0, message: '已删除' });
});

// 权限矩阵：菜单 + 卡片 + 统计图 + 报表
const ACTION_LABEL = {
  'customer:add': '客户 · 新增', 'customer:edit': '客户 · 编辑', 'customer:delete': '客户 · 删除',
  'customer-pool:claim': '公海 · 领取', 'customer-pool:release': '公海 · 退回',
  'lead:add': '线索 · 新增', 'lead:claim': '线索 · 领取', 'lead:assign': '线索 · 分配', 'lead:edit': '线索 · 编辑',
  'opp:add': '商机 · 新增', 'opp:edit': '商机 · 编辑', 'opp:advance': '商机 · 推进阶段',
  'payment:add': '回款 · 登记',
  'contract:add': '合同 · 新增', 'contract:edit': '合同 · 编辑',
  'order:add': '订单 · 新增', 'order:edit': '订单 · 编辑',
  'follow:add': '跟进 · 新增',
  'report:design': '报表 · 设计', 'widget:design': '统计图 · 设计', 'metric:design': '指标 · 设计',
  'task:run': '任务 · 执行', 'task:edit': '任务 · 编辑', 'user:edit': '用户 · 编辑'
};

router.get('/acl', async (req, res) => {
  if (!guard(req, res)) return;
  const roles = await many('select code, name from sys_role order by sort_no');
  const menus = await many('select code, name, parent_code from sys_menu order by sort_no');
  const cards = await many("select code, name from bi_widget where widget_type = 'card' order by code");
  const charts = await many("select code, name from bi_widget where widget_type = 'chart' order by code");
  const reports = await many('select id, code, name from rpt_report order by id');
  const dashboards = await many('select code, name from bi_dashboard order by id');
  const rows = await many('select role_code, res_type, res_key from sys_acl');
  const matrix = {};
  roles.forEach((r) => { matrix[r.code] = {}; });
  rows.forEach((r) => {
    if (!matrix[r.role_code]) matrix[r.role_code] = {};
    const t = r.res_type;
    if (!matrix[r.role_code][t]) matrix[r.role_code][t] = [];
    matrix[r.role_code][t].push(r.res_key);
  });
  // 功能操作：既定字典 ∪ 库中已存在的自定义 key
  const usedActions = [...new Set(rows.filter((r) => r.res_type === 'action').map((r) => r.res_key))];
  const actionCodes = [...new Set([...Object.keys(ACTION_LABEL), ...usedActions])];
  res.json({
    code: 0,
    data: {
      roles,
      resources: {
        menu: menus,
        action: actionCodes.map((c) => ({ code: c, name: ACTION_LABEL[c] || c })),
        card: cards,
        chart: charts,
        report: reports.map((r) => ({ code: String(r.id), name: r.name })),
        dashboard: dashboards
      },
      matrix
    }
  });
});

router.post('/acl', async (req, res) => {
  if (!guard(req, res)) return;
  const { roleCode, resType, resKey, enabled } = req.body || {};
  if (!roleCode || !resType || !resKey) return res.status(400).json({ code: 400, message: '参数不完整' });
  if (enabled) await q('insert into sys_acl (role_code, res_type, res_key) values ($1,$2,$3) on conflict do nothing', [roleCode, resType, resKey]);
  else await q('delete from sys_acl where role_code = $1 and res_type = $2 and res_key = $3', [roleCode, resType, resKey]);
  acl.clear(roleCode);
  res.json({ code: 0, message: '权限已更新' });
});

// 运行信息
router.get('/stats', async (req, res) => {
  const db = await getDb();
  const t = async (sql) => (await one(sql)).c;
  const tables = ['sys_user', 'crm_customer', 'crm_lead', 'crm_lead_pool', 'crm_opportunity', 'crm_contract', 'crm_order', 'crm_follow_up',
    'rpt_dataset', 'rpt_report', 'bi_metric', 'bi_metric_value', 'bi_widget', 'bi_dashboard', 'bi_task', 'bi_task_log'];
  const counts = {};
  for (const tb of tables) counts[tb] = await t(`select count(*)::int as c from ${tb}`);
  const ver = await one('select version() as v, current_database() as d, current_date as today');
  res.json({
    code: 0,
    data: { db: { mode: db.mode, label: db.label, version: ver.v }, today: ver.today, counts }
  });
});

router.get('/postgres', async (req,res) => {
  if (!guard(req,res)) return;
  res.json({code:0,data:await require('../services/postgresInsights').diagnostics()});
});
router.post('/postgres/refresh', async (req,res) => {
  if (!guard(req,res)) return;
  const refreshed=await require('../services/postgresInsights').refresh();
  res.json({code:0,data:{refreshed},message:refreshed?'经营快照已刷新':'当前正在刷新或未启用 PostgreSQL，请稍后查看'});
});

router.get('/oper-logs', async (req, res) => {
  if (!guard(req, res)) return;
  const rows = await many('select * from sys_oper_log order by id desc limit 100');
  res.json({ code: 0, data: rows });
});

module.exports = { router };
