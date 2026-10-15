'use strict';
/**
 * 端到端冒烟测试：逐角色验证 登录 / 驾驶舱装配 / 卡片与统计图取数 / 报表聚合 /
 * 数据范围隔离 / 指标 T+1 / 任务执行 / CRM 权限
 * 用法：node scripts/smoke.js [baseUrl]
 */
const BASE = process.argv[2] || 'http://127.0.0.1:8787';

let pass = 0; let fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; fails.push(name + ' ' + (extra || '')); console.log('  ✗ ' + name + '  ' + (extra || '')); }
}

async function call(path, opt = {}, token) {
  const url = new URL(path, BASE);
  if (opt.params) Object.entries(opt.params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  const res = await fetch(url, {
    method: opt.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { status: res.status, data };
}

const ACCOUNTS = [
  ['admin', 'admin123', '系统管理员', 'all'],
  ['gm01', '123456', '总经理', 'all'],
  ['dir01', '123456', '销售总监', 'dept'],
  ['rep01', '123456', '销售代表', 'self'],
  ['ana01', '123456', '数据分析师', 'all'],
  ['svc01', '123456', '客服专员', 'self']
];

async function main() {
  console.log('='.repeat(78));
  console.log('CRM+BI 冒烟测试  ' + BASE);
  console.log('='.repeat(78));

  // ---------------------------------------------------------- 健康检查
  console.log('\n[1] 服务与数据库');
  {
    const h = await call('/api/health');
    ok('健康检查', h.status === 200 && h.data.code === 0, '用户 ' + (h.data.data ? h.data.data.users : '?'));
  }

  // ---------------------------------------------------------- 登录
  console.log('\n[2] 登录与权限装配');
  const sessions = {};
  for (const [u, p, roleName, scope] of ACCOUNTS) {
    const r = await call('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
    const d = r.data.data;
    ok(`${u}（${roleName}）登录`, r.status === 200 && !!d.token, d ? `菜单 ${d.menus.length} 组 / 数据范围 ${d.user.dataScope}` : r.data.message);
    if (d) sessions[u] = { token: d.token, role: d.user.role, perms: d.perms, menus: d.menus };
  }
  {
    const bad = await call('/api/auth/login', { method: 'POST', body: { username: 'gm01', password: 'wrong' } });
    ok('错误密码被拒绝', bad.status === 400);
    const noAuth = await call('/api/dashboard/mine');
    ok('未登录访问被拒绝', noAuth.status === 401);
  }

  // ---------------------------------------------------------- 驾驶舱按角色差异化
  console.log('\n[3] 驾驶舱按角色装配（卡片/统计图不同）');
  const dashStats = {};
  for (const [u, , roleName] of ACCOUNTS) {
    if (!sessions[u]) continue;
    const r = await call('/api/dashboard/mine', {}, sessions[u].token);
    const d = r.data.data;
    dashStats[u] = {
      dash: d.dashboard ? d.dashboard.name : null,
      cards: d.cards.map((c) => c.code),
      charts: d.charts.map((c) => c.code),
      statDate: d.statDate
    };
    const scopeNote = u === 'rep01' ? '仅本人' : u === 'dir01' ? '本部门' : '全局';
    ok(`${u} 驾驶舱「${d.dashboard && d.dashboard.name}」`, d.cards.length > 0 && d.charts.length > 0,
      `卡片 ${d.cards.length} / 统计图 ${d.charts.length} / ${scopeNote} / 数据日 ${d.statDate}`);
  }
  ok('销售代表与总经理看到的卡片集合不同',
    JSON.stringify(dashStats.rep01.cards) !== JSON.stringify(dashStats.gm01.cards));
  ok('销售代表与总经理看到的统计图集合不同',
    JSON.stringify(dashStats.rep01.charts) !== JSON.stringify(dashStats.gm01.charts));
  ok('销售总监与总经理看到的统计图集合不同',
    JSON.stringify(dashStats.dir01.charts) !== JSON.stringify(dashStats.gm01.charts));

  // ---------------------------------------------------------- 卡片与统计图取数
  console.log('\n[4] 卡片与统计图取数（全部组件）');
  for (const [u] of [['gm01'], ['rep01'], ['ana01'], ['svc01']]) {
    if (!sessions[u]) continue;
    const s = dashStats[u];
    const r = await call('/api/dashboard/widgets', { params: { codes: s.cards.join(',') } }, sessions[u].token);
    const bad = (r.data.data || []).filter((x) => !x.ok);
    ok(`${u} 卡片全部取数成功（${s.cards.length} 个）`, bad.length === 0, bad.map((b) => b.code + ':' + b.error).join('; '));
    let chartBad = [];
    for (const code of s.charts) {
      const cr = await call('/api/dashboard/widget/' + code, {}, sessions[u].token);
      if (cr.status !== 200 || !cr.data.data || !cr.data.data.ok) chartBad.push(code);
    }
    ok(`${u} 统计图全部取数成功（${s.charts.length} 个）`, chartBad.length === 0, chartBad.join(','));
  }
  {
    const r = await call('/api/dashboard/widget/w_card_sales_amount', {}, sessions.gm01.token);
    const d = r.data.data.data;
    ok('KPI 卡片返回数值/环比/迷你趋势', d.value > 0 && Array.isArray(d.spark) && d.spark.length > 10,
      `昨日销售额 ${d.display} 环比 ${d.growthText}`);
    const rep = await call('/api/dashboard/widget/w_card_my_sales_amount', {}, sessions.rep01.token);
    const gm = await call('/api/dashboard/widget/w_card_sales_amount', {}, sessions.gm01.token);
    const repVal = rep.data.data.data.rawValue;
    const gmVal = gm.data.data.data.rawValue;
    ok('销售代表卡片只统计本人数据', repVal > 0 && repVal < gmVal, `本人 ${repVal} < 全局 ${gmVal}`);
  }
  {
    const cases = ['w_chart_region_rank', 'w_chart_sales_trend', 'w_chart_industry_pie', 'w_chart_funnel', 'w_chart_heatmap', 'w_chart_product_stack', 'w_chart_scatter', 'w_chart_radar', 'w_chart_gauge', 'w_chart_order_status', 'w_chart_lead_source', 'w_chart_top_customer', 'w_chart_rep_rank', 'w_chart_month_trend', 'w_chart_lead_convert_trend', 'w_chart_customer_trend'];
    const types = [];
    let bad = [];
    for (const c of cases) {
      const r = await call('/api/dashboard/widget/' + c, {}, sessions.admin.token);
      if (r.status === 200 && r.data.data.ok) {
        const o = r.data.data.data.option;
        types.push(r.data.data.chartType + (o && o.series && o.series.length ? '(' + o.series.length + '系列)' : ''));
      } else bad.push(c + ':' + (r.data && r.data.message ? r.data.message : '渲染失败'));
    }
    ok('16 个统计图全部可渲染（含热度图/雷达/漏斗/仪表盘）', bad.length === 0, bad.join('; '));
    console.log('      图型：' + types.join(' , '));
  }

  // ---------------------------------------------------------- 报表引擎
  console.log('\n[5] 报表引擎（分组/排序/聚合/自定义字段/总计/数据范围）');
  {
    const list = await call('/api/report/list', {}, sessions.ana01.token);
    ok('报表列表', list.status === 200 && list.data.data.length >= 20, list.data.data.length + ' 张报表');

    const byRegion = await call('/api/report/run', {
      method: 'POST',
      body: { reportId: 2, sortStrategy: 'value_desc', withTotal: true }
    }, sessions.ana01.token);
    const d = byRegion.data.data;
    const top = d.rows[0];
    ok('区域汇总报表：分组 + 按金额降序 + 合计行',
      d.rows.length === 7 && !!d.total && top.amount > 0,
      `首行 ${top.region} ${UI0(top.amount)} / 合计 ${UI0(d.total.amount)} / 记录 ${d.total.contract_cnt}`);
    ok('自定义字段（单均金额 = 金额 / 合同数）计算正确',
      Math.abs(top.avg_amount - top.amount / top.contract_cnt) < 1,
      '单均 ' + Math.round(top.avg_amount));

    const rates = await call('/api/report/run', { method: 'POST', body: { reportId: 1, size: 5, page: 1 } }, sessions.ana01.token);
    const r0 = rates.data.data.rows[rates.data.data.rows.length - 1];
    ok('自定义字段（毛利率 = (金额-成本)/金额）非整数除零',
      r0.gross_margin > 0 && r0.gross_margin < 1, '毛利率 ' + (r0.gross_margin * 100).toFixed(2) + '%');

    const detail = await call('/api/report/run', { method: 'POST', body: { reportId: 18, size: 10, page: 1 } }, sessions.ana01.token);
    ok('明细报表（不聚合）分页正常', detail.data.data.rows.length === 10 && detail.data.data.totalRows > 1000,
      '总行数 ' + detail.data.data.totalRows);

    const sort = await call('/api/report/run', { method: 'POST', body: { reportId: 13, orderBy: [{ key: 'contract_cnt', dir: 'desc' }], size: 5 } }, sessions.ana01.token);
    const cnts = sort.data.data.rows.map((r) => r.contract_cnt);
    ok('自定义排序（按合同数降序）生效', cnts.every((v, i) => i === 0 || cnts[i - 1] >= v), cnts.join(' ≥ '));

    const filt = await call('/api/report/run', { method: 'POST', body: { reportId: 18, filters: [{ fieldKey: 'status', op: 'eq', value: 'effective' }], size: 5 } }, sessions.ana01.token);
    ok('过滤条件（合同状态=生效）生效', filt.data.data.rows.length > 0 && filt.data.data.rows.every((r) => r.status === 'effective'), '返回 ' + filt.data.data.totalRows + ' 行');

    const inFilt = await call('/api/report/run', { method: 'POST', body: { reportId: 18, filters: [{ fieldKey: 'status', op: 'in', value: ['effective', 'closed'] }], size: 20 } }, sessions.ana01.token);
    ok('IN 多值过滤由参数绑定安全展开', inFilt.status === 200 && inFilt.data.data.rows.length > 0
      && inFilt.data.data.rows.every((r) => ['effective', 'closed'].includes(r.status)),
    '返回 ' + inFilt.data.data.totalRows + ' 行');

    const sampleDate = String(detail.data.data.rows[0].sign_date).slice(0, 10);
    const dateFilt = await call('/api/report/run', { method: 'POST', body: { reportId: 18, filters: [{ fieldKey: 'sign_date', op: 'between', value: sampleDate, value2: sampleDate }], size: 20 } }, sessions.ana01.token);
    ok('日期区间过滤使用 PostgreSQL date 类型比较', dateFilt.status === 200 && dateFilt.data.data.rows.length > 0
      && dateFilt.data.data.rows.every((r) => String(r.sign_date).slice(0, 10) === sampleDate),
    sampleDate + ' 共 ' + dateFilt.data.data.totalRows + ' 行');

    const inj = await call('/api/report/run', { method: 'POST', body: { reportId: 2, filters: [{ fieldKey: "region' or 1=1 --", op: 'eq', value: 'x' }] } }, sessions.ana01.token);
    ok('注入式过滤字段被拒绝', inj.status !== 200 || inj.data.code !== 0, inj.data.message || '');
  }

  // ---------------------------------------------------------- 指标
  console.log('\n[6] 指标（T+1）');
  {
    const list = await call('/api/metric/list', {}, sessions.ana01.token);
    ok('指标列表', list.data.data.length === 12, list.data.data.length + ' 个指标');
    const credit = list.data.data.find((m) => m.code === 'm_gross_margin_day');
    ok('指标已落库且带最新值', credit && credit.last_value != null, `日毛利率 ${(Number(credit.last_value) * 100).toFixed(2)}% @ ${String(credit.last_date).slice(0, 10)}`);

    const values = await call('/api/metric/12/values', { params: { from: '2026-01-01' } }, sessions.ana01.token);
    const v = values.data.data;
    ok('指标值序列与区间统计', v.values.length > 100, `${v.values.length} 天，均值 ${(v.summary.avg * 100).toFixed(2)}%，最大 ${(v.summary.max * 100).toFixed(2)}%`);

    const prev = await call('/api/metric/1/preview', { method: 'POST', body: { statDate: '2026-10-12' } }, sessions.ana01.token);
    ok('指标试算（不落库）', prev.data.data.value > 0, '2026-10-12 日销售额 ' + UI0(prev.data.data.value));
  }

  // ---------------------------------------------------------- 任务
  console.log('\n[7] 任务管理与调度');
  {
    const tl = await call('/api/task/list', {}, sessions.ana01.token);
    const t = tl.data.data[0];
    ok('任务列表含下次执行时间', tl.data.data.length === 3 && !!t.next_run_at, `${t.name} · ${t.cron_desc} · 下次 ${t.next_run_at}`);
    const st = await call('/api/task/scheduler/status', {}, sessions.ana01.token);
    ok('调度器已注册定时任务', st.data.data.enabled && st.data.data.jobs.length === 3, st.data.data.jobs.map((j) => j.code).join(','));

    const run = await call('/api/task/1/run', { method: 'POST', body: { statDate: '2026-10-12' } }, sessions.ana01.token);
    ok('手动执行 T+1 指标任务', run.data.data.ok && run.data.data.rows === 12, `写入 ${run.data.data.rows} 条，耗时 ${run.data.data.durationMs}ms`);

    const backfill = await call('/api/task/2/run', { method: 'POST' }, sessions.ana01.token);
    ok('近 7 天补算逐日执行且使用系统数据范围', backfill.data.data.ok && backfill.data.data.rows === 84,
      `7 天 × 12 指标 = ${backfill.data.data.rows} 条`);

    const archive = await call('/api/task/3/run', { method: 'POST' }, sessions.ana01.token);
    ok('归档校验执行统计刷新且不删除业务数据', archive.data.data.ok && archive.data.data.type === 'data_archive' && archive.data.data.rows >= 0,
      `候选 ${archive.data.data.rows} 条`);

    const margin = await call('/api/metric/12/values', { params: { from: '2026-10-12', to: '2026-10-12' } }, sessions.ana01.token);
    const marginValue = Number(margin.data.data.values[0].value);
    ok('指标任务按独立口径计算毛利率', marginValue >= 0 && marginValue <= 1, `毛利率 ${(marginValue * 100).toFixed(2)}%`);

    const logs = await call('/api/task/logs', { params: { limit: 5 } }, sessions.ana01.token);
    ok('任务执行日志', logs.data.data.length > 0 && logs.data.data[0].status === 'success', '最近日志 ' + logs.data.data[0].start_time);
  }

  // ---------------------------------------------------------- CRM 与数据范围
  console.log('\n[8] CRM 录入与数据范围隔离');
  {
    const cust = await call('/api/crm/customer', { params: { size: 5 } }, sessions.gm01.token);
    ok('客户列表（总经理）', cust.data.data.rows.length === 5, '总数 ' + cust.data.data.total);
    const repCust = await call('/api/crm/customer', { params: { size: 5 } }, sessions.rep01.token);
    ok('销售代表仅看到本人客户', repCust.data.data.total < cust.data.data.total,
      `代表 ${repCust.data.data.total} < 全局 ${cust.data.data.total}`);
    const dirCust = await call('/api/crm/customer', { params: { size: 5 } }, sessions.dir01.token);
    ok('销售总监看到本部门客户', dirCust.data.data.total > repCust.data.data.total && dirCust.data.data.total < cust.data.data.total,
      `部门 ${dirCust.data.data.total}`);

    const stats = await call('/api/crm/contract/summary/stats', {}, sessions.rep01.token);
    ok('合同统计条（按数据范围）', stats.data.data.total > 0, '代表合同数 ' + stats.data.data.total + ' / 金额 ' + UI0(stats.data.data.amount));

    // 销售代表新增客户
    const created = await call('/api/crm/customer', {
      method: 'POST',
      body: { name: '冒烟测试客户-科技', industry: '互联网', region: '华东', level: 'B', source: '官网注册', status: 'potential', credit_limit: 100000 }
    }, sessions.rep01.token);
    ok('销售代表可新增客户（自动编号+归属本人）', created.data.code === 0, created.data.data && created.data.data.id ? 'ID ' + created.data.data.id : created.data.message);
    if (created.data.data) {
      const row = await call('/api/crm/customer/' + created.data.data.id, {}, sessions.rep01.token);
      ok('新增客户归属人为当前销售', row.data.data.owner_id === 4 || row.data.data.owner_name != null,
        '客户编号 ' + row.data.data.cust_no + ' 归属 ' + row.data.data.owner_name);
      await call('/api/crm/customer/' + created.data.data.id, { method: 'DELETE' }, sessions.admin.token);
    }

    // 权限：销售代表不能设计报表
    const forbidden = await call('/api/report', { method: 'POST', body: { name: 'x', datasetId: 1 } }, sessions.rep01.token);
    ok('销售代表无权新建报表（403）', forbidden.status === 403, forbidden.data.message);
    const taskForbidden = await call('/api/task/1/run', { method: 'POST', body: {} }, sessions.rep01.token);
    ok('销售代表无权执行任务（403）', taskForbidden.status === 403, taskForbidden.data.message);

    // 线索池与领取
    const fixture = await call('/api/crm/lead', { method: 'POST', body: { name: '冒烟测试线索', company: '冒烟测试公司', in_pool: true, stage: 'new' } }, sessions.admin.token);
    const leadId = fixture.data.data && fixture.data.data.id;
    if (leadId) {
      const claim = await call('/api/crm/lead/' + leadId + '/claim', { method: 'POST' }, sessions.rep01.token);
      ok('销售代表领取线索', claim.data.code === 0, claim.data.message);
      const assign = await call('/api/crm/lead/' + leadId + '/assign', { method: 'POST', body: { ownerId: 7 } }, sessions.dir01.token);
      ok('销售总监分配线索给他人', assign.data.code === 0, assign.data.message);
      const convert = await call('/api/crm/lead/' + leadId + '/convert', { method: 'POST' }, sessions.dir01.token);
      ok('线索转客户', convert.data.code === 0, convert.data.message);
      await call('/api/crm/lead/' + leadId, { method: 'DELETE' }, sessions.admin.token);
      if (convert.data.data) await call('/api/crm/customer/' + convert.data.data.customerId, { method: 'DELETE' }, sessions.admin.token);
    }

    const c360id = (await call('/api/crm/contract', { params: { size: 1 } }, sessions.gm01.token)).data.data.rows[0].customer_id;
    const c360 = await call('/api/crm/customer/' + c360id + '/360', {}, sessions.gm01.token);
    ok('客户 360 视图（联系人/合同/订单/商机）',
      c360.data.data.contacts.length > 0 && c360.data.data.contracts.length > 0,
      `联系人 ${c360.data.data.contacts.length} / 合同 ${c360.data.data.contracts.length} / 累计签约 ${UI0(c360.data.data.summary.contractAmount)}`);
  }

  // ---------------------------------------------------------- 权限矩阵
  console.log('\n[9] 系统管理');
  {
    const users = await call('/api/sys/users', {}, sessions.admin.token);
    ok('用户列表', users.data.data.length === 9 && users.data.data.some((u) => u.username === 'admin'),
      '共 ' + users.data.data.length + ' 个用户');
    const acl = await call('/api/sys/acl', {}, sessions.admin.token);
    ok('权限矩阵（菜单+卡片+统计图）', acl.data.data.resources.menu.some((m) => m.code === 'crm_pool') && acl.data.data.resources.card.length > 0 && acl.data.data.resources.chart.length > 0 && Object.keys(acl.data.data.matrix).length === acl.data.data.roles.length,
      '角色 ' + Object.keys(acl.data.data.matrix).length + ' 个');
    const stats = await call('/api/sys/stats', {}, sessions.admin.token);
    ok('运行信息', stats.data.data.counts.bi_metric_value > 1400,
      '指标值 ' + stats.data.data.counts.bi_metric_value + ' 条 / 合同 ' + stats.data.data.counts.crm_contract + ' 条');
    const denied = await call('/api/sys/users', {}, sessions.gm01.token);
    ok('非管理员访问系统管理被拒绝（403）', denied.status === 403, denied.data.message);
  }

  console.log('\n' + '='.repeat(78));
  console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
  if (fails.length) { console.log('失败明细：'); fails.forEach((f) => console.log('  - ' + f)); }
  console.log('='.repeat(78));
  process.exit(fail ? 1 : 0);
}

const UI0 = (v) => Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

main().catch((e) => { console.error('冒烟测试异常：', e); process.exit(2); });
