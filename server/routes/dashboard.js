'use strict';
/** 驾驶舱：按角色装配卡片与统计图（菜单/卡片/图表/驾驶舱权限都来自 sys_acl） */
const express = require('express');
const { q, one, many, num } = require('../db');
const acl = require('../services/acl');
const cardEngine = require('../services/cardEngine');
const chartEngine = require('../services/chartEngine');
const RE = require('../services/reportEngine');

const router = express.Router();
router.get('/insights', async (req, res) => {
  const p = await acl.perms(req.user.role);
  if (!acl.can(p,'menu','dashboard')) return res.status(403).json({code:403,message:'无权限查看驾驶舱'});
  res.json({code:0,data:await require('../services/postgresInsights').insights()});
});

async function renderWidget(w, user) {
  if (w.widget_type === 'card') {
    try {
      const d = await cardEngine.buildCard(w, user);
      return { code: w.code, name: w.name, widgetType: 'card', ok: true, data: d };
    } catch (e) {
      return { code: w.code, name: w.name, widgetType: 'card', ok: false, error: String(e.message || e) };
    }
  }
  try {
    const d = await chartEngine.buildChart(w, user);
    return {
      code: w.code, name: w.name, widgetType: 'chart', chartType: d.chartType, ok: true,
      data: { option: d.option, rows: d.rows.slice(0, 200), columns: d.columns, scope: d.scope, totalRows: d.totalRows }
    };
  } catch (e) {
    return { code: w.code, name: w.name, widgetType: 'chart', ok: false, error: String(e.message || e) };
  }
}

// 我的驾驶舱布局
router.get('/mine', async (req, res) => {
  const p = await acl.perms(req.user.role);
  const codes = p.dashboard && p.dashboard.length ? p.dashboard : [];
  const dashes = codes.length
    ? await many('select * from bi_dashboard where status = \'1\' and code = any($1::text[]) order by sort_no, id', [codes])
    : [];
  if (!dashes.length) return res.json({ code: 0, data: { dashboards: [], dashboard: null, cards: [], charts: [] } });
  const code = req.query.dashboard && dashes.find((d) => d.code === req.query.dashboard) ? req.query.dashboard : dashes[0].code;
  const dash = dashes.find((d) => d.code === code);
  const items = await many(
    `select w.*, dw.col_span, dw.height from bi_dashboard_widget dw join bi_widget w on w.id = dw.widget_id
     where dw.dashboard_id = $1 order by dw.sort_no`, [dash.id]);
  const cards = items.filter((i) => i.widget_type === 'card' && acl.can(p, 'card', i.code))
    .map((i) => ({ code: i.code, name: i.name, icon: i.icon, unit: i.unit, fmt: i.fmt, color: (i.style || {}).color, span: i.col_span, height: i.height, source: i.value_mode, sumMode: i.sum_mode }));
  const charts = items.filter((i) => i.widget_type === 'chart' && acl.can(p, 'chart', i.code))
    .map((i) => ({ code: i.code, name: i.name, chartType: i.chart_type, span: i.col_span, height: i.height, scope: i.scope, reportId: i.report_id }));
  res.json({
    code: 0, data: {
      dashboards: dashes.map((d) => ({ code: d.code, name: d.name, description: d.description, isDefault: d.is_default })),
      dashboard: { code: dash.code, name: dash.name, description: dash.description },
      cards, charts, statDate: RE.fmtDate(RE.addDays(RE.today(), -1))
    }
  });
});

// 单个组件数据
router.get('/widget/:code', async (req, res) => {
  const w = await one('select * from bi_widget where code = $1 and status = \'1\'', [req.params.code]);
  if (!w) return res.status(404).json({ code: 404, message: '组件不存在' });
  const p = await acl.perms(req.user.role);
  const type = w.widget_type === 'card' ? 'card' : 'chart';
  if (!acl.can(p, type, w.code) && req.user.role !== 'admin') {
    return res.status(403).json({ code: 403, message: '当前角色无权查看该组件' });
  }
  const r = await renderWidget(w, req.user);
  res.json({ code: 0, data: r, widget: { code: w.code, name: w.name, chartType: w.chart_type, span: 6 } });
});

// 批量组件数据（驾驶舱首屏）
router.get('/widgets', async (req, res) => {
  const codes = String(req.query.codes || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (!codes.length) return res.json({ code: 0, data: [] });
  const p = await acl.perms(req.user.role);
  const ws = await many('select * from bi_widget where code = any($1::text[])', [codes]);
  const out = [];
  for (const w of ws) {
    const type = w.widget_type === 'card' ? 'card' : 'chart';
    if (!acl.can(p, type, w.code) && req.user.role !== 'admin') {
      out.push({ code: w.code, name: w.name, ok: false, error: '无权限' });
      continue;
    }
    out.push(await renderWidget(w, req.user));
  }
  res.json({ code: 0, data: out });
});

// 全部可用组件（图表中心浏览用）
router.get('/widget-library', async (req, res) => {
  const p = await acl.perms(req.user.role);
  const ws = await many("select * from bi_widget where status = '1' order by widget_type, sort_no, id");
  const visible = ws.filter((w) => req.user.role === 'admin' || acl.can(p, w.widget_type === 'card' ? 'card' : 'chart', w.code));
  res.json({
    code: 0, data: visible.map((w) => ({
      id: w.id, code: w.code, name: w.name, widgetType: w.widget_type, chartType: w.chart_type,
      reportId: w.report_id, metricId: w.metric_id, valueMode: w.value_mode, scope: w.scope,
      sumMode: w.sum_mode, unit: w.unit, dims: w.dimension_keys, series: w.series, filters: w.filters,
      style: w.style, limit: w.limit_rows, sortStrategy: w.sort_strategy, compare: w.compare, icon: w.icon
    }))
  });
});

module.exports = { router, renderWidget };
