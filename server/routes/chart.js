'use strict';
/** 统计图中心：设计（图型/维度/系列/统计方式/样式）+ 预览 + 保存 + 取数 */
const express = require('express');
const { q, one, many, num } = require('../db');
const acl = require('../services/acl');
const chartEngine = require('../services/chartEngine');
const RE = require('../services/reportEngine');

const router = express.Router();

async function ensureDesign(req, res) {
  const p = await acl.perms(req.user.role);
  if (req.user.role !== 'admin' && !acl.can(p, 'action', 'widget:design')) {
    res.status(403).json({ code: 403, message: '无权限：需要「统计图设计」权限' });
    return false;
  }
  return true;
}

/** 设计器可选的报表与可拖拽字段 */
async function reportCatalog() {
  const reports = await many(`select r.id, r.code, r.name, r.category, d.id as dataset_id, d.name as dataset_name, d.code as dataset_code,
      d.date_field, d.owner_field, d.dept_field
    from rpt_report r join rpt_dataset d on d.id = r.dataset_id order by r.category, r.id`);
  const fields = await many('select * from rpt_report_field order by report_id, sort_no');
  return reports.map((r) => ({ ...r, fields: fields.filter((f) => f.report_id === r.id) }));
}

router.get('/meta', async (req, res) => {
  res.json({
    code: 0, data: {
      chartTypes: chartEngine.CHART_TYPES.map((c) => ({ value: c[0], label: c[1] })),
      palettes: [['blue', '经典蓝'], ['purple', '科技紫'], ['green', '增长绿'], ['orange', '活力橙'], ['teal', '青蓝'], ['red', '警示红'], ['multi', '多彩'], ['heat', '热力']],
      aggs: RE.AGG_FNS.filter((a) => a !== 'none').map((a) => ({ value: a, label: RE.AGG_LABEL[a] })),
      sortStrategies: [['value_desc', '按值降序'], ['value_asc', '按值升序'], ['axis', '按维度顺序']],
      scopes: [['global', '全量数据'], ['dept', '本部门数据'], ['self', '仅本人数据']],
      sumModes: [['latest', '当日'], ['mtd', '本月累计'], ['last7', '近 7 天'], ['last30', '近 30 天'], ['all', '全部']],
      reports: await reportCatalog()
    }
  });
});

router.get('/list', async (req, res) => {
  const rows = await many(`select w.*, r.name as report_name, m.name as metric_name
    from bi_widget w left join rpt_report r on r.id = w.report_id left join bi_metric m on m.id = w.metric_id
    order by w.widget_type, w.id`);
  res.json({ code: 0, data: rows });
});

router.get('/:id(\\d+)', async (req, res) => {
  const w = await one('select * from bi_widget where id = $1', [Number(req.params.id)]);
  if (!w) return res.status(404).json({ code: 404, message: '组件不存在' });
  res.json({ code: 0, data: w });
});

/** 取数（已保存组件） */
router.get('/:id(\\d+)/data', async (req, res) => {
  const w = await one('select * from bi_widget where id = $1', [Number(req.params.id)]);
  if (!w) return res.status(404).json({ code: 404, message: '组件不存在' });
  const p = await acl.perms(req.user.role);
  if (w.widget_type === 'chart' && req.user.role !== 'admin' && !acl.can(p, 'chart', w.code)) {
    return res.status(403).json({ code: 403, message: '当前角色无权查看该统计图' });
  }
  if (w.widget_type === 'card') {
    const cardEngine = require('../services/cardEngine');
    return res.json({ code: 0, data: await cardEngine.buildCard(w, req.user) });
  }
  const d = await chartEngine.buildChart(w, req.user);
  res.json({ code: 0, data: d });
});

/** 设计器实时预览（不落库） */
router.post('/preview', async (req, res) => {
  const b = req.body || {};
  if (!b.reportId) return res.status(400).json({ code: 400, message: '请先选择数据集/报表' });
  const fake = {
    code: 'preview', name: b.name || '预览', widget_type: 'chart', chart_type: b.chartType || 'bar',
    report_id: Number(b.reportId), metric_id: b.metricId || null,
    dimension_keys: b.dims || [], series: b.series || [], filters: b.filters || [],
    sort_strategy: b.sortStrategy || 'value_desc', limit_rows: Number(b.limit || 20),
    scope: b.scope || 'global', style: b.style || {}
  };
  const d = await chartEngine.buildChart(fake, req.user);
  res.json({ code: 0, data: d });
});

/** 样例数据（设计器里看字段可选值） */
router.get('/sample/:reportId(\\d+)', async (req, res) => {
  const r = await RE.runReport(Number(req.params.reportId), { limit: 5, withTotal: false }, req.user);
  res.json({ code: 0, data: { columns: r.columns, rows: r.rows } });
});

router.post('/', async (req, res) => {
  if (!(await ensureDesign(req, res))) return;
  const b = req.body || {};
  if (!b.name || !b.chartType) return res.status(400).json({ code: 400, message: '名称与图型必填' });
  const code = b.code || 'w_' + Date.now().toString(36);
  const row = await one(`insert into bi_widget (code, name, widget_type, chart_type, value_mode, metric_id, report_id,
      dimension_keys, series, filters, sort_strategy, limit_rows, scope, sum_mode, compare, style, unit, icon, status)
    values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,'1') returning id`,
    [code, b.name, b.widgetType || 'chart', b.chartType || null, b.metricId ? 'metric' : 'direct',
      b.metricId || null, b.reportId || null, JSON.stringify(b.dims || []), JSON.stringify(b.series || []),
      JSON.stringify(b.filters || []), b.sortStrategy || 'value_desc', Number(b.limit || 20), b.scope || 'global',
      b.sumMode || 'latest', b.compare || 'none', JSON.stringify(b.style || {}), b.unit || null, b.icon || null]);
  // 默认授权给创建者角色，便于立即看到
  await q('insert into sys_acl (role_code, res_type, res_key) values ($1,$2,$3) on conflict do nothing',
    [req.user.role, b.widgetType === 'card' ? 'card' : 'chart', code]);
  acl.clear(req.user.role);
  res.json({ code: 0, data: { id: row.id, code }, message: '统计图已创建' });
});

router.put('/:id(\\d+)', async (req, res) => {
  if (!(await ensureDesign(req, res))) return;
  const id = Number(req.params.id);
  const b = req.body || {};
  await q(`update bi_widget set name = coalesce($1,name), chart_type = coalesce($2,chart_type), report_id = coalesce($3,report_id),
      metric_id = coalesce($4,metric_id), dimension_keys = coalesce($5::jsonb, dimension_keys), series = coalesce($6::jsonb, series),
      filters = coalesce($7::jsonb, filters), sort_strategy = coalesce($8,sort_strategy), limit_rows = coalesce($9,limit_rows),
      scope = coalesce($10,scope), sum_mode = coalesce($11,sum_mode), compare = coalesce($12,compare),
      style = coalesce($13::jsonb, style), unit = coalesce($14,unit), updated_at = now() where id = $15`,
    [b.name || null, b.chartType || null, b.reportId || null, b.metricId || null,
      b.dims ? JSON.stringify(b.dims) : null, b.series ? JSON.stringify(b.series) : null, b.filters ? JSON.stringify(b.filters) : null,
      b.sortStrategy || null, b.limit ? Number(b.limit) : null, b.scope || null, b.sumMode || null, b.compare || null,
      b.style ? JSON.stringify(b.style) : null, b.unit || null, id]);
  res.json({ code: 0, message: '已保存' });
});

router.delete('/:id(\\d+)', async (req, res) => {
  if (!(await ensureDesign(req, res))) return;
  const w = await one('select code from bi_widget where id = $1', [Number(req.params.id)]);
  await q('delete from bi_widget where id = $1', [Number(req.params.id)]);
  if (w) await q('delete from sys_acl where res_key = $1 and res_type in (\'card\',\'chart\')', [w.code]);
  acl.clear();
  res.json({ code: 0, message: '已删除' });
});

module.exports = { router };
