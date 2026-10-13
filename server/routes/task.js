'use strict';
/** 任务管理：定时任务（T+1 指标计算等）配置、立即执行、执行日志 */
const express = require('express');
const { q, one, many, num, dateOnly, timestamp } = require('../db');
const acl = require('../services/acl');
const MET = require('../services/metricEngine');
const scheduler = require('../services/scheduler');

const router = express.Router();

async function ensurePerm(req, res, action) {
  const p = await acl.perms(req.user.role);
  if (req.user.role !== 'admin' && !acl.can(p, 'action', action)) {
    res.status(403).json({ code: 403, message: '无权限：需要「任务管理」权限' });
    return false;
  }
  return true;
}

const TASK_TYPES = [
  ['metric_calc', '指标计算（T+N）'],
  ['data_archive', '数据归档校验']
];

router.get('/meta', async (req, res) => {
  const metrics = await many("select id, code, name, metric_group, agg_fn, date_mode, unit from bi_metric where status = '1' order by metric_group, id");
  res.json({
    code: 0, data: {
      taskTypes: TASK_TYPES,
      metrics,
      cronExamples: [
        ['0 30 1 * * *', '每天 01:30'],
        ['0 0 2 * * *', '每天 02:00'],
        ['0 0 3 * * 0', '每周日 03:00'],
        ['0 0 * * * *', '每小时整点']
      ],
      schedulerOn: scheduler.isOn()
    }
  });
});

router.get('/list', async (req, res) => {
  const rows = await many(`select t.*, u.real_name as owner_name,
      (select status from bi_task_log l where l.task_id = t.id order by l.id desc limit 1) as last_log_status,
      (select count(*)::int from bi_task_log l where l.task_id = t.id) as run_count,
      (select count(*)::int from bi_task_log l where l.task_id = t.id and l.status = 'failed') as fail_count
    from bi_task t left join sys_user u on u.id = t.owner_id order by t.id`);
  res.json({
    code: 0, data: rows.map((r) => ({
      ...r,
      next_run_at: r.status === '1' ? scheduler.nextRunOf(r.cron_expr) : null,
      cron_desc: scheduler.describe(r.cron_expr)
    }))
  });
});

router.get('/logs', async (req, res) => {
  const limit = Math.min(500, Number(req.query.limit || 100));
  const taskId = req.query.taskId ? Number(req.query.taskId) : null;
  const rows = await many(`select * from bi_task_log ${taskId ? 'where task_id = ' + taskId : ''} order by id desc limit ${limit}`);
  res.json({
    code: 0, data: rows.map((r) => ({
      ...r,
      stat_date: dateOnly(r.stat_date), start_time: timestamp(r.start_time), end_time: timestamp(r.end_time)
    }))
  });
});

// 立即执行
router.post('/:id(\\d+)/run', async (req, res) => {
  if (!(await ensurePerm(req, res, 'task:run'))) return;
  const task = await one('select * from bi_task where id = $1', [Number(req.params.id)]);
  if (!task) return res.status(404).json({ code: 404, message: '任务不存在' });
  const statDate = (req.body && req.body.statDate) || null;
  const r = await MET.runTask(task, { statDate, triggerBy: 'manual:' + req.user.username, user: req.user });
  res.json({ code: 0, data: r, message: r.ok ? `执行成功，写入 ${r.rows} 条指标值` : `执行失败：${r.error}` });
});

router.post('/', async (req, res) => {
  if (!(await ensurePerm(req, res, 'task:edit'))) return;
  const b = req.body || {};
  if (!b.name || !b.taskType) return res.status(400).json({ code: 400, message: '任务名称与类型必填' });
  const code = b.code || 'task_' + Date.now().toString(36);
  const row = await one(`insert into bi_task (code, name, task_type, cron_expr, date_offset, target, status, owner_id, description)
    values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) returning id`,
    [code, b.name, b.taskType, b.cronExpr || '0 30 1 * * *', Number(b.dateOffset == null ? 1 : b.dateOffset),
      JSON.stringify(b.target || { all: true }), b.status || '1', req.user.id, b.description || null]);
  await scheduler.reload();
  res.json({ code: 0, data: { id: row.id, code }, message: '任务已创建' });
});

router.put('/:id(\\d+)', async (req, res) => {
  if (!(await ensurePerm(req, res, 'task:edit'))) return;
  const b = req.body || {};
  await q(`update bi_task set name = coalesce($1,name), task_type = coalesce($2,task_type), cron_expr = coalesce($3,cron_expr),
      date_offset = coalesce($4,date_offset), target = coalesce($5::jsonb,target), status = coalesce($6,status),
      description = coalesce($7,description), updated_at = now() where id = $8`,
    [b.name || null, b.taskType || null, b.cronExpr || null, b.dateOffset == null ? null : Number(b.dateOffset),
      b.target ? JSON.stringify(b.target) : null, b.status || null, b.description || null, Number(req.params.id)]);
  await scheduler.reload();
  res.json({ code: 0, message: '已保存' });
});

router.delete('/:id(\\d+)', async (req, res) => {
  if (!(await ensurePerm(req, res, 'task:edit'))) return;
  await q('delete from bi_task where id = $1', [Number(req.params.id)]);
  await scheduler.reload();
  res.json({ code: 0, message: '已删除' });
});

// 调度器状态
router.get('/scheduler/status', async (req, res) => {
  res.json({ code: 0, data: scheduler.status() });
});

module.exports = { router };
