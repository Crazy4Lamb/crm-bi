'use strict';
/** 指标设计：定义指标（报表 + 度量 + 统计方式 + 日期口径 + 过滤），查看/补算指标值 */
const express = require('express');
const { q, one, many, num, dateOnly } = require('../db');
const acl = require('../services/acl');
const RE = require('../services/reportEngine');
const MET = require('../services/metricEngine');

const router = express.Router();

async function ensureDesign(req, res) {
  const p = await acl.perms(req.user.role);
  if (req.user.role !== 'admin' && !acl.can(p, 'action', 'metric:design')) {
    res.status(403).json({ code: 403, message: '无权限：需要「指标设计」权限' });
    return false;
  }
  return true;
}

// 设计器元数据
router.get('/meta', async (req, res) => {
  const reports = await many(`select r.id, r.code, r.name, r.category, d.code as dataset_code, d.name as dataset_name
    from rpt_report r join rpt_dataset d on d.id = r.dataset_id order by r.category, r.id`);
  const fields = await many('select report_id, field_key, field_name, field_type, field_role, agg_fn, is_custom, fmt from rpt_report_field order by report_id, sort_no');
  res.json({
    code: 0, data: {
      reports: reports.map((r) => ({ ...r, fields: fields.filter((f) => f.report_id === r.id) })),
      aggs: RE.AGG_FNS.filter((a) => a !== 'none').map((a) => ({ value: a, label: RE.AGG_LABEL[a] })),
      dateModes: [['day', '当日'], ['mtd', '本月累计'], ['month', '整月'], ['last7', '近 7 天'], ['last30', '近 30 天'], ['all', '全部']],
      units: ['元', '份', '笔', '家', '条', '个', '台', '%', '天'],
      directions: [['up', '越大越好'], ['down', '越小越好']],
      ops: RE.OP_LIST
    }
  });
});

router.get('/list', async (req, res) => {
  const rows = await many(`select m.*, r.name as report_name, r.code as report_code,
      v.stat_date as last_date, v.value as last_value
    from bi_metric m
    left join rpt_report r on r.id = m.report_id
    left join lateral (select stat_date, value from bi_metric_value where metric_id = m.id order by stat_date desc limit 1) v on true
    order by m.metric_group, m.id`);
  res.json({ code: 0, data: rows });
});

router.get('/:id(\\d+)', async (req, res) => {
  const m = await one('select * from bi_metric where id = $1', [Number(req.params.id)]);
  if (!m) return res.status(404).json({ code: 404, message: '指标不存在' });
  res.json({ code: 0, data: m });
});

// 指标值序列
router.get('/:id(\\d+)/values', async (req, res) => {
  const id = Number(req.params.id);
  const to = req.query.to || RE.fmtDate(RE.today());
  const from = req.query.from || RE.fmtDate(RE.addDays(RE.today(), -90));
  const rows = await many('select stat_date, value, prev_value, calc_time from bi_metric_value where metric_id = $1 and stat_date between $2 and $3 order by stat_date', [id, from, to]);
  const m = await one('select * from bi_metric where id = $1', [id]);
  const values = rows.map((r) => ({
    statDate: dateOnly(r.stat_date), value: num(r.value),
    prevValue: r.prev_value == null ? null : num(r.prev_value),
    growth: r.prev_value ? (num(r.value) - num(r.prev_value)) / Math.abs(num(r.prev_value)) : null,
    calcTime: r.calc_time
  }));
  res.json({
    code: 0, data: {
      metric: m, from, to, values,
      summary: {
        count: values.length,
        lastDate: values.length ? values[values.length - 1].statDate : null,
        lastValue: values.length ? values[values.length - 1].value : null,
        sum: values.reduce((s, v) => s + v.value, 0),
        avg: values.length ? values.reduce((s, v) => s + v.value, 0) / values.length : 0,
        max: values.length ? Math.max(...values.map((v) => v.value)) : null,
        min: values.length ? Math.min(...values.map((v) => v.value)) : null
      }
    }
  });
});

// 立即试算（不落库）
router.post('/:id(\\d+)/preview', async (req, res) => {
  const m = await one('select * from bi_metric where id = $1', [Number(req.params.id)]);
  if (!m) return res.status(404).json({ code: 404, message: '指标不存在' });
  const statDate = (req.body && req.body.statDate) || RE.fmtDate(RE.addDays(RE.today(), -1));
  const r = await MET.computeMetricAt({ ...m, date_field_key: m.date_field_key }, statDate, req.user);
  res.json({ code: 0, data: { statDate, value: r.value, range: r.range } });
});

// 单指标补算
router.post('/:id(\\d+)/compute', async (req, res) => {
  const m = await one('select * from bi_metric where id = $1', [Number(req.params.id)]);
  if (!m) return res.status(404).json({ code: 404, message: '指标不存在' });
  const b = req.body || {};
  let dates;
  if (b.from && b.to) {
    dates = [];
    let d = new Date(b.from + 'T00:00:00');
    const end = new Date(b.to + 'T00:00:00');
    while (d <= end) { dates.push(RE.fmtDate(d)); d = RE.addDays(d, 1); }
  } else {
    dates = [b.statDate || RE.fmtDate(RE.addDays(RE.today(), -1))];
  }
  const r = await MET.persistMetric(m, dates, { user: req.user });
  res.json({ code: 0, data: r, message: `已计算 ${r.rows} 条` });
});

router.post('/', async (req, res) => {
  if (!(await ensureDesign(req, res))) return;
  const b = req.body || {};
  if (!b.name || !b.reportId) return res.status(400).json({ code: 400, message: '指标名称与数据来源必填' });
  const code = b.code || 'm_' + Date.now().toString(36);
  const exists = await one('select id from bi_metric where code = $1', [code]);
  if (exists) return res.status(400).json({ code: 400, message: '指标编码已存在' });
  const row = await one(`insert into bi_metric (code, name, metric_group, report_id, measure_key, agg_fn, date_field_key, date_mode,
      filters, unit, precision, direction, description, owner_id, status)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,'1') returning id`,
    [code, b.name, b.metricGroup || '自定义', Number(b.reportId), b.measureKey || null, b.aggFn || 'sum',
      b.dateFieldKey || null, b.dateMode || 'day', JSON.stringify(b.filters || []), b.unit || null,
      Number(b.precision || 0), b.direction || 'up', b.description || null, req.user.id]);
  res.json({ code: 0, data: { id: row.id, code }, message: '指标已创建，可在任务管理中执行计算' });
});

router.put('/:id(\\d+)', async (req, res) => {
  if (!(await ensureDesign(req, res))) return;
  const b = req.body || {};
  await q(`update bi_metric set name = coalesce($1,name), metric_group = coalesce($2,metric_group), report_id = coalesce($3,report_id),
      measure_key = coalesce($4,measure_key), agg_fn = coalesce($5,agg_fn), date_field_key = coalesce($6,date_field_key),
      date_mode = coalesce($7,date_mode), filters = coalesce($8::jsonb,filters), unit = coalesce($9,unit),
      precision = coalesce($10,precision), direction = coalesce($11,direction), description = coalesce($12,description),
      status = coalesce($13,status), updated_at = now() where id = $14`,
    [b.name || null, b.metricGroup || null, b.reportId || null, b.measureKey || null, b.aggFn || null, b.dateFieldKey || null,
      b.dateMode || null, b.filters ? JSON.stringify(b.filters) : null, b.unit || null,
      b.precision == null ? null : Number(b.precision), b.direction || null, b.description || null, b.status || null, Number(req.params.id)]);
  res.json({ code: 0, message: '已保存' });
});

router.delete('/:id(\\d+)', async (req, res) => {
  if (!(await ensureDesign(req, res))) return;
  await q('delete from bi_metric where id = $1', [Number(req.params.id)]);
  res.json({ code: 0, message: '已删除' });
});

module.exports = { router };
