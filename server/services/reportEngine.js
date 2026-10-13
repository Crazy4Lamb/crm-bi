'use strict';
/**
 * 报表查询引擎
 *  - 所有 SQL 表达式只能来自 rpt_dataset_field 白名单（含 join 定义），
 *    用户在设计器里改字段/分组/排序/自定义公式都不会造成 SQL 注入
 *  - 支持：维度分组、度量聚合（计数/求和/平均/最大/最小/去重计数）、
 *          自定义字段公式、过滤、排序、合计行、分页、相对日期变量
 *  - 支持按角色数据范围（all/dept/self）自动收敛
 */
const { q, one, num, dateOnly, timestamp } = require('../db');

const AGG_FNS = ['none', 'sum', 'count', 'count_distinct', 'avg', 'max', 'min'];
const AGG_LABEL = { none: '不聚合', sum: '求和', count: '计数', count_distinct: '去重计数', avg: '平均值', max: '最大值', min: '最小值' };

const FUNC_WHITELIST = new Set(['case', 'when', 'then', 'else', 'end', 'coalesce', 'nullif', 'round', 'abs', 'cast', 'as',
  'int', 'integer', 'numeric', 'text', 'date', 'timestamp', 'concat', 'extract', 'year', 'month', 'day', 'date_trunc',
  'distinct', 'is', 'not', 'null', 'true', 'false', 'and', 'or', 'in', 'substring', 'to_char', 'least', 'greatest',
  'sum', 'count', 'avg', 'max', 'min', 'interval', 'between', 'like', 'from']);

// ---------------------------------------------------------------- 日期
function today() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: require('../config').tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type) => Number(parts.find((p) => p.type === type).value);
  return new Date(value('year'), value('month') - 1, value('day'));
}
const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

function resolveDateToken(v) {
  if (typeof v !== 'string' || v[0] !== '$') return v;
  const t = today();
  const up = v.toUpperCase();
  if (up === '$TODAY') return fmtDate(t);
  if (up === '$YESTERDAY') return fmtDate(addDays(t, -1));
  if (up === '$TOMORROW') return fmtDate(addDays(t, 1));
  if (up === '$MONTH_START') return fmtDate(new Date(t.getFullYear(), t.getMonth(), 1));
  if (up === '$MONTH_END') return fmtDate(new Date(t.getFullYear(), t.getMonth() + 1, 0));
  if (up === '$YEAR_START') return fmtDate(new Date(t.getFullYear(), 0, 1));
  let m = /^\$D(\d+)$/.exec(up);
  if (m) return fmtDate(addDays(t, -Number(m[1])));
  m = /^\$N(\d+)$/.exec(up);
  if (m) return fmtDate(addDays(t, Number(m[1])));
  return v;
}

// ---------------------------------------------------------------- 表达式安全校验
const stripLiterals = (expr) => String(expr).replace(/'(?:[^']|'')*'/g, "''");

/** 剥掉标识符/数字/运算符，只留下未预期的符号 */
function leftoverSymbols(expr) {
  return stripLiterals(expr)
    .replace(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/g, ' ')
    .replace(/\d+(?:\.\d+)?/g, ' ')
    .replace(/<=|>=|<>|!=|\|\||::|[-+*/%=<>(),\s]/g, '')
    .replace(/''/g, '');
}

function assertSafeExpr(expr, allowedAliases) {
  const raw = String(expr || '');
  if (/;|--|\/\*/.test(raw)) throw new Error('表达式包含非法字符：' + raw);
  const tokens = stripLiterals(raw).match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/g) || [];
  for (const tk of tokens) {
    if (tk.includes('.')) {
      const [alias, col] = tk.split('.');
      if (allowedAliases && allowedAliases.size && !allowedAliases.has(alias)) {
        throw new Error(`表达式引用了未授权的表别名 ${alias}（${raw}）`);
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(col)) throw new Error('非法列名：' + tk);
    } else if (!FUNC_WHITELIST.has(tk.toLowerCase())) {
      throw new Error(`表达式引用了未授权的标识符 ${tk}（${raw}）`);
    }
  }
  const rest = leftoverSymbols(raw);
  if (rest.trim() !== '') throw new Error('表达式包含不允许的符号：' + rest);
  return raw;
}

/** 只校验危险字符与非法符号，不校验标识符（用于自定义公式展开前） */
function assertSafeChars(expr) {
  const raw = String(expr || '');
  if (/;|--|\/\*/.test(raw)) throw new Error('公式包含非法字符：' + raw);
  const rest = leftoverSymbols(raw);
  if (rest.trim() !== '') throw new Error('公式包含不允许的符号：' + rest);
  return raw;
}

function expandCustom(expr, resolveKey, depth = 0) {
  if (depth > 3) throw new Error('自定义字段嵌套层级过深');
  assertSafeChars(expr);
  return String(expr).replace(/[A-Za-z_][A-Za-z0-9_]*/g, (tk) => {
    if (FUNC_WHITELIST.has(tk.toLowerCase())) return tk;
    const sql = resolveKey(tk, depth);
    if (sql == null) throw new Error(`自定义字段引用了未知字段：${tk}`);
    return sql;
  });
}

// ---------------------------------------------------------------- 加载定义
async function loadReport(reportId) {
  const report = await one('select * from rpt_report where id = $1', [reportId]);
  if (!report) throw new Error('报表不存在：' + reportId);
  const ds = await one('select * from rpt_dataset where id = $1', [report.dataset_id]);
  const dsFields = (await q('select * from rpt_dataset_field where dataset_id = $1 order by sort_no, id', [ds.id])).rows;
  const rptFields = (await q('select * from rpt_report_field where report_id = $1 order by sort_no, id', [report.id])).rows;
  const filters = (await q('select * from rpt_report_filter where report_id = $1 order by sort_no, id', [report.id])).rows;
  const allowedAliases = new Set([ds.base_alias || 't']);
  // join 定义也做安全校验，别名只能引用已声明的
  for (const j of (ds.joins || [])) {
    assertSafeExpr(j.on, new Set([...allowedAliases, j.alias]));
    if (!/^[a-z_][a-z0-9_]*$/i.test(j.table) || !/^[a-z_][a-z0-9_]*$/i.test(j.alias)) throw new Error('非法 join 定义');
    allowedAliases.add(j.alias);
  }
  const dsMap = new Map(dsFields.map((f) => [f.field_key, f]));
  const rptMap = new Map(rptFields.map((f) => [f.field_key, f]));
  return { report, ds, dsFields, dsMap, rptFields, rptMap, filters, allowedAliases };
}

const aggSql = (expr, agg) => {
  switch (agg) {
    case 'sum': return `sum(${expr})`;
    case 'avg': return `avg(${expr})`;
    case 'max': return `max(${expr})`;
    case 'min': return `min(${expr})`;
    case 'count': return expr === '*' ? 'count(*)' : `count(${expr})`;
    case 'count_distinct': return expr === '*' ? 'count(*)' : `count(distinct ${expr})`;
    default: return expr;
  }
};

function fieldExpr(ctx, f, forAgg) {
  const { dsMap, rptMap, allowedAliases } = ctx;
  if (f.is_custom) {
    const sql = expandCustom(f.custom_expr, (key) => {
      const ref = rptMap.get(key);
      if (!ref || ref.field_key === f.field_key) return null;
      const inner = fieldExpr(ctx, ref, true);
      // 度量参与四则运算时统一转 numeric，避免 PostgreSQL 整数除法（3/6=0）
      const numeric = ref.field_role === 'measure' || isAggSql(inner);
      return numeric ? `((${inner})::numeric)` : `(${inner})`;
    });
    return assertSafeExpr(sql, allowedAliases);
  }
  const base = f.dataset_field_key ? dsMap.get(f.dataset_field_key) : null;
  if (!base) {
    if (f.agg_fn === 'count' || f.agg_fn === 'count_distinct') return 'count(*)';
    throw new Error(`字段 ${f.field_key} 未绑定数据集字段`);
  }
  const expr = assertSafeExpr(base.expr, allowedAliases);
  const agg = forAgg === false ? 'none' : (f.agg_fn || 'none');
  return agg !== 'none' ? aggSql(expr, agg) : expr;
}

const isAggSql = (sql) => /\b(sum|count|avg|max|min)\s*\(/i.test(sql);

/** 执行 SQL 并在报错时带上 SQL 上下文（便于排查与前端展示） */
async function execSql(sql, params) {
  try {
    return await q(sql, params);
  } catch (e) {
    const err = new Error(e.message + '\nSQL: ' + sql + (params && params.length ? '\nPARAMS: ' + JSON.stringify(params) : ''));
    err.sql = sql;
    throw err;
  }
}

/** 维度字段的原始表达式（用于分组/过滤） */
function dimExpr(ctx, f) {
  if (f.is_custom) return fieldExpr(ctx, f, true);
  const base = f.dataset_field_key ? ctx.dsMap.get(f.dataset_field_key) : null;
  if (!base) throw new Error(`字段 ${f.field_key} 未绑定数据集字段`);
  return assertSafeExpr(base.expr, ctx.allowedAliases);
}

// ---------------------------------------------------------------- 过滤
const OPS = {
  eq: (e, i, c) => ({ sql: `${e} = $${i}`, values: [c.value] }),
  ne: (e, i, c) => ({ sql: `${e} <> $${i}`, values: [c.value] }),
  gt: (e, i, c) => ({ sql: `${e} > $${i}`, values: [c.value] }),
  ge: (e, i, c) => ({ sql: `${e} >= $${i}`, values: [c.value] }),
  lt: (e, i, c) => ({ sql: `${e} < $${i}`, values: [c.value] }),
  le: (e, i, c) => ({ sql: `${e} <= $${i}`, values: [c.value] }),
  like: (e, i, c) => ({ sql: `cast(${e} as text) like $${i}`, values: [`%${c.value}%`] }),
  notlike: (e, i, c) => ({ sql: `cast(${e} as text) not like $${i}`, values: [`%${c.value}%`] }),
  in: (e, i, c) => {
    const items = String(c.value).split(',').map((s) => s.trim()).filter(Boolean);
    if (!items.length) return { sql: '1=1', values: [] };
    return { sql: `${e} in (${items.map((_, k) => `$${i + k}`).join(',')})`, values: items };
  },
  notin: (e, i, c) => {
    const items = String(c.value).split(',').map((s) => s.trim()).filter(Boolean);
    if (!items.length) return { sql: '1=1', values: [] };
    return { sql: `${e} not in (${items.map((_, k) => `$${i + k}`).join(',')})`, values: items };
  },
  between: (e, i, c) => ({ sql: `${e} between $${i} and $${i + 1}`, values: [resolveDateToken(c.value), resolveDateToken(c.value2)] }),
  isnull: (e) => ({ sql: `${e} is null`, values: [] }),
  notnull: (e) => ({ sql: `${e} is not null`, values: [] })
};
const OP_LIST = [
  ['eq', '等于'], ['ne', '不等于'], ['gt', '大于'], ['ge', '大于等于'], ['lt', '小于'], ['le', '小于等于'],
  ['like', '包含'], ['notlike', '不包含'], ['in', '属于'], ['notin', '不属于'], ['between', '区间'], ['isnull', '为空'], ['notnull', '不为空']
];

function buildWhere(ctx, conds, params) {  const parts = [];
  let first = true;
  conds.forEach((c) => {
    if (!c || !c.op || !c.fieldKey) return;
    const op = String(c.op).toLowerCase();
    const fn = OPS[op];
    if (!fn) throw new Error('不支持的过滤操作符：' + c.op);
    const rpt = ctx.rptMap.get(c.fieldKey);
    let expr;
    if (rpt && rpt.is_custom) throw new Error(`自定义字段「${rpt.field_name}」不支持作为过滤条件`);
    if (rpt) expr = dimExpr(ctx, rpt);
    else {
      const b = ctx.dsMap.get(c.fieldKey);
      if (!b) throw new Error('过滤字段不存在：' + c.fieldKey);
      expr = assertSafeExpr(b.expr, ctx.allowedAliases);
    }
    const cond = { ...c };
    if (cond.value !== undefined && cond.value !== null && cond.value !== '') {
      cond.value = (rpt && rpt.field_type === 'date') ? resolveDateToken(String(c.value)) : c.value;
    }
    const built = fn(expr, params.length + 1, cond);
    if (built.values.length) params.push(...built.values);
    const logic = first ? '' : ((c.logic || 'and').toUpperCase() === 'OR' ? ' or ' : ' and ');
    first = false;
    parts.push(logic + built.sql);
  });
  return parts.join('');
}

/** 拼接 where：主条件 + 数据范围条件，去掉多余的前导 and/or */
function joinWhere(where, scopeSql) {
  const parts = [where || '', scopeSql || '']
    .map((s) => String(s).replace(/^\s*(and|or)\s*/i, '').trim())
    .filter(Boolean);
  return parts.length ? ' where ' + parts.join(' and ') : '';
}

// ---------------------------------------------------------------- 数据范围
function effectiveScope(user, widgetScope) {
  if (!user) return 'global';
  const u = user.dataScope || 'self';
  if (u === 'self') return 'self';
  if (widgetScope === 'self') return 'self';
  if (u === 'dept') return widgetScope === 'global' && user.allowGlobal ? 'global' : 'dept';
  if (widgetScope === 'dept') return 'dept';
  return 'global';
}

function scopeCondition(ctx, user, widgetScope, params) {
  const scope = effectiveScope(user, widgetScope);
  if (scope === 'global') return '';
  const key = scope === 'self' ? ctx.ds.owner_field : ctx.ds.dept_field;
  const f = key ? ctx.dsMap.get(key) : null;
  if (!f) return '';
  const expr = assertSafeExpr(f.expr, ctx.allowedAliases);
  if (scope === 'self') {
    params.push(user.id);
    return ` and ${expr} = $${params.length}`;
  }
  params.push(user.dept);
  return ` and ${expr} = $${params.length}`;
}

// ---------------------------------------------------------------- 构建
function buildQuery(ctx, opts = {}, user = null) {
  const { ds } = ctx;
  const params = [];
  const joins = (ds.joins || []).map((j) => `${j.type || 'left'} join ${j.table} ${j.alias} on ${j.on}`).join(' ');

  let fields = ctx.rptFields.filter((f) => f.is_show !== false);
  if (opts.fieldKeys && opts.fieldKeys.length) fields = opts.fieldKeys.map((k) => ctx.rptMap.get(k)).filter(Boolean);
  if (opts.dimsOverride && opts.dimsOverride.length) {
    const dims = opts.dimsOverride.map((k) => ctx.rptMap.get(k)).filter(Boolean);
    const dimKeys = new Set(dims.map((d) => d.field_key));
    const measures = ctx.rptFields.filter((f) => f.field_role === 'measure' && !dimKeys.has(f.field_key));
    const extra = (opts.extraMeasures || []).map((k) => ctx.rptMap.get(k)).filter((f) => f && !dimKeys.has(f.field_key));
    fields = [...dims, ...extra, ...measures];
  }

  const cols = [];
  const groupBy = [];
  const colMeta = [];
  let hasAgg = false;
  for (const f of fields) {
    const sql = fieldExpr(ctx, f, true);
    const aggExpr = isAggSql(sql);
    if (aggExpr) hasAgg = true;
    cols.push(`${sql} as "${f.field_key}"`);
    if (!aggExpr) groupBy.push(sql);
    const dsField = f.dataset_field_key ? ctx.dsMap.get(f.dataset_field_key) : null;
    colMeta.push({
      key: f.field_key, name: f.field_name, type: f.field_type, role: f.field_role,
      fmt: f.fmt, agg: f.agg_fn, aggLabel: AGG_LABEL[f.agg_fn] || f.agg_fn,
      isCustom: !!f.is_custom, groupBy: !!f.is_group_by, width: f.width,
      enum: dsField ? dsField.enum_options : null,
      expr: f.is_custom ? f.custom_expr : (dsField ? dsField.expr : null)
    });
  }

  const conds = [...(ctx.filters || []).map((f) => ({ fieldKey: f.field_key, op: f.op, value: f.value, value2: f.value2, logic: f.logic })),
  ...(opts.extraFilters || [])];
  if (opts.dateRange) {
    const df = ds.date_field ? ctx.rptMap.get(ds.date_field) : null;
    if (df) {
      conds.push({ fieldKey: df.field_key, op: 'ge', value: opts.dateRange.from });
      conds.push({ fieldKey: df.field_key, op: 'le', value: opts.dateRange.to });
    }
  }
  const where = buildWhere(ctx, conds, params);
  const scopeSql = scopeCondition(ctx, user, opts.scope, params);
  const whereSql = joinWhere(where, scopeSql);

  const selectedKeys = new Set(fields.map((f) => f.field_key));
  const orders = [];
  if (opts.orderBy && opts.orderBy.length) {
    opts.orderBy.forEach((o) => {
      const f = ctx.rptMap.get(o.key);
      if (!f || !selectedKeys.has(f.field_key)) return;
      const dir = String(o.dir).toLowerCase() === 'desc' ? 'desc' : 'asc';
      orders.push(`"${f.field_key}" ${dir}`);
    });
  } else {
    // 报表默认排序：只对当前查询真正选中的字段生效
    ctx.rptFields.filter((f) => f.sort_dir && f.sort_dir !== 'none' && selectedKeys.has(f.field_key)).forEach((f) => {
      if (opts.sortStrategy && opts.sortStrategy !== 'axis') return;
      orders.push(`"${f.field_key}" ${f.sort_dir === 'desc' ? 'desc' : 'asc'}`);
    });
    const fm = fields.find((f) => f.field_role === 'measure');
    if (opts.sortStrategy === 'value_desc' && fm) orders.unshift(`"${fm.field_key}" desc nulls last`);
    else if (opts.sortStrategy === 'value_asc' && fm) orders.unshift(`"${fm.field_key}" asc nulls last`);
  }
  const groupSql = hasAgg && groupBy.length ? ` group by ${groupBy.join(', ')}` : '';
  const orderSql = orders.length ? ` order by ${orders.join(', ')}` : '';
  const baseSql = `select ${cols.join(', ')} from ${ds.base_table} ${ds.base_alias || 't'} ${joins}${whereSql}${groupSql}${orderSql}`;
  let limitSql = '';
  if (opts.limit) { params.push(Number(opts.limit)); limitSql += ` limit $${params.length}`; }
  if (opts.offset) { params.push(Number(opts.offset)); limitSql += ` offset $${params.length}`; }

  return { sql: baseSql + limitSql, baseSql, params, columns: colMeta, grouped: !!groupSql, hasAgg, whereSql, joins, groupSql };
}

function normalizeRows(rows, columns) {
  return rows.map((r) => {
    const o = {};
    for (const c of columns) {
      const v = r[c.key];
      if (v === null || v === undefined) { o[c.key] = null; continue; }
      if (c.type === 'date') o[c.key] = dateOnly(v);
      else if (c.type === 'datetime') o[c.key] = timestamp(v);
      else if (c.type === 'number') o[c.key] = num(v);
      else o[c.key] = v;
    }
    return o;
  });
}

/** 合计行 */
async function computeTotal(ctx, opts, user, columns) {
  const { ds } = ctx;
  const params = [];
  const joins = (ds.joins || []).map((j) => `${j.type || 'left'} join ${j.table} ${j.alias} on ${j.on}`).join(' ');
  const conds = [...(ctx.filters || []).map((f) => ({ fieldKey: f.field_key, op: f.op, value: f.value, value2: f.value2, logic: f.logic })),
  ...(opts.extraFilters || [])];
  if (opts.dateRange) {
    const df = ds.date_field ? ctx.rptMap.get(ds.date_field) : null;
    if (df) {
      conds.push({ fieldKey: df.field_key, op: 'ge', value: opts.dateRange.from });
      conds.push({ fieldKey: df.field_key, op: 'le', value: opts.dateRange.to });
    }
  }
  const where = buildWhere(ctx, conds, params);
  const scopeSql = scopeCondition(ctx, user, opts.scope, params);
  const whereSql = joinWhere(where, scopeSql);
  const cols = columns.map((c) => {
    const f = ctx.rptMap.get(c.key);
    if (!f) return `count(*) as "${c.key}"`;
    const sql = fieldExpr(ctx, f, true);
    return isAggSql(sql) ? `${sql} as "${c.key}"` : `count(*) as "${c.key}"`;
  });
  const sql = `select ${cols.join(', ')} from ${ds.base_table} ${ds.base_alias || 't'} ${joins}${whereSql}`;
  const res = await execSql(sql, params);
  return { row: res.rows[0] || null, sql };
}

// ---------------------------------------------------------------- 对外
async function runReport(reportId, opts = {}, user = null) {
  const ctx = await loadReport(reportId);
  const built = buildQuery(ctx, opts, user);
  const res = await execSql(built.sql, built.params);
  const rows = normalizeRows(res.rows, built.columns);
  let totalRows = rows.length;
  if (opts.limit) {
    const cntSql = `select count(*)::int as c from (${built.baseSql}) x`;
    const drop = (opts.limit ? 1 : 0) + (opts.offset ? 1 : 0);
    const cnt = await execSql(cntSql, built.params.slice(0, built.params.length - drop));
    totalRows = cnt.rows[0] ? num(cnt.rows[0].c) : rows.length;
  }
  let total = null;
  if (opts.withTotal !== false && built.hasAgg) {
    const t = await computeTotal(ctx, opts, user, built.columns);
    total = t.row ? normalizeRows([t.row], built.columns)[0] : null;
  }
  return {
    report: { id: ctx.report.id, code: ctx.report.code, name: ctx.report.name, category: ctx.report.category, description: ctx.report.description },
    dataset: { id: ctx.ds.id, code: ctx.ds.code, name: ctx.ds.name, dateField: ctx.ds.date_field },
    columns: built.columns, rows, total, grouped: built.grouped, hasAgg: built.hasAgg,
    totalRows, page: opts.page || 1, pageSize: opts.limit || null,
    scope: effectiveScope(user, opts.scope), sql: built.sql
  };
}

/** 单值聚合（卡片/指标用）：把报表聚合成一个标量 */
async function aggregateValue(reportId, opts = {}, user = null) {
  const ctx = await loadReport(reportId);
  const built = buildQuery(ctx, { ...opts, limit: 0 }, user);
  if (!built.columns.length) return 0;
  const key = (opts.series && opts.series[0] && opts.series[0].key) || built.columns[0].key;
  const col = built.columns.find((c) => c.key === key) || built.columns[0];
  const inner = built.sql;
  const agg = (opts.series && opts.series[0] && opts.series[0].agg) || (col.agg && col.agg !== 'none' ? col.agg : 'sum');
  const directAgg = ['sum', 'avg', 'max', 'min', 'count_distinct', 'count'].includes(agg) ? agg : 'sum';
  const fn = directAgg === 'count_distinct' ? null : directAgg;
  const alias = `"${col.key}"`;
  // 单行结果直接取值；多行（分组）则外层再聚合一次
  const outer = opts.noRollup
    ? `select ${alias} as v from (${inner}) x limit 1`
    : `select ${fn ? `${fn}(${alias})` : `count(distinct ${alias})`} as v from (${inner}) x`;
  const res = await execSql(outer, built.params);
  return { value: num(res.rows[0] && res.rows[0].v), sql: outer, params: built.params, columns: built.columns };
}

module.exports = {
  loadReport, buildQuery, runReport, aggregateValue, computeTotal, normalizeRows, fieldExpr, dimExpr,
  expandCustom, assertSafeExpr, resolveDateToken, effectiveScope, isAggSql,
  today, fmtDate, addDays, AGG_FNS, AGG_LABEL, OP_LIST
};
