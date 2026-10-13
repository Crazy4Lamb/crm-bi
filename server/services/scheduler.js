'use strict';
/** 任务调度器：基于 node-cron 加载启用的定时任务（T+1 指标计算等） */
const cron = require('node-cron');
const cfg = require('../config');
const { many } = require('../db');
const metricEngine = require('./metricEngine');

const jobs = new Map();
let enabled = cfg.scheduler;

const FIELD_DESC = {
  '0 30 1 * * *': '每天 01:30',
  '0 0 2 * * *': '每天 02:00',
  '0 30 2 * * *': '每天 02:30',
  '0 0 3 * * 0': '每周日 03:00',
  '0 0 * * * *': '每小时整点'
};

function describe(expr) {
  if (FIELD_DESC[expr]) return FIELD_DESC[expr];
  const p = String(expr).trim().split(/\s+/);
  if (p.length === 6) {
    const [s, m, h, dom, mon, dow] = p;
    if (mon === '*' && dom === '*' && dow === '*') {
      if (m.startsWith('*/')) return `每 ${m.slice(2)} 分钟`;
      if (h === '*') return `每小时 ${m} 分`;
      return `每天 ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
    }
    if (dow !== '*') return `每周 ${dow} ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
    return `每月 ${dom} 日 ${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  }
  return expr;
}

function matchField(field, value, min, max) {
  if (field === '*' || field === '?') return true;
  return field.split(',').some((part) => {
    if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = Number(stepStr) || 1;
      if (range === '*') return value % step === 0;
      const [a, b] = range.split('-').map(Number);
      return value >= a && value <= b && (value - a) % step === 0;
    }
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      return value >= a && value <= b;
    }
    return Number(part) === value;
  });
}

/** 计算下一次执行时间（按分钟粒度估算） */
function nextRunOf(expr, from = new Date()) {
  const p = String(expr || '').trim().split(/\s+/);
  if (p.length < 5) return null;
  const [sec, min, hour, dom, mon, dow] = p.length === 6 ? p : ['0', ...p];
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 370; i++) {
    const dowVal = d.getDay();
    if (matchField(min, d.getMinutes(), 0, 59) &&
      matchField(hour, d.getHours(), 0, 23) &&
      matchField(dom, d.getDate(), 1, 31) &&
      matchField(mon, d.getMonth() + 1, 1, 12) &&
      matchField(dow, dowVal, 0, 6)) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

async function reload() {
  for (const job of jobs.values()) { try { job.stop(); } catch (e) { /* noop */ } }
  jobs.clear();
  if (!enabled) return { scheduled: 0, enabled: false };
  const tasks = await many("select * from bi_task where status = '1'");
  for (const t of tasks) {
    if (!cron.validate(t.cron_expr)) continue;
    const job = cron.schedule(t.cron_expr, () => { safeRun(t); }, { timezone: cfg.tz });
    jobs.set(t.code, { job, task: t, desc: describe(t.cron_expr) });
  }
  return { scheduled: jobs.size, enabled: true };
}

async function safeRun(task) {
  const started = Date.now();
  try {
    const r = await metricEngine.runTask(task, { triggerBy: 'schedule' });
    if (r.ok) await require('./postgresInsights').refresh();
    console.log(`[scheduler] ${task.code} 执行${r.ok ? '成功' : '失败'} 写入 ${r.rows} 条 (${Date.now() - started}ms)`);
    return r;
  } catch (e) {
    console.error(`[scheduler] ${task.code} 异常:`, e.message);
    return { ok: false, error: e.message };
  }
}

const isOn = () => enabled;
const status = () => ({
  enabled,
  timezone: cfg.tz,
  jobs: [...jobs.entries()].map(([code, v]) => ({
    code, name: v.task.name, cron: v.task.cron_expr, desc: v.desc,
    next: nextRunOf(v.task.cron_expr), lastRun: v.task.last_run_at
  }))
});

module.exports = { reload, status, isOn, describe, nextRunOf, safeRun };
