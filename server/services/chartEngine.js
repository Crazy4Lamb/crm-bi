'use strict';
/**
 * 统计图引擎
 *  - 输入：统计图配置（数据集/报表 + 维度 + 系列(统计方式) + 过滤 + 排序 + 样式）
 *  - 输出：标准 ECharts option（前端直接 setOption）
 *  - 支持图型：bar / bar_h / line / area / pie / doughnut / scatter / heatmap / funnel / radar / gauge
 *  - 统计方式可逐系列配置：计数 / 求和 / 平均值 / 最大值 / 最小值 / 去重计数
 */
const RE = require('./reportEngine');
const MET = require('./metricEngine');
const { q, one, num } = require('../db');

const PALETTES = {
  blue: ['#2ea6ff', '#5bbcff', '#8dd5ff', '#bfeaff', '#e2f6ff'],
  purple: ['#b452ff', '#c480ff', '#d5a4ff', '#e5c9ff', '#f4ebff'],
  green: ['#00c2a8', '#33d1b8', '#63decc', '#9feee0', '#cff8f3'],
  orange: ['#ff6a1a', '#ff9f45', '#ffc377', '#ffddb0', '#fff1d6'],
  teal: ['#00c2a8', '#33d6c2', '#66e4d3', '#a0f0e4', '#cff8f3'],
  red: ['#ff3b5c', '#ff6b85', '#ff94a8', '#ffc0cd', '#ffe2ea'],
  multi: ['#ff6a1a', '#ff4d8d', '#00c2a8', '#b452ff', '#ffd60a', '#2ea6ff', '#ff5c5c', '#7c3aed', '#33d6c2', '#ff9f45'],
  heat: ['#fff1e0', '#ffd9a8', '#ffb266', '#ff8f3c', '#ff6a1a', '#ff4d8d', '#b452ff']
};
const CHART_TYPES = [
  ['bar', '柱形图'], ['bar_h', '条形图'], ['line', '折线图'], ['area', '面积图'], ['pie', '饼图'],
  ['doughnut', '环形图'], ['scatter', '散点图'], ['heatmap', '热度图'], ['funnel', '漏斗图'],
  ['radar', '雷达图'], ['gauge', '仪表盘']
];

/** 枚举值 → 中文标签 */
function enumMap(enumStr) {
  const m = {};
  String(enumStr || '').split(',').forEach((pair) => {
    const [k, v] = pair.split(':');
    if (k) m[k.trim()] = (v || k).trim();
  });
  return m;
}

function labelOf(col, val) {
  if (val === null || val === undefined) return '-';
  const map = col && col.enum ? enumMap(col.enum) : null;
  return map && map[val] ? map[val] : String(val);
}

const fmtNum = (v, fmt) => {
  const n = num(v);
  if (fmt === 'percent') return (n * 100).toFixed(2) + '%';
  if (fmt === 'currency') return '¥' + n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
};

// ---------------------------------------------------------------- 取数
/**
 * 取统计图数据
 * @returns { kind:'cartesian'|'pie'|'scatter'|'heatmap'|'radar'|'gauge', ... }
 */
async function fetchChartData(widget, user) {
  const dims = widget.dimension_keys || [];
  const seriesConf = widget.series || [];
  const splitBys = [...new Set(seriesConf.map((s) => s.splitBy).filter(Boolean))];
  const extraDims = splitBys.filter((k) => !dims.includes(k));
  const dimsOverride = [...dims, ...extraDims];
  const res = await RE.runReport(widget.report_id, {
    dimsOverride,
    extraFilters: (widget.filters || []).filter((f) => f && f.fieldKey),
    sortStrategy: widget.sort_strategy || 'value_desc',
    limit: widget.limit_rows || 20,
    withTotal: false
  }, user);
  return { res, dims, extraDims, seriesConf };
}

// ---------------------------------------------------------------- 组装
function baseOption(widget, style) {
  const palette = PALETTES[style.palette] || PALETTES.blue;
  return {
    color: palette,
    backgroundColor: 'transparent',
    animationDuration: 600,
    grid: { left: 56, right: 24, top: style.legend === 'top' ? 44 : 24, bottom: 40, containLabel: true },
    legend: {
      show: widget.chart_type !== 'gauge' && widget.chart_type !== 'heatmap',
      type: 'scroll',
      top: style.legend === 'right' ? 'middle' : 4,
      right: style.legend === 'right' ? 8 : undefined,
      orient: style.legend === 'right' ? 'vertical' : 'horizontal',
      itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 12, color: '#4b5563' }
    },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, confine: true },
    textStyle: { fontFamily: 'Microsoft YaHei, PingFang SC, sans-serif' }
  };
}

function buildCartesian(widget, data) {
  const style = widget.style || {};
  const { res, dims, extraDims, seriesConf } = data;
  const dimCol = res.columns.find((c) => c.key === dims[0]);
  const splitCol = extraDims.length ? res.columns.find((c) => c.key === extraDims[0]) : null;
  const rows = res.rows;
  const catOf = (r) => dims.map((k) => labelOf(res.columns.find((c) => c.key === k), r[k])).join(' / ');
  const categories = [];
  const seen = new Set();
  rows.forEach((r) => { const c = catOf(r); if (!seen.has(c)) { seen.add(c); categories.push(c); } });

  let series = [];
  if (splitCol) {
    const main = seriesConf[0];
    const groups = [...new Set(rows.map((r) => labelOf(splitCol, r[splitCol.key])))];
    const idx = new Map(rows.map((r) => [`${catOf(r)}||${labelOf(splitCol, r[splitCol.key])}`, r]));
    series = groups.map((g) => ({
      name: g,
      type: widget.chart_type === 'line' || widget.chart_type === 'area' ? 'line' : 'bar',
      data: categories.map((c) => { const r = idx.get(`${c}||${g}`); return r ? num(r[main.key]) : null; }),
      smooth: !!style.smooth,
      areaStyle: widget.chart_type === 'area' ? { opacity: 0.25 } : undefined,
      stack: style.stack ? 'total' : undefined,
      label: { show: !!style.showLabel, position: 'top', formatter: (p) => fmtNum(p.value) }
    }));
  } else {
    const idx = new Map(rows.map((r) => [catOf(r), r]));
    series = seriesConf.map((s) => ({
      name: s.name || s.key,
      type: widget.chart_type === 'line' || widget.chart_type === 'area' ? 'line' : 'bar',
      data: categories.map((c) => { const r = idx.get(c); return r ? num(r[s.key]) : null; }),
      smooth: !!style.smooth,
      showSymbol: categories.length <= 60,
      areaStyle: widget.chart_type === 'area' ? { opacity: 0.25 } : undefined,
      stack: style.stack ? 'total' : undefined,
      barMaxWidth: 38,
      label: { show: !!style.showLabel, position: 'top', formatter: (p) => fmtNum(p.value) }
    }));
  }

  // 量纲差异大时启用双轴
  const maxOf = (s) => Math.max(...s.data.filter((v) => v != null).map((v) => Math.abs(v)), 0);
  const maxes = series.map(maxOf);
  const overall = Math.max(...maxes, 1);
  series.forEach((s, i) => { if (maxes[i] && maxes[i] * 10 < overall) s.yAxisIndex = 1; });
  const dual = series.some((s) => s.yAxisIndex === 1);

  const o = baseOption(widget, style);
  const horizontal = widget.chart_type === 'bar_h';
  const axisText = { color: '#6b7280', fontSize: 11 };
  const splitLine = { lineStyle: { color: '#eef1f6' } };
  const catAxis = { type: 'category', data: horizontal ? [...categories].reverse() : categories, axisLabel: { ...axisText, interval: 0, rotate: !horizontal && categories.length > 8 ? 30 : 0 }, axisTick: { show: false }, axisLine: { lineStyle: { color: '#e5e7eb' } } };
  const valAxis = { type: 'value', axisLabel: axisText, splitLine };
  o.xAxis = horizontal ? valAxis : catAxis;
  o.yAxis = horizontal ? catAxis : (dual ? [valAxis, { ...valAxis, splitLine: { show: false } }] : valAxis);
  o.series = horizontal ? series.map((s) => ({ ...s, data: [...s.data].reverse() })) : series;
  return o;
}

function buildPie(widget, data, doughnut) {
  const style = widget.style || {};
  const { res, dims, seriesConf } = data;
  const dimCol = res.columns.find((c) => c.key === dims[0]);
  const s = seriesConf[0];
  const o = baseOption(widget, style);
  o.tooltip = { trigger: 'item', formatter: '{b}: {c} ({d}%)' };
  o.series = [{
    type: 'pie',
    radius: doughnut ? ['42%', '68%'] : ['0%', '68%'],
    center: style.legend === 'right' ? ['38%', '52%'] : ['50%', '54%'],
    avoidLabelOverlap: true,
    itemStyle: { borderColor: '#fff', borderWidth: 2 },
    label: { show: true, fontSize: 11, color: '#4b5563', formatter: (p) => `${p.name}\n${fmtNum(p.value)} (${p.percent}%)` },
    data: res.rows.map((r) => ({ name: labelOf(dimCol, r[dimCol.key]), value: num(r[s.key]) }))
  }];
  return o;
}

function buildScatter(widget, data) {
  const style = widget.style || {};
  const { res, dims, seriesConf } = data;
  const dimCol = res.columns.find((c) => c.key === dims[0]);
  const [sx, sy] = seriesConf;
  const o = baseOption(widget, style);
  o.tooltip = { trigger: 'item', formatter: (p) => `${p.data[2]}<br/>${sx.name || sx.key}: ${fmtNum(p.data[0])}<br/>${sy.name || sy.key}: ${fmtNum(p.data[1])}` };
  o.xAxis = { type: 'value', name: sx.name || sx.key, axisLabel: { color: '#6b7280', fontSize: 11 }, splitLine: { lineStyle: { color: '#eef1f6' } } };
  o.yAxis = { type: 'value', name: sy.name || sy.key, axisLabel: { color: '#6b7280', fontSize: 11 }, splitLine: { lineStyle: { color: '#eef1f6' } } };
  o.series = [{
    type: 'scatter',
    symbolSize: (v) => Math.min(34, 8 + Math.sqrt(Math.abs(num(v[0]))) / 90),
    data: res.rows.map((r) => [num(r[sx.key]), num(r[sy.key]), labelOf(dimCol, r[dimCol.key])]),
    itemStyle: { opacity: 0.7 }
  }];
  return o;
}

function buildHeatmap(widget, data) {
  const style = widget.style || {};
  const { res, dims, seriesConf } = data;
  const [d0, d1] = dims;
  const c0 = res.columns.find((c) => c.key === d0);
  const c1 = res.columns.find((c) => c.key === d1);
  const s = seriesConf[0];
  const xs = [...new Set(res.rows.map((r) => labelOf(c0, r[c0.key])))];
  const ys = [...new Set(res.rows.map((r) => labelOf(c1, r[c1.key])))];
  const vals = res.rows.map((r) => [xs.indexOf(labelOf(c0, r[c0.key])), ys.indexOf(labelOf(c1, r[c1.key])), num(r[s.key])]);
  const maxV = Math.max(...vals.map((v) => v[2]), 1);
  const o = baseOption(widget, style);
  o.tooltip = { trigger: 'item', formatter: (p) => `${ys[p.data[1]]} / ${xs[p.data[0]]}<br/>${s.name || s.key}: ${fmtNum(p.data[2])}` };
  o.grid = { left: 70, right: 90, top: 20, bottom: 60, containLabel: true };
  o.xAxis = { type: 'category', data: xs, splitArea: { show: true }, axisLabel: { color: '#6b7280', fontSize: 11 } };
  o.yAxis = { type: 'category', data: ys, splitArea: { show: true }, axisLabel: { color: '#6b7280', fontSize: 11 } };
  o.visualMap = { min: 0, max: maxV, calculable: true, orient: 'vertical', right: 6, top: 'middle', inRange: { color: PALETTES[style.palette] || PALETTES.heat } };
  o.series = [{ type: 'heatmap', data: vals, label: { show: true, fontSize: 10, formatter: (p) => (p.data[2] >= 10000 ? (p.data[2] / 10000).toFixed(1) + 'w' : Math.round(p.data[2])) } }];
  return o;
}

function buildFunnel(widget, data) {
  const style = widget.style || {};
  const { res, dims, seriesConf } = data;
  const c0 = res.columns.find((c) => c.key === dims[0]);
  const s = seriesConf[0];
  const o = baseOption(widget, style);
  o.tooltip = { trigger: 'item', formatter: '{b}: {c}' };
  o.series = [{
    type: 'funnel',
    left: '12%', right: '12%', top: 30, bottom: 20,
    minSize: '22%',
    sort: 'descending',
    gap: 2,
    label: { show: true, position: 'inside', fontSize: 12, color: '#fff', formatter: (p) => `${p.name} ${fmtNum(p.value)}` },
    data: res.rows.map((r) => ({ name: labelOf(c0, r[c0.key]), value: num(r[s.key]) }))
  }];
  return o;
}

function buildRadar(widget, data) {
  const style = widget.style || {};
  const { res, dims, seriesConf } = data;
  const c0 = res.columns.find((c) => c.key === dims[0]);
  const cats = res.rows.map((r) => labelOf(c0, r[c0.key]));
  const indicators = seriesConf.map((s) => {
    const max = Math.max(...res.rows.map((r) => num(r[s.key])), 1);
    return { name: s.name || s.key, max: Math.ceil(max * 1.15) };
  });
  const o = baseOption(widget, style);
  o.tooltip = { trigger: 'item' };
  o.radar = { indicator: indicators, radius: '62%', center: ['50%', '54%'], splitArea: { areaStyle: { color: ['#fafbfe', '#f2f5fb'] } }, axisName: { color: '#4b5563', fontSize: 12 } };
  o.series = [{
    type: 'radar',
    areaStyle: { opacity: 0.15 },
    data: res.rows.map((r) => ({ value: seriesConf.map((s) => num(r[s.key])), name: labelOf(c0, r[c0.key]) }))
  }];
  return o;
}

async function buildGauge(widget) {
  const style = widget.style || {};
  const metric = widget.metric_id ? await one('select * from bi_metric where id = $1', [widget.metric_id]) : null;
  let value = 0; let label = widget.name;
  if (metric) {
    const from = RE.fmtDate(RE.addDays(RE.today(), -45));
    const to = RE.fmtDate(RE.addDays(RE.today(), -1));
    const series = await MET.valueSeries(metric.id, from, to);
    value = series.length ? series[series.length - 1].value : 0;
    label = metric.name;
    if ((widget.style || {}).target) value = value;
  }
  const target = num(style.target) || 0;
  const pct = target ? Math.min(100, (value / target) * 100) : 100;
  return {
    color: PALETTES[style.palette] || PALETTES.red,
    backgroundColor: 'transparent',
    series: [{
      type: 'gauge',
      startAngle: 210, endAngle: -30, min: 0, max: 100,
      radius: '92%', center: ['50%', '60%'],
      progress: { show: true, width: 14, roundCap: true },
      axisLine: { lineStyle: { width: 14, color: [[1, '#eef2f7']] } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      pointer: { show: false },
      title: { show: true, offsetCenter: [0, '32%'], fontSize: 12, color: '#6b7280' },
      detail: { valueAnimation: true, offsetCenter: [0, '-2%'], fontSize: 26, fontWeight: 600, color: '#111827', formatter: (v) => v.toFixed(1) + '%' },
      data: [{ value: Number(pct.toFixed(1)), name: target ? `${label}\n目标 ${fmtNum(target, 'currency')} · 实际 ${fmtNum(value, 'currency')}` : label }]
    }]
  };
}

/** 主入口 */
async function buildChart(widget, user) {
  const chartType = widget.chart_type || 'bar';
  if (chartType === 'gauge') {
    return { chartType, option: await buildGauge(widget), rows: [], columns: [] };
  }
  const data = await fetchChartData(widget, user);
  let option;
  if (['pie', 'doughnut'].includes(chartType)) option = buildPie(widget, data, chartType === 'doughnut');
  else if (chartType === 'scatter') option = buildScatter(widget, data);
  else if (chartType === 'heatmap') option = buildHeatmap(widget, data);
  else if (chartType === 'funnel') option = buildFunnel(widget, data);
  else if (chartType === 'radar') option = buildRadar(widget, data);
  else option = buildCartesian(widget, data);
  return {
    chartType,
    option,
    rows: data.res.rows,
    columns: data.res.columns,
    totalRows: data.res.rows.length,
    scope: data.res.scope
  };
}

module.exports = { buildChart, CHART_TYPES, PALETTES, enumMap, fmtNum };
