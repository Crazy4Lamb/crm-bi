'use strict';
/**
 * 卡片引擎（驾驶舱卡片信息）
 *  两种取值口径：
 *   value_mode = metric  → 读取 T+1 指标库（bi_metric_value），保证口径统一、可追溯
 *   value_mode = direct  → 按报表数据集实时聚合（可带数据范围收敛，销售代表看到的就是自己的数据）
 *  支持：当日/本月累计/近7天/近30天/全部、环比、目标完成率、30 天迷你趋势
 */
const { q, one, num, dateOnly } = require('../db');
const RE = require('./reportEngine');
const MET = require('./metricEngine');
const { rangeOf, prevRangeOf, growth } = require('./periods');

const { fmtDate, addDays, today } = RE;

/** 累计口径下的汇总方式：可计数的量（金额/数量）求和，比率类取平均 */
function rollupFn(metric) {
  if (!metric) return 'sum';
  if (metric.agg_fn === 'sum') return 'sum';
  if (['份', '笔', '家', '条', '个', '台'].includes(metric.unit)) return 'sum';
  return 'avg';
}

function sumModeLabel(mode) {
  return { latest: '当日', day: '当日', mtd: '本月累计', month: '整月', last7: '近 7 天', last30: '近 30 天', last90: '近 90 天', all: '全部' }[mode] || mode;
}

function fmtValue(v, fmt) {
  const n = num(v);
  if (fmt === 'percent') return (n * 100).toFixed(2) + '%';
  if (fmt === 'currency') {
    if (Math.abs(n) >= 100000000) return (n / 100000000).toFixed(2) + ' 亿';
    if (Math.abs(n) >= 10000) return (n / 10000).toFixed(2) + ' 万';
    return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }
  if (fmt === 'number') return Math.round(n).toLocaleString('zh-CN');
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/** 指标口径卡片 */
async function metricCard(widget, user) {
  const metric = await one('select * from bi_metric where id = $1', [widget.metric_id]);
  if (!metric) throw new Error('卡片绑定的指标不存在');
  const mode = widget.sum_mode || 'latest';
  const statDate = fmtDate(addDays(today(), -1));      // T+1 数据日
  const latest = await MET.latestValue(metric.id, null);
  const baseDate = statDate;
  const range = rangeOf(mode === 'latest' ? 'day' : mode, baseDate);
  const from = range ? range.from : null;
  const to = range ? range.to : null;

  const rows = await MET.valueSeries(metric.id, from || '1900-01-01', to || '2999-12-31');
  const rollup = rollupFn(metric);
  let value = 0;
  if (mode === 'latest' || mode === 'day') {
    const r = await MET.latestValue(metric.id, statDate) || latest;
    value = r ? num(r.value) : 0;
  } else if (rows.length) {
    value = rollup === 'sum' ? rows.reduce((s, r) => s + r.value, 0) : rows.reduce((s, r) => s + r.value, 0) / rows.length;
  }

  // 环比
  let prevValue = null;
  if (widget.compare === 'month') {
    const pr = prevRangeOf(mode === 'latest' ? 'mtd' : mode, baseDate);
    if (pr) {
      const prows = await MET.valueSeries(metric.id, pr.from, pr.to);
      if (prows.length) prevValue = rollup === 'sum' ? prows.reduce((s, r) => s + r.value, 0) : prows.reduce((s, r) => s + r.value, 0) / prows.length;
    }
  } else if (widget.compare === 'day') {
    const series = await MET.valueSeries(metric.id, fmtDate(addDays(today(), -70)), statDate);
    if (series.length >= 2) prevValue = series[series.length - 2].value;
    else if (latest && latest.prev_value != null) prevValue = num(latest.prev_value);
  }

  const sparkFrom = fmtDate(addDays(today(), -30));
  const spark = (await MET.valueSeries(metric.id, sparkFrom, statDate)).map((r) => ({ date: r.date, value: r.value }));
  return finalize(widget, { value, prevValue, spark, source: 'metric', metric, statDate: baseDate, sql: null });
}

/** 实时聚合口径卡片 */
async function directCard(widget, user) {
  const series = widget.series && widget.series.length ? widget.series : [{ key: null, agg: 'count' }];
  const fieldKeys = series.map((s) => s.key).filter(Boolean);
  const mode = widget.sum_mode || 'latest';
  const statDate = fmtDate(addDays(today(), -1));
  const range = rangeOf(mode === 'latest' ? 'day' : mode, statDate);
  const extraFilters = (widget.filters || []).filter((f) => f && f.fieldKey);

  const res = await RE.runReport(widget.report_id, {
    fieldKeys, extraFilters, dateRange: range, scope: widget.scope, withTotal: false
  }, user);
  const key = fieldKeys[0] || (res.columns.find((c) => c.role === 'measure') || {}).key;
  const raw = (res.rows.length && key) ? num(res.rows[0][key]) : 0;

  // 环比
  let prevRaw = null;
  if (widget.compare && widget.compare !== 'none') {
    const pr = prevRangeOf(mode === 'latest' ? 'day' : mode, statDate);
    if (pr) {
      const pres = await RE.runReport(widget.report_id, {
        fieldKeys, extraFilters, dateRange: { from: pr.from, to: pr.to }, scope: widget.scope, withTotal: false
      }, user);
      prevRaw = pres.rows.length && key ? num(pres.rows[0][key]) : null;
    }
  }

  // 30 天迷你趋势
  let spark = [];
  try {
    const ctx = await RE.loadReport(widget.report_id);
    const dateKey = ctx.rptMap.has(ctx.ds.date_field) ? ctx.ds.date_field
      : (ctx.rptFields.find((f) => f.field_type === 'date' && f.field_role === 'dimension') || {}).field_key;
    if (dateKey && key) {
      const sres = await RE.runReport(widget.report_id, {
        dimsOverride: [dateKey], extraFilters, dateRange: { from: fmtDate(addDays(today(), -30)), to: statDate }, scope: widget.scope, withTotal: false,
        orderBy: [{ key: dateKey, dir: 'asc' }]
      }, user);
      spark = sres.rows.filter((r) => r[dateKey] != null).map((r) => ({ date: r[dateKey], value: num(r[key]) }));
    }
  } catch (e) { spark = []; }

  const target = num((widget.style || {}).target) || 0;
  const value = target ? (raw / target) * 100 : raw;
  const prevValue = target && prevRaw != null ? (prevRaw / target) * 100 : prevRaw;
  return finalize(widget, { value, prevValue, spark, source: 'direct', raw, target, statDate, sql: res.sql });
}

function finalize(widget, o) {
  const style = widget.style || {};
  const g = widget.compare && widget.compare !== 'none' ? growth(o.value, o.prevValue) : null;
  return {
    code: widget.code, name: widget.name, icon: widget.icon, unit: widget.unit, fmt: widget.fmt,
    widgetType: 'card',
    value: num(o.value),
    display: fmtValue(o.value, widget.fmt),
    rawValue: num(o.raw != null ? o.raw : o.value),
    prevValue: o.prevValue == null ? null : num(o.prevValue),
    growth: g,
    growthText: g == null ? null : (g >= 0 ? '+' : '') + (g * 100).toFixed(1) + '%',
    compare: widget.compare || 'none',
    sumMode: widget.sum_mode || 'latest',
    sumModeLabel: sumModeLabel(widget.sum_mode || 'latest'),
    target: o.target || null,
    progress: o.target ? Number(((num(o.raw) / o.target) * 100).toFixed(2)) : null,
    spark: o.spark || [],
    source: o.source,
    metric: o.metric ? { id: o.metric.id, code: o.metric.code, name: o.metric.name, agg: o.metric.agg_fn, unit: o.metric.unit } : null,
    statDate: o.statDate,
    color: style.color || '#2f6bff',
    sql: o.sql || null
  };
}

async function buildCard(widget, user) {
  const w = widget;
  if (w.value_mode === 'metric' && w.metric_id) return metricCard(w, user);
  return directCard({ ...w, value_mode: 'direct' }, user);
}

module.exports = { buildCard, fmtValue, rollupFn };
