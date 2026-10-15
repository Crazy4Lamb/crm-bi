'use strict';
/**
 * 元数据种子：角色 / 用户 / 菜单 / 权限 / 数据集 / 报表 / 统计图 / 指标 / 任务
 * 说明：报表与指标均为「配置化」——查询构建器只允许使用 rpt_dataset_field 中登记的白名单表达式，
 *      因此用户在设计器里怎么改字段、分组、排序，都不会产生 SQL 注入。
 */
const bcrypt = require('bcryptjs');
const { q, one } = require('./index');

// ============================================================ 角色
const ROLES = [
  ['admin', '系统管理员', '系统配置、用户与权限、全部数据', 1],
  ['gm', '总经理', '全局经营视图，关注大盘与趋势', 2],
  ['sales_director', '销售总监', '本部门团队数据，含线索分配', 3],
  ['sales_rep', '销售代表', '仅本人客户/线索/订单/合同', 4],
  ['analyst', '数据分析师', '报表设计、统计图设计、指标与任务', 5],
  ['service', '客服专员', '客户档案与线索维护', 6]
];

// ============================================================ 菜单
const MENUS = [
  ['dashboard', null, '驾驶舱', '/dashboard', 'gauge', 1],
  ['g_crm', null, '客户中心', null, null, 2],
  ['crm_customer', 'g_crm', '客户档案', '/customer', 'user', 1],
  ['crm_pool', 'g_crm', '客户公海', '/crm/pool', 'pool', 2],
  ['crm_lead', 'g_crm', '线索管理', '/lead', 'funnel', 3],
  ['crm_lead_pool', 'g_crm', '线索池', '/leadpool', 'inbox', 4],
  ['crm_opportunity', 'g_crm', '商机管理', '/opportunity', 'target', 5],
  ['g_deal', null, '交易中心', null, null, 3],
  ['crm_contract', 'g_deal', '合同管理', '/contract', 'file', 1],
  ['crm_order', 'g_deal', '订单 / 回款', '/order', 'cart', 2],
  ['g_bi', null, '分析中心', null, null, 4],
  ['rpt_report', 'g_bi', '报表中心', '/report', 'table', 1],
  ['bi_chart', 'g_bi', '统计图中心', '/chart', 'chart', 2],
  ['g_design', null, '设计中心', null, null, 5],
  ['rpt_report_design', 'g_design', '报表设计', '/report-design', 'edit', 1],
  ['bi_widget_design', 'g_design', '统计图设计', '/widget-design', 'palette', 2],
  ['bi_metric_design', 'g_design', '指标设计', '/metric-design', 'sliders', 3],
  ['g_ops', null, '运行管理', null, null, 6],
  ['bi_task', 'g_ops', '任务管理', '/task', 'clock', 1],
  ['sys_user', 'g_ops', '用户与角色', '/user', 'team', 2],
  ['sys_perm', 'g_ops', '权限矩阵', '/perm', 'lock', 3]
];

// ============================================================ 用户
const USERS = [
  ['admin', 'admin123', '系统管理员', 'admin', '信息技术部', '13800000001', 'admin@demo.com', 'all'],
  ['gm01', '123456', '张启明', 'gm', '总裁办', '13800000002', 'zhangqm@demo.com', 'all'],
  ['dir01', '123456', '李国强', 'sales_director', '华北大区', '13800000003', 'ligq@demo.com', 'dept'],
  ['rep01', '123456', '王小明', 'sales_rep', '华北大区', '13800000004', 'wangxm@demo.com', 'self'],
  ['rep02', '123456', '刘婷', 'sales_rep', '华东大区', '13800000005', 'liuting@demo.com', 'self'],
  ['rep03', '123456', '陈鹏', 'sales_rep', '华南大区', '13800000006', 'chenp@demo.com', 'self'],
  ['rep04', '123456', '李静', 'sales_rep', '华北大区', '13800000009', 'lijing@demo.com', 'self'],
  ['ana01', '123456', '赵思远', 'analyst', '数据运营部', '13800000007', 'zhaosy@demo.com', 'all'],
  ['svc01', '123456', '孙雅琴', 'service', '客户成功部', '13800000008', 'sunyq@demo.com', 'self']
];

// ============================================================ 角色授权
const ALL_MENUS = MENUS.map((m) => m[0]);
const ALL_CARDS = ['w_card_sales_amount', 'w_card_sales_mtd', 'w_card_contract_cnt', 'w_card_new_customer', 'w_card_new_lead', 'w_card_gross_margin', 'w_card_order_cnt', 'w_card_order_amount', 'w_card_avg_order', 'w_card_lead_convert_rate', 'w_card_active_customer', 'w_card_target_rate', 'w_card_my_sales_amount', 'w_card_my_sales_mtd', 'w_card_my_customer', 'w_card_lead_pool', 'w_card_pending_order'];
const ALL_CHARTS = ['w_chart_sales_trend', 'w_chart_region_rank', 'w_chart_industry_pie', 'w_chart_month_trend', 'w_chart_funnel', 'w_chart_heatmap', 'w_chart_lead_source', 'w_chart_top_customer', 'w_chart_product_stack', 'w_chart_rep_rank', 'w_chart_order_status', 'w_chart_scatter', 'w_chart_radar', 'w_chart_gauge', 'w_chart_my_trend', 'w_chart_my_industry', 'w_chart_lead_convert_trend', 'w_chart_customer_trend', 'w_chart_my_top_customer'];
const ALL_ACTIONS = ['customer:add', 'customer:edit', 'customer:delete', 'lead:add', 'lead:claim', 'lead:assign', 'lead:edit', 'opp:add', 'opp:edit', 'opp:advance', 'contract:add', 'contract:edit', 'order:add', 'order:edit', 'payment:add', 'customer-pool:claim', 'customer-pool:release', 'follow:add', 'report:design', 'widget:design', 'metric:design', 'task:run', 'task:edit', 'user:edit'];

const ACL = {
  admin: { menu: ALL_MENUS, action: ALL_ACTIONS, card: ALL_CARDS, chart: ALL_CHARTS, dashboard: ['dash_exec', 'dash_sales', 'dash_rep', 'dash_analyst'] },
  gm: {
    menu: ['dashboard', 'g_crm', 'crm_customer', 'crm_pool', 'crm_lead', 'crm_opportunity', 'g_deal', 'crm_contract', 'crm_order', 'g_bi', 'rpt_report', 'bi_chart'],
    action: ['follow:add', 'customer:edit', 'customer-pool:claim', 'customer-pool:release'],
    card: ['w_card_sales_amount', 'w_card_sales_mtd', 'w_card_contract_cnt', 'w_card_new_customer', 'w_card_new_lead', 'w_card_gross_margin', 'w_card_order_cnt', 'w_card_order_amount', 'w_card_avg_order', 'w_card_lead_convert_rate', 'w_card_active_customer', 'w_card_target_rate'],
    chart: ['w_chart_sales_trend', 'w_chart_region_rank', 'w_chart_industry_pie', 'w_chart_month_trend', 'w_chart_funnel', 'w_chart_heatmap', 'w_chart_rep_rank', 'w_chart_order_status', 'w_chart_radar', 'w_chart_gauge', 'w_chart_customer_trend'],
    dashboard: ['dash_exec']
  },
  sales_director: {
    menu: ['dashboard', 'g_crm', 'crm_customer', 'crm_pool', 'crm_lead', 'crm_lead_pool', 'crm_opportunity', 'g_deal', 'crm_contract', 'crm_order', 'g_bi', 'rpt_report', 'bi_chart'],
    action: ['customer:add', 'customer:edit', 'lead:add', 'lead:claim', 'lead:assign', 'lead:edit', 'opp:add', 'opp:edit', 'opp:advance', 'contract:add', 'contract:edit', 'order:add', 'payment:add', 'customer-pool:claim', 'customer-pool:release', 'follow:add'],
    card: ['w_card_sales_amount', 'w_card_sales_mtd', 'w_card_contract_cnt', 'w_card_new_customer', 'w_card_new_lead', 'w_card_order_cnt', 'w_card_order_amount', 'w_card_avg_order', 'w_card_lead_convert_rate', 'w_card_lead_pool', 'w_card_pending_order', 'w_card_active_customer'],
    chart: ['w_chart_sales_trend', 'w_chart_region_rank', 'w_chart_rep_rank', 'w_chart_lead_source', 'w_chart_order_status', 'w_chart_radar', 'w_chart_scatter', 'w_chart_funnel', 'w_chart_lead_convert_trend'],
    dashboard: ['dash_sales']
  },
  sales_rep: {
    menu: ['dashboard', 'g_crm', 'crm_customer', 'crm_pool', 'crm_lead', 'crm_lead_pool', 'crm_opportunity', 'g_deal', 'crm_contract', 'crm_order'],
    action: ['customer:add', 'customer:edit', 'lead:add', 'lead:claim', 'lead:edit', 'opp:add', 'opp:edit', 'opp:advance', 'contract:add', 'contract:edit', 'order:add', 'payment:add', 'customer-pool:claim', 'customer-pool:release', 'follow:add'],
    card: ['w_card_my_sales_amount', 'w_card_my_sales_mtd', 'w_card_my_customer', 'w_card_contract_cnt', 'w_card_order_cnt', 'w_card_lead_pool'],
    chart: ['w_chart_my_trend', 'w_chart_my_industry', 'w_chart_my_top_customer', 'w_chart_order_status'],
    dashboard: ['dash_rep']
  },
  analyst: {
    menu: ['dashboard', 'g_bi', 'rpt_report', 'bi_chart', 'g_design', 'rpt_report_design', 'bi_widget_design', 'bi_metric_design', 'g_ops', 'bi_task'],
    action: ['report:design', 'widget:design', 'metric:design', 'task:run', 'task:edit'],
    card: ['w_card_sales_amount', 'w_card_sales_mtd', 'w_card_gross_margin', 'w_card_avg_order', 'w_card_lead_convert_rate', 'w_card_active_customer', 'w_card_target_rate', 'w_card_new_lead'],
    chart: ['w_chart_sales_trend', 'w_chart_industry_pie', 'w_chart_heatmap', 'w_chart_product_stack', 'w_chart_gauge', 'w_chart_lead_convert_trend', 'w_chart_radar', 'w_chart_scatter', 'w_chart_customer_trend'],
    dashboard: ['dash_analyst']
  },
  service: {
    menu: ['dashboard', 'g_crm', 'crm_customer', 'crm_pool', 'crm_lead', 'crm_lead_pool', 'g_deal', 'crm_contract'],
    action: ['customer:add', 'customer:edit', 'lead:add', 'lead:claim', 'customer-pool:claim', 'customer-pool:release', 'follow:add'],
    card: ['w_card_new_customer', 'w_card_new_lead', 'w_card_lead_pool', 'w_card_my_customer'],
    chart: ['w_chart_industry_pie', 'w_chart_lead_source', 'w_chart_customer_trend'],
    dashboard: ['dash_service']
  }
};

// ============================================================ 数据集
const S_CODES = "draft:草稿,approving:审批中,effective:生效,closed:已完结,void:作废";
const O_STATUS = "pending:待付款,paid:已付款,delivered:已交付,done:已完成,refund:已退款";
const L_STAGE = "new:新线索,following:跟进中,qualified:已确认,converted:已转客户,invalid:无效";
const C_STATUS = "potential:潜在客户,active:成交客户,inactive:流失客户";
const OPP_STAGE = "初步接洽:初步接洽,需求确认:需求确认,方案报价:方案报价,商务谈判:商务谈判,赢单:赢单,输单:输单";

const DATASETS = [
  {
    code: 'ds_customer', name: '客户数据集', base_table: 'crm_customer', date_field: 'create_date',
    owner_field: 'owner_id', dept_field: 'owner_dept',
    joins: [{ type: 'left', table: 'sys_user', alias: 'u', on: 'u.id = t.owner_id' }],
    fields: [
      ['cust_no', '客户编号', 'string', 'dimension', 't.cust_no'],
      ['cust_name', '客户名称', 'string', 'dimension', 't.name'],
      ['industry', '所属行业', 'string', 'dimension', 't.industry'],
      ['region', '所属区域', 'string', 'dimension', 't.region'],
      ['level', '客户等级', 'string', 'dimension', 't.level'],
      ['source', '客户来源', 'string', 'dimension', 't.source'],
      ['status', '客户状态', 'string', 'dimension', 't.status', C_STATUS],
      ['owner_name', '归属销售', 'string', 'dimension', 'u.real_name'],
      ['owner_dept', '归属部门', 'string', 'dimension', 't.owner_dept'],
      ['create_date', '创建日期', 'date', 'dimension', "t.created_at::date"],
      ['create_month', '创建月份', 'string', 'dimension', "to_char(t.created_at,'YYYY-MM')"],
      ['owner_id', '归属人ID', 'number', 'dimension', 't.owner_id'],
      ['credit_limit', '授信额度', 'number', 'measure', 't.credit_limit']
    ]
  },
  {
    code: 'ds_lead', name: '线索数据集', base_table: 'crm_lead', date_field: 'create_date',
    owner_field: 'owner_id', dept_field: 'owner_dept',
    joins: [
      { type: 'left', table: 'crm_lead_pool', alias: 'p', on: 'p.id = t.pool_id' },
      { type: 'left', table: 'sys_user', alias: 'u', on: 'u.id = t.owner_id' }
    ],
    fields: [
      ['lead_no', '线索编号', 'string', 'dimension', 't.lead_no'],
      ['contact_name', '线索联系人', 'string', 'dimension', 't.name'],
      ['company', '公司名称', 'string', 'dimension', 't.company'],
      ['industry', '所属行业', 'string', 'dimension', 't.industry'],
      ['region', '所属区域', 'string', 'dimension', 't.region'],
      ['source', '线索来源', 'string', 'dimension', 't.source'],
      ['stage', '线索阶段', 'string', 'dimension', 't.stage', L_STAGE],
      ['intent_level', '意向级别', 'string', 'dimension', 't.intent_level'],
      ['pool_name', '所属线索池', 'string', 'dimension', 'coalesce(p.name, \'未入池\')'],
      ['pool_state', '池状态', 'string', 'dimension', "case when t.in_pool then '在池' else '已领取' end"],
      ['owner_name', '归属销售', 'string', 'dimension', "coalesce(u.real_name,'未分配')"],
      ['owner_dept', '归属部门', 'string', 'dimension', 't.owner_dept'],
      ['create_date', '创建日期', 'date', 'dimension', "t.created_at::date"],
      ['create_month', '创建月份', 'string', 'dimension', "to_char(t.created_at,'YYYY-MM')"],
      ['owner_id', '归属人ID', 'number', 'dimension', 't.owner_id'],
      ['est_amount', '预估金额', 'number', 'measure', 't.est_amount'],
      ['convert_flag', '转化标记', 'number', 'measure', "case when t.stage = 'converted' then 1 else 0 end"]
    ]
  },
  {
    code: 'ds_contract', name: '合同数据集', base_table: 'crm_contract', date_field: 'sign_date',
    owner_field: 'owner_id', dept_field: 'owner_dept',
    joins: [
      { type: 'left', table: 'crm_customer', alias: 'c', on: 'c.id = t.customer_id' },
      { type: 'left', table: 'sys_user', alias: 'u', on: 'u.id = t.owner_id' }
    ],
    fields: [
      ['contract_no', '合同编号', 'string', 'dimension', 't.contract_no'],
      ['contract_name', '合同名称', 'string', 'dimension', 't.name'],
      ['customer_name', '客户名称', 'string', 'dimension', 'c.name'],
      ['industry', '客户行业', 'string', 'dimension', 'c.industry'],
      ['region', '客户区域', 'string', 'dimension', 'c.region'],
      ['level', '客户等级', 'string', 'dimension', 'c.level'],
      ['status', '合同状态', 'string', 'dimension', 't.status', S_CODES],
      ['pay_type', '付款方式', 'string', 'dimension', 't.pay_type'],
      ['owner_name', '签约人', 'string', 'dimension', 'u.real_name'],
      ['owner_dept', '归属部门', 'string', 'dimension', 't.owner_dept'],
      ['sign_date', '签约日期', 'date', 'dimension', 't.sign_date'],
      ['sign_month', '签约月份', 'string', 'dimension', "to_char(t.sign_date,'YYYY-MM')"],
      ['owner_id', '归属人ID', 'number', 'dimension', 't.owner_id'],
      ['amount', '合同金额', 'number', 'measure', 't.amount'],
      ['cost', '合同成本', 'number', 'measure', 't.cost'],
      ['profit', '合同毛利', 'number', 'measure', '(t.amount - t.cost)']
    ]
  },
  {
    code: 'ds_order', name: '订单数据集', base_table: 'crm_order', date_field: 'order_date',
    owner_field: 'owner_id', dept_field: 'owner_dept',
    joins: [
      { type: 'left', table: 'crm_customer', alias: 'c', on: 'c.id = t.customer_id' },
      { type: 'left', table: 'sys_user', alias: 'u', on: 'u.id = t.owner_id' }
    ],
    fields: [
      ['order_no', '订单编号', 'string', 'dimension', 't.order_no'],
      ['customer_name', '客户名称', 'string', 'dimension', 'c.name'],
      ['industry', '客户行业', 'string', 'dimension', 'c.industry'],
      ['region', '客户区域', 'string', 'dimension', 'c.region'],
      ['product', '产品线', 'string', 'dimension', 't.product'],
      ['status', '订单状态', 'string', 'dimension', 't.status', O_STATUS],
      ['owner_name', '归属销售', 'string', 'dimension', 'u.real_name'],
      ['owner_dept', '归属部门', 'string', 'dimension', 't.owner_dept'],
      ['order_date', '下单日期', 'date', 'dimension', 't.order_date'],
      ['order_month', '下单月份', 'string', 'dimension', "to_char(t.order_date,'YYYY-MM')"],
      ['owner_id', '归属人ID', 'number', 'dimension', 't.owner_id'],
      ['customer_id', '客户ID', 'number', 'dimension', 't.customer_id'],
      ['amount', '订单金额', 'number', 'measure', 't.amount'],
      ['cost', '订单成本', 'number', 'measure', 't.cost'],
      ['quantity', '数量', 'number', 'measure', 't.quantity']
    ]
  },
  {
    code: 'ds_opportunity', name: '商机数据集', base_table: 'crm_opportunity', date_field: 'create_date',
    owner_field: 'owner_id', dept_field: 'owner_dept',
    joins: [
      { type: 'left', table: 'crm_customer', alias: 'c', on: 'c.id = t.customer_id' },
      { type: 'left', table: 'sys_user', alias: 'u', on: 'u.id = t.owner_id' }
    ],
    fields: [
      ['opp_no', '商机编号', 'string', 'dimension', 't.opp_no'],
      ['opp_name', '商机名称', 'string', 'dimension', 't.name'],
      ['customer_name', '客户名称', 'string', 'dimension', 'c.name'],
      ['industry', '客户行业', 'string', 'dimension', 'c.industry'],
      ['region', '客户区域', 'string', 'dimension', 'c.region'],
      ['stage', '商机阶段', 'string', 'dimension', 't.stage', OPP_STAGE],
      ['win_rate', '赢单率', 'number', 'measure', 't.win_rate'],
      ['est_amount', '预计金额', 'number', 'measure', 't.est_amount'],
      ['expect_date', '预计成交日期', 'date', 'dimension', 't.expect_date'],
      ['create_date', '创建日期', 'date', 'dimension', "t.created_at::date"],
      ['owner_name', '归属销售', 'string', 'dimension', 'u.real_name'],
      ['owner_dept', '归属部门', 'string', 'dimension', 't.owner_dept'],
      ['owner_id', '归属人ID', 'number', 'dimension', 't.owner_id']
    ]
  }
];

// ============================================================ 报表
// f: [key, name, type, role, dsKey|null, agg, extra{group, custom, sort, fmt, enum}]
function F(key, name, type, role, dsKey, agg, extra) { return { key, name, type, role, dsKey, agg, ...(extra || {}) }; }

const REPORTS = [
  {
    code: 'rpt_sales_daily', name: '日销售趋势表', category: '销售', ds: 'ds_contract',
    description: '按签约日期统计合同金额、成本与毛利率，指标计算的数据来源',
    fields: [
      F('sign_date', '签约日期', 'date', 'dimension', 'sign_date', 'none', { group: true, sort: 'asc' }),
      F('amount', '合同金额', 'number', 'measure', 'amount', 'sum', { fmt: 'currency' }),
      F('cost', '合同成本', 'number', 'measure', 'cost', 'sum', { fmt: 'currency' }),
      F('contract_cnt', '合同数', 'number', 'measure', null, 'count'),
      F('gross_margin', '毛利率', 'number', 'measure', null, 'none', { custom: '(amount - cost) / nullif(amount, 0)', fmt: 'percent' })
    ]
  },
  {
    code: 'rpt_sales_by_region', name: '区域销售汇总表', category: '销售', ds: 'ds_contract',
    description: '按客户区域汇总销售额、合同数与单均金额',
    fields: [
      F('region', '客户区域', 'string', 'dimension', 'region', 'none', { group: true }),
      F('amount', '合同金额', 'number', 'measure', 'amount', 'sum', { fmt: 'currency', sort: 'desc' }),
      F('contract_cnt', '合同数', 'number', 'measure', null, 'count'),
      F('avg_amount', '单均金额', 'number', 'measure', null, 'none', { custom: 'amount / nullif(contract_cnt, 0)', fmt: 'currency' })
    ]
  },
  {
    code: 'rpt_sales_month', name: '月度签约趋势表', category: '销售', ds: 'ds_contract',
    description: '按月统计签约金额与合同数',
    fields: [
      F('sign_month', '签约月份', 'string', 'dimension', 'sign_month', 'none', { group: true, sort: 'asc' }),
      F('amount', '合同金额', 'number', 'measure', 'amount', 'sum', { fmt: 'currency' }),
      F('contract_cnt', '合同数', 'number', 'measure', null, 'count'),
      F('gross_margin', '毛利率', 'number', 'measure', null, 'none', { custom: '(amount - cost) / nullif(amount, 0)', fmt: 'percent' }),
      F('cost', '合同成本', 'number', 'measure', 'cost', 'sum', { fmt: 'currency' })
    ]
  },
  {
    code: 'rpt_customer_industry', name: '客户行业分布表', category: '客户', ds: 'ds_customer',
    description: '按行业统计客户数量与授信总额',
    fields: [
      F('industry', '所属行业', 'string', 'dimension', 'industry', 'none', { group: true }),
      F('cust_cnt', '客户数', 'number', 'measure', null, 'count', { sort: 'desc' }),
      F('credit_sum', '授信总额', 'number', 'measure', 'credit_limit', 'sum', { fmt: 'currency' })
    ]
  },
  {
    code: 'rpt_customer_daily', name: '日新增客户表', category: '客户', ds: 'ds_customer',
    description: '按创建日期统计新增客户数量，T+1 指标数据源',
    fields: [
      F('create_date', '创建日期', 'date', 'dimension', 'create_date', 'none', { group: true, sort: 'asc' }),
      F('cust_cnt', '新增客户数', 'number', 'measure', null, 'count')
    ]
  },
  {
    code: 'rpt_lead_daily', name: '日线索看板表', category: '线索', ds: 'ds_lead',
    description: '按创建日期统计新增线索数与转化数，T+1 指标数据源',
    fields: [
      F('create_date', '创建日期', 'date', 'dimension', 'create_date', 'none', { group: true, sort: 'asc' }),
      F('lead_cnt', '新增线索数', 'number', 'measure', null, 'count'),
      F('converted_cnt', '转化线索数', 'number', 'measure', 'convert_flag', 'sum'),
      F('convert_rate', '转化率', 'number', 'measure', null, 'none', { custom: 'converted_cnt / nullif(lead_cnt, 0)', fmt: 'percent' })
    ]
  },
  {
    code: 'rpt_lead_source', name: '线索来源分析表', category: '线索', ds: 'ds_lead',
    description: '按来源统计线索量、预估金额与转化率',
    fields: [
      F('source', '线索来源', 'string', 'dimension', 'source', 'none', { group: true }),
      F('lead_cnt', '线索数', 'number', 'measure', null, 'count', { sort: 'desc' }),
      F('est_amount', '预估金额', 'number', 'measure', 'est_amount', 'sum', { fmt: 'currency' }),
      F('converted_cnt', '已转化', 'number', 'measure', 'convert_flag', 'sum'),
      F('convert_rate', '转化率', 'number', 'measure', null, 'none', { custom: 'converted_cnt / nullif(lead_cnt, 0)', fmt: 'percent' })
    ]
  },
  {
    code: 'rpt_lead_stage', name: '线索阶段分布表', category: '线索', ds: 'ds_lead',
    description: '按线索阶段统计数量',
    fields: [
      F('stage', '线索阶段', 'string', 'dimension', 'stage', 'none', { group: true }),
      F('lead_cnt', '线索数', 'number', 'measure', null, 'count'),
      F('est_amount', '预估金额', 'number', 'measure', 'est_amount', 'sum', { fmt: 'currency' })
    ]
  },
  {
    code: 'rpt_opportunity_stage', name: '商机阶段漏斗表', category: '销售', ds: 'ds_opportunity',
    description: '按商机阶段统计数量与预计金额，用于销售漏斗',
    fields: [
      F('stage', '商机阶段', 'string', 'dimension', 'stage', 'none', { group: true }),
      F('opp_cnt', '商机数', 'number', 'measure', null, 'count'),
      F('est_amount', '预计金额', 'number', 'measure', 'est_amount', 'sum', { fmt: 'currency' }),
      F('avg_win_rate', '平均赢单率', 'number', 'measure', 'win_rate', 'avg', { fmt: 'percent' })
    ]
  },
  {
    code: 'rpt_order_daily', name: '日订单看板表', category: '销售', ds: 'ds_order',
    description: '按下单日期统计订单金额、订单数与客单价，T+1 指标数据源',
    fields: [
      F('order_date', '下单日期', 'date', 'dimension', 'order_date', 'none', { group: true, sort: 'asc' }),
      F('amount', '订单金额', 'number', 'measure', 'amount', 'sum', { fmt: 'currency' }),
      F('cost', '订单成本', 'number', 'measure', 'cost', 'sum', { fmt: 'currency' }),
      F('order_cnt', '订单数', 'number', 'measure', null, 'count'),
      F('customer_cnt', '成交客户数', 'number', 'measure', 'customer_id', 'count_distinct'),
      F('avg_order_amount', '客单价', 'number', 'measure', null, 'none', { custom: 'amount / nullif(order_cnt, 0)', fmt: 'currency' })
    ]
  },
  {
    code: 'rpt_product_sales', name: '产品销售分析表', category: '产品', ds: 'ds_order',
    description: '按产品线与区域统计订单金额与数量',
    fields: [
      F('product', '产品线', 'string', 'dimension', 'product', 'none', { group: true }),
      F('region', '客户区域', 'string', 'dimension', 'region', 'none', { group: true }),
      F('amount', '订单金额', 'number', 'measure', 'amount', 'sum', { fmt: 'currency' }),
      F('quantity', '数量', 'number', 'measure', 'quantity', 'sum'),
      F('order_cnt', '订单数', 'number', 'measure', null, 'count')
    ]
  },
  {
    code: 'rpt_region_product_heat', name: '区域产品金额热度表', category: '产品', ds: 'ds_order',
    description: '区域 × 产品二维热力数据',
    fields: [
      F('region', '客户区域', 'string', 'dimension', 'region', 'none', { group: true }),
      F('product', '产品线', 'string', 'dimension', 'product', 'none', { group: true }),
      F('amount', '订单金额', 'number', 'measure', 'amount', 'sum', { fmt: 'currency' })
    ]
  },
  {
    code: 'rpt_sales_rep', name: '销售业绩排行表', category: '销售', ds: 'ds_contract',
    description: '按销售与部门统计签约金额、合同数与单均金额',
    fields: [
      F('owner_name', '签约人', 'string', 'dimension', 'owner_name', 'none', { group: true }),
      F('owner_dept', '归属部门', 'string', 'dimension', 'owner_dept', 'none', { group: true }),
      F('amount', '合同金额', 'number', 'measure', 'amount', 'sum', { fmt: 'currency', sort: 'desc' }),
      F('contract_cnt', '合同数', 'number', 'measure', null, 'count'),
      F('avg_amount', '单均金额', 'number', 'measure', null, 'none', { custom: 'amount / nullif(contract_cnt, 0)', fmt: 'currency' })
    ]
  },
  {
    code: 'rpt_top_customer', name: '大客户排行表', category: '客户', ds: 'ds_contract',
    description: '按客户统计签约金额（仅统计生效/已完结合同）',
    fields: [
      F('customer_name', '客户名称', 'string', 'dimension', 'customer_name', 'none', { group: true }),
      F('industry', '客户行业', 'string', 'dimension', 'industry', 'none', { group: true }),
      F('region', '客户区域', 'string', 'dimension', 'region', 'none', { group: true }),
      F('amount', '合同金额', 'number', 'measure', 'amount', 'sum', { fmt: 'currency', sort: 'desc' }),
      F('cost', '合同成本', 'number', 'measure', 'cost', 'sum', { fmt: 'currency' }),
      F('contract_cnt', '合同数', 'number', 'measure', null, 'count'),
      F('gross_margin', '毛利率', 'number', 'measure', null, 'none', { custom: '(amount - cost) / nullif(amount, 0)', fmt: 'percent' })
    ],
    filters: [{ key: 'status', op: 'in', value: 'effective,closed' }]
  },
  {
    code: 'rpt_contract_scatter', name: '合同金额成本分布表', category: '合同', ds: 'ds_contract',
    description: '每份合同的金额与成本，用于散点分析',
    fields: [
      F('contract_no', '合同编号', 'string', 'dimension', 'contract_no', 'none', { group: true }),
      F('customer_name', '客户名称', 'string', 'dimension', 'customer_name', 'none', { group: true }),
      F('amount', '合同金额', 'number', 'measure', 'amount', 'sum', { fmt: 'currency' }),
      F('cost', '合同成本', 'number', 'measure', 'cost', 'sum', { fmt: 'currency' }),
      F('profit', '合同毛利', 'number', 'measure', 'profit', 'sum', { fmt: 'currency' })
    ]
  },
  {
    code: 'rpt_region_radar', name: '区域经营雷达表', category: '销售', ds: 'ds_contract',
    description: '区域多维经营指标（金额/成本/毛利/合同数）',
    fields: [
      F('region', '客户区域', 'string', 'dimension', 'region', 'none', { group: true }),
      F('amount', '合同金额', 'number', 'measure', 'amount', 'sum'),
      F('cost', '合同成本', 'number', 'measure', 'cost', 'sum'),
      F('profit', '合同毛利', 'number', 'measure', 'profit', 'sum'),
      F('contract_cnt', '合同数', 'number', 'measure', null, 'count')
    ]
  },
  {
    code: 'rpt_order_status', name: '订单状态分布表', category: '订单', ds: 'ds_order',
    description: '按订单状态统计数量与金额',
    fields: [
      F('status', '订单状态', 'string', 'dimension', 'status', 'none', { group: true }),
      F('order_cnt', '订单数', 'number', 'measure', null, 'count'),
      F('amount', '订单金额', 'number', 'measure', 'amount', 'sum', { fmt: 'currency' })
    ]
  },
  {
    code: 'rpt_contract_detail', name: '合同明细表', category: '合同', ds: 'ds_contract',
    description: '合同明细（不聚合，可分组/排序/导出）',
    fields: [
      F('contract_no', '合同编号', 'string', 'dimension', 'contract_no', 'none'),
      F('contract_name', '合同名称', 'string', 'dimension', 'contract_name', 'none'),
      F('customer_name', '客户名称', 'string', 'dimension', 'customer_name', 'none'),
      F('industry', '客户行业', 'string', 'dimension', 'industry', 'none'),
      F('region', '客户区域', 'string', 'dimension', 'region', 'none'),
      F('sign_date', '签约日期', 'date', 'dimension', 'sign_date', 'none', { sort: 'desc' }),
      F('status', '合同状态', 'string', 'dimension', 'status', 'none'),
      F('pay_type', '付款方式', 'string', 'dimension', 'pay_type', 'none'),
      F('owner_name', '签约人', 'string', 'dimension', 'owner_name', 'none'),
      F('amount', '合同金额', 'number', 'measure', 'amount', 'none', { fmt: 'currency' }),
      F('cost', '合同成本', 'number', 'measure', 'cost', 'none', { fmt: 'currency' }),
      F('profit', '合同毛利', 'number', 'measure', 'profit', 'none', { fmt: 'currency' })
    ]
  },
  {
    code: 'rpt_customer_detail', name: '客户明细表', category: '客户', ds: 'ds_customer',
    description: '客户档案明细',
    fields: [
      F('cust_no', '客户编号', 'string', 'dimension', 'cust_no', 'none'),
      F('cust_name', '客户名称', 'string', 'dimension', 'cust_name', 'none'),
      F('industry', '所属行业', 'string', 'dimension', 'industry', 'none'),
      F('region', '所属区域', 'string', 'dimension', 'region', 'none'),
      F('level', '客户等级', 'string', 'dimension', 'level', 'none'),
      F('source', '客户来源', 'string', 'dimension', 'source', 'none'),
      F('status', '客户状态', 'string', 'dimension', 'status', 'none'),
      F('owner_name', '归属销售', 'string', 'dimension', 'owner_name', 'none'),
      F('create_date', '创建日期', 'date', 'dimension', 'create_date', 'none', { sort: 'desc' }),
      F('credit_limit', '授信额度', 'number', 'measure', 'credit_limit', 'none', { fmt: 'currency' })
    ]
  },
  {
    code: 'rpt_order_detail', name: '订单明细表', category: '订单', ds: 'ds_order',
    description: '订单明细',
    fields: [
      F('order_no', '订单编号', 'string', 'dimension', 'order_no', 'none'),
      F('customer_name', '客户名称', 'string', 'dimension', 'customer_name', 'none'),
      F('product', '产品线', 'string', 'dimension', 'product', 'none'),
      F('status', '订单状态', 'string', 'dimension', 'status', 'none'),
      F('order_date', '下单日期', 'date', 'dimension', 'order_date', 'none', { sort: 'desc' }),
      F('owner_name', '归属销售', 'string', 'dimension', 'owner_name', 'none'),
      F('amount', '订单金额', 'number', 'measure', 'amount', 'none', { fmt: 'currency' }),
      F('quantity', '数量', 'number', 'measure', 'quantity', 'none')
    ]
  },
  {
    code: 'rpt_lead_detail', name: '线索明细表', category: '线索', ds: 'ds_lead',
    description: '线索明细',
    fields: [
      F('lead_no', '线索编号', 'string', 'dimension', 'lead_no', 'none'),
      F('contact_name', '联系人', 'string', 'dimension', 'contact_name', 'none'),
      F('company', '公司名称', 'string', 'dimension', 'company', 'none'),
      F('source', '线索来源', 'string', 'dimension', 'source', 'none'),
      F('stage', '线索阶段', 'string', 'dimension', 'stage', 'none'),
      F('pool_name', '所属线索池', 'string', 'dimension', 'pool_name', 'none'),
      F('owner_name', '归属销售', 'string', 'dimension', 'owner_name', 'none'),
      F('create_date', '创建日期', 'date', 'dimension', 'create_date', 'none', { sort: 'desc' }),
      F('est_amount', '预估金额', 'number', 'measure', 'est_amount', 'none', { fmt: 'currency' })
    ]
  }
];

// ============================================================ 指标（T+1）
// [code, name, group, report, measureKey, agg, dateField, dateMode, unit, precision, direction, desc]
const METRICS = [
  ['m_sales_amount_day', '日销售额', '销售', 'rpt_sales_daily', 'amount', 'avg', 'sign_date', 'day', '元', 2, 'up', '当日合同签约金额合计（T+1）'],
  ['m_sales_mtd', '本月累计销售额', '销售', 'rpt_sales_daily', 'amount', 'sum', 'sign_date', 'mtd', '元', 2, 'up', '当月 1 日至数据日的签约金额累计'],
  ['m_contract_cnt_day', '日签约合同数', '销售', 'rpt_sales_daily', 'contract_cnt', 'avg', 'sign_date', 'day', '份', 0, 'up', '当日新签合同数量'],
  ['m_order_amount_day', '日订单金额', '销售', 'rpt_order_daily', 'amount', 'avg', 'order_date', 'day', '元', 2, 'up', '当日订单金额合计'],
  ['m_order_cnt_day', '日订单数', '销售', 'rpt_order_daily', 'order_cnt', 'avg', 'order_date', 'day', '笔', 0, 'up', '当日订单笔数'],
  ['m_avg_order_amount_day', '日客单价', '销售', 'rpt_order_daily', 'avg_order_amount', 'avg', 'order_date', 'day', '元', 2, 'up', '当日订单金额 / 订单数'],
  ['m_active_customer_day', '日成交客户数', '客户', 'rpt_order_daily', 'customer_cnt', 'max', 'order_date', 'day', '家', 0, 'up', '当日产生订单的去重客户数'],
  ['m_new_customer_day', '日新增客户', '客户', 'rpt_customer_daily', 'cust_cnt', 'avg', 'create_date', 'day', '家', 0, 'up', '当日新建客户档案数量'],
  ['m_new_lead_day', '日新增线索', '线索', 'rpt_lead_daily', 'lead_cnt', 'avg', 'create_date', 'day', '条', 0, 'up', '当日新增线索数量'],
  ['m_lead_convert_day', '日线索转化数', '线索', 'rpt_lead_daily', 'converted_cnt', 'avg', 'create_date', 'day', '条', 0, 'up', '当日转化成交线索数量'],
  ['m_lead_convert_rate_day', '日线索转化率', '线索', 'rpt_lead_daily', 'convert_rate', 'avg', 'create_date', 'day', '%', 2, 'up', '当日转化线索 / 新增线索'],
  ['m_gross_margin_day', '日毛利率', '财务', 'rpt_sales_daily', 'gross_margin', 'avg', 'sign_date', 'day', '%', 2, 'up', '当日(合同金额-成本)/合同金额']
];

// ============================================================ 统计图与卡片
// 通用：{code,name,type:'card'|'chart',chartType,report,metric,dims:[],series:[{key,agg,name,splitBy}],filters,style,scope,sumMode,compare,unit,limit,sortStrategy}
const WIDGETS = [
  // ---- 卡片（指标口径，全局）
  { code: 'w_card_sales_amount', name: '昨日销售额', type: 'card', metric: 'm_sales_amount_day', unit: '元', fmt: 'currency', sumMode: 'latest', compare: 'day', icon: 'money', style: { color: '#2f6bff' } },
  { code: 'w_card_sales_mtd', name: '本月累计销售额', type: 'card', metric: 'm_sales_mtd', unit: '元', fmt: 'currency', sumMode: 'latest', compare: 'month', icon: 'trend', style: { color: '#7c4dff' } },
  { code: 'w_card_contract_cnt', name: '昨日签约合同数', type: 'card', metric: 'm_contract_cnt_day', unit: '份', fmt: 'number', sumMode: 'latest', compare: 'day', icon: 'file', style: { color: '#00a870' } },
  { code: 'w_card_new_customer', name: '昨日新增客户', type: 'card', metric: 'm_new_customer_day', unit: '家', fmt: 'number', sumMode: 'latest', compare: 'day', icon: 'user', style: { color: '#0eb0c9' } },
  { code: 'w_card_new_lead', name: '昨日新增线索', type: 'card', metric: 'm_new_lead_day', unit: '条', fmt: 'number', sumMode: 'latest', compare: 'day', icon: 'funnel', style: { color: '#f5a524' } },
  { code: 'w_card_gross_margin', name: '昨日毛利率', type: 'card', metric: 'm_gross_margin_day', unit: '%', fmt: 'percent', sumMode: 'latest', compare: 'day', icon: 'percent', style: { color: '#e5484d' } },
  { code: 'w_card_order_cnt', name: '昨日订单数', type: 'card', metric: 'm_order_cnt_day', unit: '笔', fmt: 'number', sumMode: 'latest', compare: 'day', icon: 'cart', style: { color: '#00a870' } },
  { code: 'w_card_order_amount', name: '昨日订单金额', type: 'card', metric: 'm_order_amount_day', unit: '元', fmt: 'currency', sumMode: 'latest', compare: 'day', icon: 'money', style: { color: '#2f6bff' } },
  { code: 'w_card_avg_order', name: '昨日客单价', type: 'card', metric: 'm_avg_order_amount_day', unit: '元', fmt: 'currency', sumMode: 'latest', compare: 'day', icon: 'gauge', style: { color: '#7c4dff' } },
  { code: 'w_card_lead_convert_rate', name: '昨日线索转化率', type: 'card', metric: 'm_lead_convert_rate_day', unit: '%', fmt: 'percent', sumMode: 'latest', compare: 'day', icon: 'funnel', style: { color: '#f5a524' } },
  { code: 'w_card_active_customer', name: '昨日成交客户数', type: 'card', metric: 'm_active_customer_day', unit: '家', fmt: 'number', sumMode: 'latest', compare: 'day', icon: 'user', style: { color: '#0eb0c9' } },
  { code: 'w_card_target_rate', name: '月度目标完成率', type: 'card', report: 'rpt_sales_daily', series: [{ key: 'amount', agg: 'sum' }], sumMode: 'mtd', compare: 'none', unit: '%', fmt: 'percent', icon: 'target', style: { color: '#e5484d', target: 100000000 } },
  // ---- 卡片（实时聚合 + 数据范围收敛，销售代表专用）
  { code: 'w_card_my_sales_amount', name: '我的昨日销售额', type: 'card', report: 'rpt_sales_daily', series: [{ key: 'amount', agg: 'sum' }], sumMode: 'latest', compare: 'day', scope: 'self', unit: '元', fmt: 'currency', icon: 'money', style: { color: '#2f6bff' } },
  { code: 'w_card_my_sales_mtd', name: '我的本月累计销售额', type: 'card', report: 'rpt_sales_daily', series: [{ key: 'amount', agg: 'sum' }], sumMode: 'mtd', compare: 'month', scope: 'self', unit: '元', fmt: 'currency', icon: 'trend', style: { color: '#7c4dff' } },
  { code: 'w_card_my_customer', name: '我的客户总数', type: 'card', report: 'rpt_customer_daily', series: [{ key: 'cust_cnt', agg: 'count' }], sumMode: 'all', compare: 'none', scope: 'self', unit: '家', fmt: 'number', icon: 'user', style: { color: '#0eb0c9' } },
  { code: 'w_card_lead_pool', name: '线索池待领取', type: 'card', report: 'rpt_lead_stage', series: [{ key: 'lead_cnt', agg: 'count' }], filters: [{ key: 'pool_state', op: 'eq', value: '在池' }], sumMode: 'all', compare: 'none', scope: 'global', unit: '条', fmt: 'number', icon: 'inbox', style: { color: '#f5a524' } },
  { code: 'w_card_pending_order', name: '待付款订单数', type: 'card', report: 'rpt_order_status', series: [{ key: 'order_cnt', agg: 'count' }], filters: [{ key: 'status', op: 'eq', value: 'pending' }], sumMode: 'all', compare: 'none', scope: 'dept', unit: '笔', fmt: 'number', icon: 'clock', style: { color: '#e5484d' } },

  // ---- 统计图
  { code: 'w_chart_sales_trend', name: '近30天销售趋势', type: 'chart', chartType: 'line', report: 'rpt_sales_daily', dims: ['sign_date'], series: [{ key: 'amount', agg: 'sum', name: '合同金额' }, { key: 'contract_cnt', agg: 'count', name: '合同数' }], filters: [{ key: 'sign_date', op: 'ge', value: '$D30' }], sortStrategy: 'axis', style: { smooth: true, legend: 'top', palette: 'blue' } },
  { code: 'w_chart_region_rank', name: '区域销售排行', type: 'chart', chartType: 'bar', report: 'rpt_sales_by_region', dims: ['region'], series: [{ key: 'amount', agg: 'sum', name: '合同金额' }], sortStrategy: 'value_desc', style: { showLabel: true, palette: 'blue' } },
  { code: 'w_chart_industry_pie', name: '客户行业分布', type: 'chart', chartType: 'pie', report: 'rpt_customer_industry', dims: ['industry'], series: [{ key: 'cust_cnt', agg: 'count', name: '客户数' }], style: { legend: 'right', palette: 'multi', doughnut: false } },
  { code: 'w_chart_month_trend', name: '月度签约趋势', type: 'chart', chartType: 'area', report: 'rpt_sales_month', dims: ['sign_month'], series: [{ key: 'amount', agg: 'sum', name: '合同金额' }, { key: 'contract_cnt', agg: 'count', name: '合同数' }], sortStrategy: 'axis', style: { smooth: true, legend: 'top', palette: 'purple' } },
  { code: 'w_chart_funnel', name: '商机阶段漏斗', type: 'chart', chartType: 'funnel', report: 'rpt_opportunity_stage', dims: ['stage'], series: [{ key: 'opp_cnt', agg: 'count', name: '商机数' }], sortStrategy: 'value_desc', style: { palette: 'multi' } },
  { code: 'w_chart_heatmap', name: '区域-产品金额热度', type: 'chart', chartType: 'heatmap', report: 'rpt_region_product_heat', dims: ['region', 'product'], series: [{ key: 'amount', agg: 'sum', name: '订单金额' }], style: { palette: 'heat' } },
  { code: 'w_chart_lead_source', name: '线索来源分布', type: 'chart', chartType: 'bar_h', report: 'rpt_lead_source', dims: ['source'], series: [{ key: 'lead_cnt', agg: 'count', name: '线索数' }, { key: 'converted_cnt', agg: 'sum', name: '已转化' }], sortStrategy: 'value_desc', style: { palette: 'orange' } },
  { code: 'w_chart_top_customer', name: '大客户 TOP10', type: 'chart', chartType: 'bar_h', report: 'rpt_top_customer', dims: ['customer_name'], series: [{ key: 'amount', agg: 'sum', name: '合同金额' }], sortStrategy: 'value_desc', limit: 10, style: { showLabel: true, palette: 'green' } },
  { code: 'w_chart_product_stack', name: '产品-区域金额（堆叠）', type: 'chart', chartType: 'bar', report: 'rpt_product_sales', dims: ['product'], series: [{ key: 'amount', agg: 'sum', name: '订单金额', splitBy: 'region' }], sortStrategy: 'value_desc', style: { stack: true, palette: 'multi', legend: 'top' } },
  { code: 'w_chart_rep_rank', name: '销售业绩排行', type: 'chart', chartType: 'bar', report: 'rpt_sales_rep', dims: ['owner_name'], series: [{ key: 'amount', agg: 'sum', name: '合同金额' }], sortStrategy: 'value_desc', limit: 10, style: { showLabel: true, palette: 'blue' } },
  { code: 'w_chart_order_status', name: '订单状态分布', type: 'chart', chartType: 'doughnut', report: 'rpt_order_status', dims: ['status'], series: [{ key: 'order_cnt', agg: 'count', name: '订单数' }], style: { palette: 'multi', legend: 'right' } },
  { code: 'w_chart_scatter', name: '合同金额-成本分布', type: 'chart', chartType: 'scatter', report: 'rpt_contract_scatter', dims: ['customer_name'], series: [{ key: 'amount', agg: 'sum', name: '合同金额' }, { key: 'cost', agg: 'sum', name: '合同成本' }], limit: 200, style: { palette: 'blue' } },
  { code: 'w_chart_radar', name: '区域经营雷达', type: 'chart', chartType: 'radar', report: 'rpt_region_radar', dims: ['region'], series: [{ key: 'amount', agg: 'sum', name: '合同金额' }, { key: 'profit', agg: 'sum', name: '合同毛利' }, { key: 'contract_cnt', agg: 'count', name: '合同数' }], limit: 6, style: { palette: 'multi' } },
  { code: 'w_chart_gauge', name: '月度目标完成率', type: 'chart', chartType: 'gauge', metric: 'm_sales_mtd', style: { target: 100000000, palette: 'red' } },
  { code: 'w_chart_my_trend', name: '我的近30天销售趋势', type: 'chart', chartType: 'area', report: 'rpt_sales_daily', dims: ['sign_date'], series: [{ key: 'amount', agg: 'sum', name: '我的合同金额' }], filters: [{ key: 'sign_date', op: 'ge', value: '$D30' }], scope: 'self', sortStrategy: 'axis', style: { smooth: true, palette: 'blue' } },
  { code: 'w_chart_my_industry', name: '我的客户行业分布', type: 'chart', chartType: 'pie', report: 'rpt_customer_industry', dims: ['industry'], series: [{ key: 'cust_cnt', agg: 'count', name: '客户数' }], scope: 'self', style: { legend: 'right', palette: 'multi' } },
  { code: 'w_chart_my_top_customer', name: '我的大客户 TOP5', type: 'chart', chartType: 'bar_h', report: 'rpt_top_customer', dims: ['customer_name'], series: [{ key: 'amount', agg: 'sum', name: '合同金额' }], scope: 'self', sortStrategy: 'value_desc', limit: 5, style: { showLabel: true, palette: 'green' } },
  { code: 'w_chart_lead_convert_trend', name: '线索转化率趋势', type: 'chart', chartType: 'line', report: 'rpt_lead_daily', dims: ['create_date'], series: [{ key: 'convert_rate', agg: 'none', name: '转化率' }, { key: 'lead_cnt', agg: 'count', name: '新增线索' }], filters: [{ key: 'create_date', op: 'ge', value: '$D60' }], sortStrategy: 'axis', style: { smooth: true, palette: 'orange' } },
  { code: 'w_chart_customer_trend', name: '客户新增趋势', type: 'chart', chartType: 'bar', report: 'rpt_customer_daily', dims: ['create_date'], series: [{ key: 'cust_cnt', agg: 'count', name: '新增客户' }], filters: [{ key: 'create_date', op: 'ge', value: '$D90' }], sortStrategy: 'axis', style: { palette: 'teal' } }
];

// ============================================================ 驾驶舱
const DASHBOARDS = [
  {
    code: 'dash_exec', name: '经营驾驶舱', description: '面向总经理/管理员的全局经营视图', isDefault: true,
    cards: ['w_card_sales_amount', 'w_card_sales_mtd', 'w_card_contract_cnt', 'w_card_new_customer', 'w_card_new_lead', 'w_card_gross_margin', 'w_card_target_rate'],
    charts: ['w_chart_sales_trend', 'w_chart_region_rank', 'w_chart_month_trend', 'w_chart_funnel', 'w_chart_heatmap', 'w_chart_industry_pie', 'w_chart_rep_rank', 'w_chart_gauge']
  },
  {
    code: 'dash_sales', name: '销售作战室', description: '面向销售总监的团队业绩视图',
    cards: ['w_card_sales_amount', 'w_card_sales_mtd', 'w_card_contract_cnt', 'w_card_order_cnt', 'w_card_order_amount', 'w_card_lead_convert_rate', 'w_card_lead_pool', 'w_card_pending_order'],
    charts: ['w_chart_rep_rank', 'w_chart_region_rank', 'w_chart_lead_source', 'w_chart_order_status', 'w_chart_radar', 'w_chart_scatter', 'w_chart_lead_convert_trend', 'w_chart_top_customer']
  },
  {
    code: 'dash_rep', name: '销售个人工作台', description: '面向销售代表/客服的本人业绩视图',
    cards: ['w_card_my_sales_amount', 'w_card_my_sales_mtd', 'w_card_my_customer', 'w_card_contract_cnt', 'w_card_order_cnt', 'w_card_lead_pool'],
    charts: ['w_chart_my_trend', 'w_chart_my_industry', 'w_chart_my_top_customer', 'w_chart_order_status']
  },
  {
    code: 'dash_analyst', name: '数据分析工作台', description: '面向数据分析师的建模与监控视图',
    cards: ['w_card_sales_amount', 'w_card_sales_mtd', 'w_card_gross_margin', 'w_card_avg_order', 'w_card_lead_convert_rate', 'w_card_active_customer', 'w_card_target_rate'],
    charts: ['w_chart_sales_trend', 'w_chart_industry_pie', 'w_chart_heatmap', 'w_chart_product_stack', 'w_chart_gauge', 'w_chart_lead_convert_trend', 'w_chart_customer_trend', 'w_chart_radar']
  },
  {
    code: 'dash_service', name: '客户服务看板', description: '面向客服专员的客户与线索维护视图',
    cards: ['w_card_new_customer', 'w_card_new_lead', 'w_card_lead_pool', 'w_card_my_customer'],
    charts: ['w_chart_industry_pie', 'w_chart_lead_source', 'w_chart_customer_trend']
  }
];

// ============================================================ 任务
const TASKS = [
  ['task_metric_daily', 'T+1 指标日计算', 'metric_calc', '0 30 1 * * *', 1, '{"all":true}', '每天 01:30 计算前一天全部启用指标，写入 bi_metric_value'],
  ['task_metric_recalc', '指标补算（近 7 天）', 'metric_backfill', '0 30 2 * * *', 7, '{"all":true}', '每天 02:30 重算近 7 天指标，修正迟到数据'],
  ['task_archive', '历史数据归档校验', 'data_archive', '0 0 3 * * 0', 0, '{"keepMonths":24}', '每周日 03:00 校验历史数据完整性']
];

// ============================================================ 写入
async function bulkInsert(table, cols, rows, returning) {
  if (!rows.length) return [];
  const out = [];
  const chunk = 300;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params = [];
    const vs = [];
    part.forEach((r) => {
      vs.push('(' + r.map((_, ci) => `$${params.length + ci + 1}`).join(',') + ')');
      params.push(...r);
    });
    const res = await q(`insert into ${table} (${cols.join(',')}) values ${vs.join(',')}` + (returning ? ` returning ${returning}` : ''), params);
    if (returning) out.push(...res.rows);
  }
  return out;
}

async function run() {
  // 角色
  await bulkInsert('sys_role', ['code', 'name', 'description', 'sort_no'], ROLES);
  // 用户
  const userRows = USERS.map((u) => [u[0], bcrypt.hashSync(u[1], 8), u[2], u[3], u[4], u[5], u[6], u[7], '1']);
  await bulkInsert('sys_user', ['username', 'password', 'real_name', 'role_code', 'dept', 'phone', 'email', 'data_scope', 'status'], userRows);
  const adminId = (await one("select id from sys_user where username='ana01'")).id;
  // 菜单
  await bulkInsert('sys_menu', ['code', 'parent_code', 'name', 'path', 'icon', 'sort_no'], MENUS);
  // 权限
  const aclRows = [];
  Object.entries(ACL).forEach(([role, conf]) => {
    Object.entries(conf).forEach(([type, keys]) => {
      const t = type === 'card' ? 'card' : type === 'chart' ? 'chart' : type === 'dashboard' ? 'dashboard' : type === 'menu' ? 'menu' : 'action';
      keys.forEach((k) => aclRows.push([role, t, k]));
    });
  });
  await bulkInsert('sys_acl', ['role_code', 'res_type', 'res_key'], aclRows);

  // 数据集
  const dsId = {};
  for (const d of DATASETS) {
    const r = await one(
      `insert into rpt_dataset (code,name,base_table,base_alias,joins,date_field,owner_field,dept_field,description,status)
       values ($1,$2,$3,'t',$4::jsonb,$5,$6,$7,$8,'1') returning id`,
      [d.code, d.name, d.base_table, JSON.stringify(d.joins), d.date_field, d.owner_field, d.dept_field, d.name]
    );
    dsId[d.code] = r.id;
    await bulkInsert('rpt_dataset_field', ['dataset_id', 'field_key', 'field_name', 'field_type', 'field_role', 'expr', 'enum_options', 'sort_no'],
      d.fields.map((f, i) => [r.id, f[0], f[1], f[2], f[3], f[4], f[5] || null, i + 1]));
  }

  // 报表
  const rptId = {};
  for (const r of REPORTS) {
    const row = await one(
      `insert into rpt_report (code,name,category,dataset_id,description,owner_id,status,is_public) values ($1,$2,$3,$4,$5,$6,'1',true) returning id`,
      [r.code, r.name, r.category, dsId[r.ds], r.description, adminId]
    );
    rptId[r.code] = row.id;
    await bulkInsert('rpt_report_field',
      ['report_id', 'field_key', 'field_name', 'field_type', 'field_role', 'dataset_field_key', 'agg_fn', 'custom_expr', 'is_group_by', 'is_show', 'is_custom', 'sort_dir', 'fmt', 'sort_no'],
      r.fields.map((f, i) => [row.id, f.key, f.name, f.type, f.role, f.dsKey, f.agg, f.custom || null, !!f.group, true, !!f.custom, f.sort || 'none', f.fmt || null, (i + 1) * 10]));
    if (r.filters) {
      await bulkInsert('rpt_report_filter', ['report_id', 'field_key', 'op', 'value', 'logic', 'sort_no'],
        r.filters.map((f, i) => [row.id, f.key, f.op, f.value, 'and', i + 1]));
    }
  }

  // 指标
  const metricId = {};
  for (const m of METRICS) {
    const row = await one(
      `insert into bi_metric (code,name,metric_group,report_id,measure_key,agg_fn,date_field_key,date_mode,unit,precision,direction,description,owner_id,status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'1') returning id`,
      [m[0], m[1], m[2], rptId[m[3]], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], adminId]
    );
    metricId[m[0]] = row.id;
  }

  // 统计图 / 卡片
  const widgetId = {};
  for (const w of WIDGETS) {
    const row = await one(
      `insert into bi_widget (code,name,widget_type,chart_type,value_mode,metric_id,report_id,dimension_keys,series,filters,sort_strategy,limit_rows,scope,sum_mode,compare,style,unit,prefix,icon,sort_no,status)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,'1') returning id`,
      [
        w.code, w.name, w.type, w.chartType || null,
        w.metric ? 'metric' : 'direct',
        w.metric ? metricId[w.metric] : null,
        w.report ? rptId[w.report] : null,
        JSON.stringify(w.dims || []), JSON.stringify(w.series || []), JSON.stringify(w.filters || []),
        w.sortStrategy || 'value_desc', w.limit || 20, w.scope || 'global', w.sumMode || 'latest', w.compare || 'none',
        JSON.stringify(w.style || {}), w.unit || null, null, w.icon || null, 0
      ]
    );
    widgetId[w.code] = row.id;
  }

  // 驾驶舱
  for (const d of DASHBOARDS) {
    const row = await one(
      `insert into bi_dashboard (code,name,description,owner_id,is_default,sort_no,status) values ($1,$2,$3,$4,$5,$6,'1') returning id`,
      [d.code, d.name, d.description, adminId, !!d.isDefault, 0]
    );
    let sort = 0;
    const rows = [
      ...d.cards.map((c) => [c, 6, 128]),
      ...d.charts.map((c) => [c, 8, 300])
    ];
    await bulkInsert('bi_dashboard_widget', ['dashboard_id', 'widget_id', 'col_span', 'height', 'sort_no'],
      rows.map((r) => [row.id, widgetId[r[0]], r[1], r[2], (sort += 10)]));
  }

  // 任务
  for (const t of TASKS) {
    await q(
      `insert into bi_task (code,name,task_type,cron_expr,date_offset,target,status,owner_id,description) values ($1,$2,$3,$4,$5,$6::jsonb,'1',$7,$8)`,
      [t[0], t[1], t[2], t[3], t[4], t[5], adminId, t[6]]
    );
  }

  return {
    roles: ROLES.length, users: USERS.length, menus: MENUS.length, acl: aclRows.length,
    datasets: DATASETS.length, dataset_fields: DATASETS.reduce((s, d) => s + d.fields.length, 0),
    reports: REPORTS.length, metrics: METRICS.length, widgets: WIDGETS.length, dashboards: DASHBOARDS.length, tasks: TASKS.length
  };
}

module.exports = { run, REPORTS, DATASETS, WIDGETS, METRICS };
