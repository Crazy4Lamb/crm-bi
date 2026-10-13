'use strict';
/**
 * 报表中心
 *  - 浏览：任意报表按配置执行（分组/排序/聚合/过滤/合计/分页/导出）
 *  - 设计：新建、编辑（字段增删改、自定义字段公式、过滤条件、排序）
 */
const express = require('express');
const { q, one, many, num } = require('../db');
const acl = require('../services/acl');
const RE = require('../services/reportEngine');

const router = express.Router();

async function ensureDesign(req, res) {
  const p = await acl.perms(req.user.role);
  if (req.user.role !== 'admin' && !acl.can(p, 'action', 'report:design')) {
    res.status(403).json({ code: 403, message: '无权限：需要「报表设计」权限' });
    return false;
  }
  return true;
}

// 设计器元数据
router.get('/meta', async (req, res) => {
  const datasets = await many('select id, code, name, base_table, date_field, owner_field, dept_field, description from rpt_dataset where status = \'1\' order by id');
  const fields = await many('select * from rpt_dataset_field order by dataset_id, sort_no, id');
  res.json({
    code: 0, data: {
      datasets: datasets.map((d) => ({ ...d, fields: fields.filter((f) => f.dataset_id === d.id) })),
      aggs: RE.AGG_FNS.map((a) => ({ value: a, label: RE.AGG_LABEL[a] })),
      ops: RE.OP_LIST.map((o) => ({ value: o[0], label: o[1] })),
      categories: ['销售', '客户', '线索', '合同', '订单', '产品', '财务'],
      fieldTypes: [['string', '文本'], ['number', '数值'], ['date', '日期'], ['datetime', '时间'], ['bool', '布尔']],
      roles: [['dimension', '维度'], ['measure', '度量']],
      formats: [[null, '默认'], ['number', '整数'], ['currency', '金额'], ['percent', '百分比']]
    }
  });
});

// 报表列表
router.get('/list', async (req, res) => {
  const rows = await many(`select r.*, d.name as dataset_name, d.code as dataset_code,
      (select count(*)::int from rpt_report_field f where f.report_id = r.id) as field_count
    from rpt_report r join rpt_dataset d on d.id = r.dataset_id order by r.category, r.id`);
  res.json({ code: 0, data: rows });
});

// 报表定义
router.get('/:id(\\d+)', async (req, res) => {
  const ctx = await RE.loadReport(Number(req.params.id));
  res.json({
    code: 0, data: {
      report: ctx.report,
      dataset: ctx.ds,
      fields: ctx.rptFields,
      filters: ctx.filters,
      columnMeta: ctx.rptFields.map((f) => ({
        key: f.field_key, name: f.field_name, type: f.field_type, role: f.field_role, agg: f.agg_fn,
        aggLabel: RE.AGG_LABEL[f.agg_fn], fmt: f.fmt, isCustom: f.is_custom, groupBy: f.is_group_by, width: f.width
      }))
    }
  });
});

// 执行报表
router.post('/run', async (req, res) => {
  const b = req.body || {};
  if (!b.reportId) return res.status(400).json({ code: 400, message: '缺少 reportId' });
  const opts = {
    fieldKeys: b.fieldKeys && b.fieldKeys.length ? b.fieldKeys : null,
    dimsOverride: b.dims && b.dims.length ? b.dims : null,
    extraFilters: (b.filters || []).filter((f) => f && f.fieldKey),
    orderBy: b.orderBy || [],
    sortStrategy: b.sortStrategy || null,
    limit: Number(b.size || b.limit || 0) || null,
    offset: b.page && b.size ? (Number(b.page) - 1) * Number(b.size) : null,
    page: Number(b.page || 1),
    withTotal: b.withTotal !== false,
    scope: b.scope || 'global',
    dateRange: b.dateRange || null
  };
  const r = await RE.runReport(Number(b.reportId), opts, req.user);
  res.json({ code: 0, data: r });
});

// 导出 CSV
router.get('/:id(\\d+)/export', async (req, res) => {
  const r = await RE.runReport(Number(req.params.id), { withTotal: false, scope: req.query.scope || 'global' }, req.user);
  const head = r.columns.map((c) => c.name).join(',');
  const lines = r.rows.map((row) => r.columns.map((c) => {
    const v = row[c.key];
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(','));
  const csv = '\ufeff' + [head, ...lines].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="report_${req.params.id}.csv"`);
  res.send(csv);
});

// 新建报表
router.post('/', async (req, res) => {
  if (!(await ensureDesign(req, res))) return;
  const b = req.body || {};
  if (!b.name || !b.datasetId) return res.status(400).json({ code: 400, message: '报表名称与数据集必填' });
  const code = b.code || 'rpt_' + Date.now().toString(36);
  const row = await one(`insert into rpt_report (code, name, category, dataset_id, description, owner_id, status, is_public)
    values ($1,$2,$3,$4,$5,$6,'1',true) returning id`,
    [code, b.name, b.category || '自定义', Number(b.datasetId), b.description || null, req.user.id]);
  res.json({ code: 0, data: { id: row.id, code }, message: '报表已创建，请继续设计字段' });
});

// 保存报表（含字段与过滤）
router.put('/:id(\\d+)', async (req, res) => {
  if (!(await ensureDesign(req, res))) return;
  const id = Number(req.params.id);
  const report = await one('select * from rpt_report where id = $1', [id]);
  if (!report) return res.status(404).json({ code: 404, message: '报表不存在' });
  const b = req.body || {};
  const ctx = await RE.loadReport(id);

  // 字段定义校验
  const fields = Array.isArray(b.fields) ? b.fields : null;
  const seen = new Set();
  if (fields) {
    for (const f of fields) {
      if (!f.fieldKey || !/^[a-z_][a-z0-9_]*$/i.test(f.fieldKey)) return res.status(400).json({ code: 400, message: `字段标识非法：${f.fieldKey}` });
      if (seen.has(f.fieldKey)) return res.status(400).json({ code: 400, message: `字段标识重复：${f.fieldKey}` });
      seen.add(f.fieldKey);
      if (f.isCustom) {
        try {
          RE.expandCustom(f.customExpr, (key) => {
            const ref = fields.find((x) => x.fieldKey === key && !x.isCustom) || ctx.rptMap.get(key);
            if (!ref) return null;
            return '(1)';
          });
        } catch (e) { return res.status(400).json({ code: 400, message: `自定义字段「${f.fieldName}」公式有误：${e.message}` }); }
      } else if (!ctx.dsMap.has(f.datasetFieldKey)) {
        return res.status(400).json({ code: 400, message: `字段「${f.fieldName}」引用了不存在的数据集字段：${f.datasetFieldKey}` });
      }
    }
  }
  // 过滤校验
  if (Array.isArray(b.filters)) {
    for (const f of b.filters) {
      const isDs = ctx.dsMap.has(f.fieldKey);
      const isRpt = ctx.rptMap.has(f.fieldKey) || (fields && fields.some((x) => x.fieldKey === f.fieldKey));
      if (!isDs && !isRpt) return res.status(400).json({ code: 400, message: `过滤字段不存在：${f.fieldKey}` });
      if (!f.op) return res.status(400).json({ code: 400, message: '过滤条件缺少操作符' });
    }
  }

  await q(`update rpt_report set name = coalesce($1,name), category = coalesce($2,category), description = coalesce($3,description),
      is_public = coalesce($4,is_public), updated_at = now() where id = $5`,
    [b.name || null, b.category || null, b.description !== undefined ? b.description : null, b.isPublic === undefined ? null : !!b.isPublic, id]);

  if (fields) {
    await q('delete from rpt_report_field where report_id = $1', [id]);
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      await q(`insert into rpt_report_field (report_id, field_key, field_name, field_type, field_role, dataset_field_key, agg_fn,
          custom_expr, is_group_by, is_show, is_custom, sort_dir, fmt, width, sort_no)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, f.fieldKey, f.fieldName || f.fieldKey, f.fieldType || 'string', f.fieldRole || 'dimension',
          f.isCustom ? null : (f.datasetFieldKey || null), f.aggFn || 'none', f.isCustom ? f.customExpr : null,
          !!f.isGroupBy, f.isShow !== false, !!f.isCustom, f.sortDir || 'none', f.fmt || null, Number(f.width || 140), (i + 1) * 10]);
    }
  }
  if (Array.isArray(b.filters)) {
    await q('delete from rpt_report_filter where report_id = $1', [id]);
    for (let i = 0; i < b.filters.length; i++) {
      const f = b.filters[i];
      await q('insert into rpt_report_filter (report_id, field_key, op, value, value2, logic, sort_no) values ($1,$2,$3,$4,$5,$6,$7)',
        [id, f.fieldKey, f.op, f.value == null ? null : String(f.value), f.value2 == null ? null : String(f.value2), f.logic || 'and', (i + 1) * 10]);
    }
  }
  await q('insert into sys_oper_log (user_id, username, action, res_type, res_key, detail) values ($1,$2,$3,$4,$5,$6)',
    [req.user.id, req.user.username, 'save', 'report', String(id), report.name]);
  res.json({ code: 0, message: '报表已保存' });
});

// 复制报表
router.post('/:id(\\d+)/duplicate', async (req, res) => {
  if (!(await ensureDesign(req, res))) return;
  const id = Number(req.params.id);
  const ctx = await RE.loadReport(id);
  const newCode = ctx.report.code + '_copy_' + Date.now().toString(36).slice(-4);
  const r = await one(`insert into rpt_report (code, name, category, dataset_id, description, owner_id, status, is_public)
    values ($1,$2,$3,$4,$5,$6,'1',true) returning id`,
    [newCode, ctx.report.name + '（副本）', ctx.report.category, ctx.report.dataset_id, ctx.report.description, req.user.id]);
  for (const f of ctx.rptFields) {
    await q(`insert into rpt_report_field (report_id, field_key, field_name, field_type, field_role, dataset_field_key, agg_fn,
        custom_expr, is_group_by, is_show, is_custom, sort_dir, fmt, width, sort_no)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [r.id, f.field_key, f.field_name, f.field_type, f.field_role, f.dataset_field_key, f.agg_fn, f.custom_expr,
        f.is_group_by, f.is_show, f.is_custom, f.sort_dir, f.fmt, f.width, f.sort_no]);
  }
  res.json({ code: 0, data: { id: r.id, code: newCode }, message: '已复制报表' });
});

router.delete('/:id(\\d+)', async (req, res) => {
  if (!(await ensureDesign(req, res))) return;
  await q('delete from rpt_report where id = $1', [Number(req.params.id)]);
  res.json({ code: 0, message: '已删除' });
});

module.exports = { router };
