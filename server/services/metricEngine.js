'use strict';
/**
 * 指标引擎
 *  - 指标 = 报表数据 + 聚合口径 + 日期口径，按数据日（stat_date）落库 bi_metric_value
 *  - T+1：默认计算「前一天」的数据；date_offset=N 表示回算最近 N 天
 *  - day 口径可一次查询算出一段区间（group by 日期），多日累计口径（mtd/month/...）按日单独计算
 */
const { q, one, many, num, dateOnly } = require('../db');
const RE = require('./reportEngine');
const { rangeOf, prevRangeOf, growth } = require('./periods');

const { fmtDate, addDays, today } = RE;

/** 取指标的目标过滤条件 */
function metricFilters(metric) {
  return (metric.filters || []).filter((f) => f && f.fieldKey)
    .map((f) => ({ fieldKey: f.fieldKey, op: f.op || 'eq', value: f.value, value2: f.value2 }));
}

/** 计算某个指标在给定日期上的取值 */
async function computeMetricAt(metric, statDate, user) {
  const dateKey = metric.date_field_key;
  const mode = metric.date_mode || 'day';
  const range = rangeOf(mode === 'day' ? 'day' : mode, statDate);
  const opts = {
    dimsOverride: [dateKey],
    extraFilters: metricFilters(metric),
    withTotal: false,
    scope: metric.scope || 'global',
    series: [{ key: metric.measure_key, agg: metric.agg_fn }]
  };
  if (range) opts.dateRange = range;
  const r = await RE.aggregateValue(metric.report_id, opts, user);
  return { value: num(r.value), range, sql: r.sql };
}

/**
 * 批量计算一段区间的指标值（day 口径一次查询搞定）
 * @returns [{statDate, value}]
 */
async function computeMetricSeries(metric, fromDate, toDate, user) {
  const mode = metric.date_mode || 'day';
  if (mode !== 'day') {
    const out = [];
    let d = new Date(fromDate + 'T00:00:00');
    const end = new Date(toDate + 'T00:00:00');
    while (d <= end) {
      const s = fmtDate(d);
      const r = await computeMetricAt(metric, s, user);
      out.push({ statDate: s, value: r.value });
      d = addDays(d, 1);
    }
    return out;
  }
  const dateKey = metric.date_field_key;
  const res = await RE.runReport(metric.report_id, {
    dimsOverride: [dateKey],
    extraFilters: metricFilters(metric),
    dateRange: { from: fromDate, to: toDate },
    withTotal: false,
    orderBy: [{ key: dateKey, dir: 'asc' }]
  }, user);
  const col = res.columns.find((c) => c.key === metric.measure_key) || res.columns.find((c) => c.role === 'measure');
  const norm = RE.normalizeRows(res.rows, res.columns);
  return norm.map((r) => ({ statDate: r[dateKey], value: col ? num(r[col.key]) : 0 }));
}

/** 计算 + 落库（含环比前值） */
async function persistMetric(metric, dates, opts = {}) {
  const user = opts.user || null;
  let rows = 0;
  const detail = [];
  const sorted = [...dates].sort();
  const from = sorted[0];
  const to = sorted[sorted.length - 1];
  const series = await computeMetricSeries(metric, from, to, user);
  const map = new Map(series.map((s) => [s.statDate, s.value]));
  for (const d of sorted) {
    if (!map.has(d)) map.set(d, 0);
  }
  for (const d of sorted) {
    const value = map.get(d);
    const prev = await one('select value from bi_metric_value where metric_id = $1 and stat_date < $2 order by stat_date desc limit 1', [metric.id, d]);
    await q(
      `insert into bi_metric_value (metric_id, stat_date, value, prev_value, calc_time, task_log_id)
       values ($1,$2,$3,$4, now(), $5)
       on conflict (metric_id, stat_date) do update set value = excluded.value, prev_value = excluded.prev_value, calc_time = now(), task_log_id = excluded.task_log_id`,
      [metric.id, d, value, prev ? num(prev.value) : null, opts.taskLogId || null]
    );
    rows++;
    detail.push({ statDate: d, value });
  }
  return { rows, detail };
}

/** 任务执行：T+N 计算 */
async function runTask(task, opts = {}) {
  const started = new Date();
  const logRow = await one(
    `insert into bi_task_log (task_id, task_code, stat_date, start_time, status, trigger_by)
     values ($1,$2,$3, now(), 'running', $4) returning id`,
    [task.id, task.code, null, opts.triggerBy || 'schedule']
  );
  const logId = logRow.id;
  const messages = [];
  let totalRows = 0;
  try {
    const target = task.target || {};
    let metrics;
    if (target.metricIds && target.metricIds.length) {
      metrics = await many('select * from bi_metric where id = any($1::int[]) order by id', [target.metricIds]);
    } else {
      metrics = await many("select * from bi_metric where status = '1' order by id");
    }
    const base = opts.statDate ? new Date(opts.statDate + 'T00:00:00') : today();
    let dates;
    if (opts.statDate) dates = [opts.statDate];
    else {
      const n = Math.max(1, Number(task.date_offset != null ? task.date_offset : 1));
      dates = [];
      for (let i = 1; i <= n; i++) dates.push(fmtDate(addDays(base, -i)));   // T+1：前一天
    }
    for (const m of metrics) {
      const r = await persistMetric(m, dates, { user: opts.user, taskLogId: logId });
      totalRows += r.rows;
      messages.push(`${m.name}(${m.code}) 计算 ${r.rows} 天`);
    }
    const end = new Date();
    await q(`update bi_task_log set end_time = now(), status = 'success', rows_affected = $1, message = $2, stat_date = $3 where id = $4`,
      [totalRows, messages.join('; ') || '无指标', dates[dates.length - 1], logId]);
    await q(`update bi_task set last_run_at = now(), last_status = 'success', updated_at = now() where id = $1`, [task.id]);
    return { ok: true, logId, rows: totalRows, dates, metrics: metrics.length, durationMs: end - started, messages };
  } catch (e) {
    await q(`update bi_task_log set end_time = now(), status = 'failed', rows_affected = $1, message = $2 where id = $3`, [totalRows, String(e.message || e), logId]);
    await q(`update bi_task set last_run_at = now(), last_status = 'failed', updated_at = now() where id = $1`, [task.id]);
    return { ok: false, logId, rows: totalRows, error: String(e.message || e), durationMs: new Date() - started };
  }
}

/** 指标当前值（驾驶舱卡片用）：取最近可用数据日 */
async function latestValue(metricId, statDate) {
  const row = statDate
    ? await one('select * from bi_metric_value where metric_id = $1 and stat_date = $2', [metricId, statDate])
    : await one('select * from bi_metric_value where metric_id = $1 order by stat_date desc limit 1', [metricId]);
  return row || null;
}

/** 指标区间序列（卡片迷你趋势图） */
async function valueSeries(metricId, from, to) {
  const rows = await many('select stat_date, value from bi_metric_value where metric_id = $1 and stat_date between $2 and $3 order by stat_date', [metricId, from, to]);
  return rows.map((r) => ({ date: dateOnly(r.stat_date), value: num(r.value) }));
}

module.exports = { computeMetricAt, computeMetricSeries, persistMetric, runTask, latestValue, valueSeries, metricFilters };

// 供卡片引擎复用的区间工具
module.exports.rangeOf = rangeOf;
module.exports.prevRangeOf = prevRangeOf;
module.exports.growth = growth;
