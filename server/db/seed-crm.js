'use strict';
/**
 * 演示业务数据生成器：客户 / 联系人 / 线索池 / 线索 / 商机 / 合同 / 订单 / 跟进记录
 * 使用确定性随机（mulberry32），数据有趋势与季节性，保证统计图与环比指标有真实形态。
 */
const { q } = require('./index');

// ---------------------------------------------------------------- 工具
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261013);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const money = (a, b) => Math.round((a + rnd() * (b - a)) * 100) / 100;
const chance = (p) => rnd() < p;
const pad = (n, w = 4) => String(n).padStart(w, '0');
const d2 = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ts = (d) => `${d2(d)} ${String(int(8, 20)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}:00`;
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

async function bulk(table, cols, rows, returning) {
  if (!rows.length) return [];
  const out = [];
  const chunk = 200;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const values = [];
    const params = [];
    part.forEach((r) => {
      values.push('(' + r.map((_, ci) => `$${params.length + ci + 1}`).join(',') + ')');
      params.push(...r);
    });
    const sql = `insert into ${table} (${cols.join(',')}) values ${values.join(',')}` + (returning ? ` returning ${returning}` : '');
    const res = await q(sql, params);
    if (returning) out.push(...res.rows);
  }
  return out;
}

// ---------------------------------------------------------------- 基础字典
const REGIONS = ['华东', '华北', '华南', '华中', '西南', '西北', '东北'];
const REGION_W = [0.30, 0.20, 0.18, 0.12, 0.08, 0.06, 0.06];
const INDUSTRIES = ['智能制造', '金融保险', '医疗健康', '教育培训', '互联网', '政府事业', '能源电力'];
const SOURCES = ['官网注册', '展会获客', '客户转介绍', '信息流广告', '电话陌拜', '线上活动'];
const SOURCE_W = [0.22, 0.12, 0.20, 0.18, 0.13, 0.15];
const LEVELS = ['A', 'B', 'C', 'D'];
const CUST_STATUS = ['potential', 'active', 'inactive'];
const LEAD_STAGES = ['new', 'following', 'qualified', 'converted', 'invalid'];
const OPP_STAGES = ['初步接洽', '需求确认', '方案报价', '商务谈判', '赢单', '输单'];
const PRODUCTS = ['智学云课堂', '智慧书法平台', 'AI 作业批改', '数据中台', '私有化部署', '运维服务包'];
const CONTRACT_STATUS = ['draft', 'approving', 'effective', 'closed', 'void'];
const PAY_TYPES = ['一次性', '分期', '年付'];
const ORDER_STATUS = ['pending', 'paid', 'delivered', 'done', 'refund'];
const FOLLOW_WAYS = ['电话', '拜访', '微信', '邮件'];
const FOLLOW_RESULT = ['有意向', '需跟进', '已拒绝', '已成交'];
const SURNAME = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜';
const GIVEN = ['志强', '淑兰', '海涛', '丽娟', '俊杰', '晓东', '婷婷', '文博', '雅琴', '国强', '思远', '梦琪', '云帆', '子涵'];
const CITY = { 华东: ['上海', '杭州', '南京', '苏州'], 华北: ['北京', '天津', '石家庄', '太原'], 华南: ['广州', '深圳', '厦门', '东莞'], 华中: ['武汉', '长沙', '郑州'], 西南: ['成都', '重庆', '昆明'], 西北: ['西安', '兰州'], 东北: ['沈阳', '大连', '长春'] };
const COMPANY_PREFIX = ['华', '中', '东', '新', '金', '天', '恒', '宏', '博', '远', '联', '创'];
const COMPANY_MID = ['晟', '瑞', '泰', '业', '科', '腾', '达', '盛', '信', '智'];
const COMPANY_SUFFIX = ['科技有限公司', '信息技术有限公司', '数字科技股份有限公司', '教育科技有限公司', '智能装备有限公司', '网络科技有限公司'];
const POSITIONS = ['总经理', '技术总监', '采购经理', '信息部经理', '教研主任', '项目经理', '财务总监'];

function weighted(list, weights) {
  let r = rnd(), acc = 0;
  for (let i = 0; i < list.length; i++) { acc += weights[i]; if (r <= acc) return list[i]; }
  return list[0];
}
function personName() { return SURNAME[Math.floor(rnd() * SURNAME.length)] + pick(GIVEN); }
function companyName(region) {
  const city = pick(CITY[region] || CITY.华东);
  return city + pick(COMPANY_PREFIX) + pick(COMPANY_MID) + pick(COMPANY_SUFFIX);
}
function phone() { return '1' + pick(['3', '5', '7', '8', '9']) + String(int(100000000, 999999999)).slice(0, 9); }

/** 季节性系数：年末冲量 + 年中偏弱 + 自然增长 */
function seasonFactor(d) {
  const m = d.getMonth() + 1;
  const season = { 1: 0.75, 2: 0.7, 3: 1.05, 4: 1.0, 5: 1.05, 6: 1.15, 7: 0.85, 8: 0.9, 9: 1.1, 10: 1.05, 11: 1.15, 12: 1.35 }[m];
  return season;
}

async function run() {
  const today = require('../services/reportEngine').today();
  const start = addDays(today, -400);
  const totalDays = 400;

  const users = await q('select id, real_name, dept, role_code from sys_user order by id');
  const reps = users.rows.filter((u) => u.role_code === 'sales_rep');
  const directors = users.rows.filter((u) => u.role_code === 'sales_director');
  const anyStaff = [...reps, ...directors];
  const deptOf = (u) => u.dept;

  // ------------------------------------------------------------ 客户
  const customers = [];
  const N_CUST = 360;
  for (let i = 1; i <= N_CUST; i++) {
    // 越靠近现在新增越多
    let offset = Math.floor(Math.pow(rnd(), 0.62) * totalDays);
    const created = addDays(start, offset);
    const region = weighted(REGIONS, REGION_W);
    const owner = pick(reps);
    const status = weighted(CUST_STATUS, [0.42, 0.44, 0.14]);
    customers.push({
      cust_no: 'C' + pad(10000 + i, 5),
      name: companyName(region),
      short_name: null,
      industry: pick(INDUSTRIES),
      region,
      level: weighted(LEVELS, [0.15, 0.3, 0.35, 0.2]),
      source: weighted(SOURCES, SOURCE_W),
      status,
      credit_limit: money(50000, 3000000),
      owner_id: owner.id,
      owner_dept: deptOf(owner),
      phone: phone(),
      email: null,
      address: pick(CITY[region]) + '高新区科技路' + int(1, 200) + '号',
      remark: null,
      created_at: ts(created),
      updated_at: ts(created)
    });
  }
  const custRows = customers.map((c) => [c.cust_no, c.name, c.short_name, c.industry, c.region, c.level, c.source, c.status, c.credit_limit, c.owner_id, c.owner_dept, c.phone, c.email, c.address, c.remark, c.created_at, c.updated_at]);
  const custIds = (await bulk('crm_customer', ['cust_no', 'name', 'short_name', 'industry', 'region', 'level', 'source', 'status', 'credit_limit', 'owner_id', 'owner_dept', 'phone', 'email', 'address', 'remark', 'created_at', 'updated_at'], custRows, 'id')).map((r) => r.id);

  // ------------------------------------------------------------ 联系人
  const contactRows = [];
  custIds.forEach((cid) => {
    const n = chance(0.45) ? 2 : 1;
    for (let k = 0; k < n; k++) {
      contactRows.push([cid, personName(), pick(POSITIONS), phone(), null, k === 0]);
    }
  });
  await bulk('crm_contact', ['customer_id', 'name', 'position', 'phone', 'email', 'is_primary'], contactRows);

  // ------------------------------------------------------------ 线索池
  const poolRows = [
    ['POOL_PUBLIC', '公共线索池', '未分配的市场线索，销售可自助领取', JSON.stringify({ assign: 'claim' }), 800, '1', directors[0] ? directors[0].id : null],
    ['POOL_EAST', '华东区线索池', '按区域分配的线索', JSON.stringify({ assign: 'region', region: '华东' }), 400, '1', directors[0] ? directors[0].id : null],
    ['POOL_NORTH', '华北区线索池', '按区域分配的线索', JSON.stringify({ assign: 'region', region: '华北' }), 400, '1', directors[0] ? directors[0].id : null],
    ['POOL_STRATEGY', '战略客户线索池', '大客户线索，仅总监及以上可分配', JSON.stringify({ assign: 'manual' }), 200, '1', directors[0] ? directors[0].id : null]
  ];
  const poolIds = (await bulk('crm_lead_pool', ['code', 'name', 'description', 'rule_json', 'capacity', 'status', 'owner_id'], poolRows, 'id')).map((r) => r.id);

  // ------------------------------------------------------------ 线索
  const leadRows = [];
  const N_LEAD = 900;
  for (let i = 1; i <= N_LEAD; i++) {
    const created = addDays(start, Math.floor(Math.pow(rnd(), 0.62) * totalDays));
    const region = weighted(REGIONS, REGION_W);
    const stage = weighted(LEAD_STAGES, [0.16, 0.22, 0.18, 0.28, 0.16]);
    const inPool = stage === 'new' ? chance(0.75) : chance(0.18);
    const owner = inPool ? null : pick(reps);
    const pool = inPool ? (region === '华东' ? poolIds[1] : region === '华北' ? poolIds[2] : poolIds[0]) : null;
    const converted = stage === 'converted';
    leadRows.push([
      'L' + pad(20000 + i, 5), personName(), companyName(region), phone(), null,
      pick(INDUSTRIES), region, weighted(SOURCES, SOURCE_W), stage,
      weighted(['高', '中', '低'], [0.25, 0.45, 0.3]),
      money(20000, 900000), pool, owner ? owner.id : null, owner ? deptOf(owner) : null,
      inPool, inPool ? null : ts(created), converted ? pick(custIds) : null,
      converted ? ts(addDays(created, int(3, 30))) : null,
      ts(addDays(created, int(0, 20))), ts(created), ts(created)
    ]);
  }
  await bulk('crm_lead', ['lead_no', 'name', 'company', 'phone', 'wechat', 'industry', 'region', 'source', 'stage', 'intent_level', 'est_amount', 'pool_id', 'owner_id', 'owner_dept', 'in_pool', 'claim_time', 'customer_id', 'converted_at', 'last_follow_at', 'created_at', 'updated_at'], leadRows);

  // ------------------------------------------------------------ 商机
  const oppRows = [];
  const N_OPP = 460;
  for (let i = 1; i <= N_OPP; i++) {
    const created = addDays(start, Math.floor(Math.pow(rnd(), 0.62) * totalDays));
    const owner = pick(reps);
    const stage = weighted(OPP_STAGES, [0.12, 0.18, 0.2, 0.16, 0.22, 0.12]);
    oppRows.push([
      'O' + pad(30000 + i, 5), companyName(pick(REGIONS)) + ' 项目', pick(custIds), null, stage,
      money(50000, 2500000), int(10, 95), d2(addDays(created, int(15, 120))), owner.id, deptOf(owner),
      ts(created), ['赢单', '输单'].includes(stage) ? ts(addDays(created, int(20, 150))) : null
    ]);
  }
  const oppIds = (await bulk('crm_opportunity', ['opp_no', 'name', 'customer_id', 'lead_id', 'stage', 'est_amount', 'win_rate', 'expect_date', 'owner_id', 'owner_dept', 'created_at', 'closed_at'], oppRows, 'id')).map((r) => r.id);

  // ------------------------------------------------------------ 合同（含趋势与季节性）
  const contractBase = [];
  for (let d = 0; d < totalDays; d++) {
    const date = addDays(start, d);
    const growth = 1 + d / totalDays * 0.9;                 // 自然增长
    const base = 5 * growth * seasonFactor(date);           // 日均合同数
    const weekday = date.getDay();
    const wf = weekday === 0 ? 0.25 : weekday === 6 ? 0.6 : 1.05;
    contractBase.push(Math.max(0.4, base * wf));
  }
  const contractRows = [];
  let cNo = 1;
  contractBase.forEach((expected, d) => {
    const date = addDays(start, d);
    const cnt = Math.floor(expected) + (rnd() < expected % 1 ? 1 : 0);
    for (let k = 0; k < cnt; k++) {
      const cIdx = Math.floor(Math.pow(rnd(), 0.9) * custIds.length);
      const owner = pick(reps);
      const amount = money(30000, 1500000) * (chance(0.06) ? 3.2 : 1);
      const cost = Math.round(amount * (0.42 + rnd() * 0.35) * 100) / 100;
      const status = d > totalDays - 25 ? weighted(CONTRACT_STATUS, [0.25, 0.3, 0.3, 0.1, 0.05]) : weighted(CONTRACT_STATUS, [0.02, 0.05, 0.45, 0.45, 0.03]);
      contractRows.push([
        'HT' + String(new Date(date).getFullYear()) + pad(cNo++, 5), '销售合同-' + pad(cNo, 5), custIds[cIdx], pick(oppIds),
        Math.round(amount * 100) / 100, cost, 0.06, d2(date), d2(date), d2(addDays(date, int(180, 720))),
        status, weighted(PAY_TYPES, [0.4, 0.4, 0.2]), owner.id, deptOf(owner), ts(date), ts(date)
      ]);
    }
  });
  const contractIdRows = await bulk('crm_contract', ['contract_no', 'name', 'customer_id', 'opp_id', 'amount', 'cost', 'tax_rate', 'sign_date', 'start_date', 'end_date', 'status', 'pay_type', 'owner_id', 'owner_dept', 'created_at', 'updated_at'], contractRows, 'id, customer_id, owner_id, owner_dept, sign_date, amount, cost');
  const contracts = contractIdRows;

  // ------------------------------------------------------------ 订单
  const orderRows = [];
  let oNo = 1;
  let leadF = 0; let leadO = 0;
  for (const c of contracts) {
    const signStr = typeof c.sign_date === 'string' ? c.sign_date.slice(0, 10) : d2(new Date(c.sign_date));
    const signDate = new Date(signStr + 'T00:00:00');
    const n = int(1, 3);
    for (let k = 0; k < n; k++) {
      const orderDate = addDays(signDate, int(0, 12));
      if (orderDate > today) continue;
      const amount = Math.round(Number(c.amount) / n * (0.85 + rnd() * 0.3) * 100) / 100;
      const cost = Math.round(Number(c.cost) / n * (0.9 + rnd() * 0.25) * 100) / 100;
      const ageDays = Math.round((today - orderDate) / 86400000);
      const status = ageDays < 10 ? weighted(ORDER_STATUS, [0.4, 0.35, 0.15, 0.05, 0.05]) : weighted(ORDER_STATUS, [0.03, 0.08, 0.17, 0.66, 0.06]);
      orderRows.push([
        'DD' + String(orderDate.getFullYear()) + pad(oNo++, 5), c.id, c.customer_id, pick(PRODUCTS), int(1, 6),
        amount, cost, weighted([0, 0.03, 0.05, 0.08], [0.6, 0.15, 0.15, 0.1]), status, d2(orderDate),
        ['paid', 'delivered', 'done'].includes(status) ? d2(addDays(orderDate, int(1, 30))) : null,
        c.owner_id, c.owner_dept, ts(orderDate)
      ]);
    }
  }
  await bulk('crm_order', ['order_no', 'contract_id', 'customer_id', 'product', 'quantity', 'amount', 'cost', 'discount', 'status', 'order_date', 'pay_date', 'owner_id', 'owner_dept', 'created_at'], orderRows);

  // ------------------------------------------------------------ 订单回款（参考纷享销客订单及回款管理）
  // 对已付款/已交付/已完成/已退款的订单生成 1~3 笔回款记录
  const paidOrders = orderRows.filter((r) => ['paid', 'delivered', 'done', 'refund'].includes(r[8]));
  const payMethod = ['对公转账', '银行转账', '支票'];
  const payRows = [];
  // crm_order.id 与插入顺序一致（serial 从 1 开始），paidOrders[i] 对应 id = i+1 仅在全部订单顺序插入时成立
  // 更稳妥：用 order_no 反查
  const orderNos = await q(`select id, order_no, amount, pay_date, owner_id from crm_order`);
  const noMap = {};
  orderNos.rows.forEach((r) => { noMap[r.order_no] = r; });
  for (let i = 0; i < orderRows.length; i++) {
    const o = orderRows[i];
    if (!['paid', 'delivered', 'done'].includes(o[8])) continue;
    const real = noMap[o[0]];
    if (!real) continue;
    const orderAmount = Number(real.amount);
    const baseDate = real.pay_date || o[9];
    const n = int(1, 3);
    let remain = orderAmount;
    for (let k = 0; k < n; k++) {
      const isLast = k === n - 1;
      const amt = isLast ? remain : Math.round(remain * (0.3 + rnd() * 0.4) * 100) / 100;
      remain = Math.round((remain - amt) * 100) / 100;
      if (amt <= 0) continue;
      const baseStr = baseDate instanceof Date ? d2(baseDate) : String(baseDate).slice(0, 10);
      const pd = addDays(new Date(baseStr + 'T00:00:00'), k);
      payRows.push([real.id, Math.round(amt * 100) / 100, d2(pd), pick(payMethod), isLast ? '尾款结清' : '阶段回款', real.owner_id, ts(pd)]);
    }
  }
  if (payRows.length) await bulk('crm_payment', ['order_id', 'amount', 'pay_date', 'method', 'remark', 'owner_id', 'created_at'], payRows);

  // ------------------------------------------------------------ 跟进记录
  const followRows = [];
  for (let i = 0; i < 1600; i++) {
    const isLead = chance(0.5);
    const created = addDays(start, Math.floor(Math.pow(rnd(), 0.5) * totalDays));
    const owner = pick(reps);
    followRows.push([
      isLead ? 'lead' : 'customer',
      isLead ? int(1, N_LEAD) : pick(custIds),
      pick(['电话回访，客户表示近期有采购计划，需推进方案', '微信沟通，客户关注价格与实施周期', '上门拜访，已确认需求范围，安排 demo', '邮件发送报价单，等待反馈', '客户暂缓项目，三个月后跟进']),
      pick(FOLLOW_WAYS), pick(FOLLOW_RESULT),
      ts(addDays(created, int(1, 15))), owner.id, ts(created)
    ]);
  }
  await bulk('crm_follow_up', ['biz_type', 'biz_id', 'content', 'way', 'result', 'next_time', 'owner_id', 'created_at'], followRows);

  const counts = await q(`select
    (select count(*) from crm_customer)::int as customer,
    (select count(*) from crm_contact)::int as contact,
    (select count(*) from crm_lead)::int as lead,
    (select count(*) from crm_opportunity)::int as opportunity,
    (select count(*) from crm_contract)::int as contract,
    (select count(*) from crm_order)::int as "order",
    (select count(*) from crm_payment)::int as payment,
    (select count(*) from crm_follow_up)::int as follow_up`);
  return counts.rows[0];
}

module.exports = { run };
