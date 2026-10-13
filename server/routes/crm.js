'use strict';
/**
 * CRM 业务接口
 *  - 通用分页/检索/排序/增删改（表驱动配置）
 *  - 角色数据范围：all 全部 / dept 本部门 / self 仅本人
 *  - 线索：领取、分配、转客户；客户/合同/订单 360 视图
 */
const express = require('express');
const { q, one, many, num, getDb } = require('../db');
const acl = require('../services/acl');

const router = express.Router();

const ENT = {
  customer: {
    table: 'crm_customer', label: '客户',
    select: 't.*, u.real_name as owner_name',
    joins: 'left join sys_user u on u.id = t.owner_id',
    scope: { owner: 't.owner_id', dept: 't.owner_dept' },
    search: ['t.name', 't.cust_no', 't.phone', 't.industry', 't.region'],
    order: 't.id desc',
    code: { field: 'cust_no', prefix: 'C', start: 10001 },
    write: { cust_no: 'text', name: 'text', short_name: 'text', industry: 'text', region: 'text', level: 'text', source: 'text', status: 'text', credit_limit: 'number', owner_id: 'number', owner_dept: 'text', phone: 'text', email: 'text', address: 'text', remark: 'text' },
    filterable: ['industry', 'region', 'level', 'source', 'status', 'owner_id'],
    perm: 'customer'
  },
  contact: {
    table: 'crm_contact', label: '联系人',
    select: 't.*, c.name as customer_name',
    joins: 'left join crm_customer c on c.id = t.customer_id',
    scope: null,
    search: ['t.name', 't.phone'],
    order: 't.id desc',
    write: { customer_id: 'number', name: 'text', position: 'text', phone: 'text', email: 'text', is_primary: 'bool' },
    filterable: ['customer_id'],
    perm: 'customer'
  },
  lead: {
    table: 'crm_lead', label: '线索',
    select: 't.*, p.name as pool_name, u.real_name as owner_name',
    joins: 'left join crm_lead_pool p on p.id = t.pool_id left join sys_user u on u.id = t.owner_id',
    scope: { owner: 't.owner_id', dept: 't.owner_dept' },
    search: ['t.name', 't.company', 't.lead_no', 't.phone'],
    order: 't.id desc',
    code: { field: 'lead_no', prefix: 'L', start: 20001 },
    write: { lead_no: 'text', name: 'text', company: 'text', phone: 'text', wechat: 'text', industry: 'text', region: 'text', source: 'text', stage: 'text', intent_level: 'text', est_amount: 'number', pool_id: 'number', owner_id: 'number', owner_dept: 'text', in_pool: 'bool' },
    filterable: ['source', 'stage', 'intent_level', 'region', 'industry', 'pool_id', 'in_pool', 'owner_id'],
    perm: 'lead'
  },
  leadPool: {
    table: 'crm_lead_pool', label: '线索池',
    select: 't.*, u.real_name as owner_name, (select count(*)::int from crm_lead l where l.pool_id = t.id and l.in_pool) as lead_count, (select count(*)::int from crm_lead l where l.pool_id = t.id and l.in_pool and l.stage = \'new\') as new_count',
    joins: 'left join sys_user u on u.id = t.owner_id',
    scope: null,
    search: ['t.name', 't.code'],
    order: 't.id',
    code: { field: 'code', prefix: 'POOL', start: 1 },
    write: { code: 'text', name: 'text', description: 'text', capacity: 'number', status: 'text', owner_id: 'number' },
    filterable: ['status'],
    perm: 'lead'
  },
  opportunity: {
    table: 'crm_opportunity', label: '商机',
    select: 't.*, c.name as customer_name, u.real_name as owner_name',
    joins: 'left join crm_customer c on c.id = t.customer_id left join sys_user u on u.id = t.owner_id',
    scope: { owner: 't.owner_id', dept: 't.owner_dept' },
    search: ['t.name', 't.opp_no', 'c.name'],
    order: 't.id desc',
    code: { field: 'opp_no', prefix: 'O', start: 30001 },
    write: { opp_no: 'text', name: 'text', customer_id: 'number', lead_id: 'number', stage: 'text', est_amount: 'number', win_rate: 'number', expect_date: 'date', owner_id: 'number', owner_dept: 'text' },
    filterable: ['stage', 'owner_id', 'customer_id'],
    perm: 'opp'
  },
  contract: {
    table: 'crm_contract', label: '合同',
    select: 't.*, c.name as customer_name, c.industry, c.region, u.real_name as owner_name',
    joins: 'left join crm_customer c on c.id = t.customer_id left join sys_user u on u.id = t.owner_id',
    scope: { owner: 't.owner_id', dept: 't.owner_dept' },
    search: ['t.name', 't.contract_no', 'c.name'],
    order: 't.sign_date desc, t.id desc',
    code: { field: 'contract_no', prefix: 'HT', start: 50001 },
    write: { contract_no: 'text', name: 'text', customer_id: 'number', opp_id: 'number', amount: 'number', cost: 'number', tax_rate: 'number', sign_date: 'date', start_date: 'date', end_date: 'date', status: 'text', pay_type: 'text', owner_id: 'number', owner_dept: 'text' },
    filterable: ['status', 'pay_type', 'owner_id', 'customer_id'],
    perm: 'contract'
  },
  order: {
    table: 'crm_order', label: '订单',
    select: 't.*, c.name as customer_name, c.industry, c.region, u.real_name as owner_name, (select coalesce(sum(p.amount),0) from crm_payment p where p.order_id = t.id) as paid_amount',
    joins: 'left join crm_customer c on c.id = t.customer_id left join sys_user u on u.id = t.owner_id',
    scope: { owner: 't.owner_id', dept: 't.owner_dept' },
    search: ['t.order_no', 'c.name', 't.product'],
    order: 't.order_date desc, t.id desc',
    code: { field: 'order_no', prefix: 'DD', start: 80001 },
    write: { order_no: 'text', contract_id: 'number', customer_id: 'number', product: 'text', quantity: 'number', amount: 'number', cost: 'number', discount: 'number', status: 'text', order_date: 'date', pay_date: 'date', owner_id: 'number', owner_dept: 'text' },
    filterable: ['status', 'product', 'owner_id', 'customer_id'],
    perm: 'order'
  },
  followUp: {
    table: 'crm_follow_up', label: '跟进记录',
    select: 't.*, u.real_name as owner_name',
    joins: 'left join sys_user u on u.id = t.owner_id',
    scope: { owner: 't.owner_id', dept: null },
    search: ['t.content', 't.result'],
    order: 't.id desc',
    write: { biz_type: 'text', biz_id: 'number', content: 'text', way: 'text', result: 'text', next_time: 'datetime', owner_id: 'number' },
    filterable: ['biz_type', 'biz_id', 'way', 'result'],
    perm: 'follow'
  }
};

function scopeSql(ent, user, params) {
  if (!user || user.dataScope === 'all') return '';
  if (ent === ENT.contact) {
    const scoped = scopeSql(ENT.customer, user, params).replace(/t\./g, 'sc.');
    return ` and exists (select 1 from crm_customer sc where sc.id = t.customer_id ${scoped})`;
  }
  if (ent === ENT.followUp) {
    const branches = ['customer', 'lead', 'opportunity', 'contract'].map((kind) => {
      const scoped = scopeSql(ENT[kind], user, params).replace(/t\./g, 'sc.');
      return `(t.biz_type = '${kind}' and exists (select 1 from ${ENT[kind].table} sc where sc.id = t.biz_id ${scoped}))`;
    });
    return ` and (${branches.join(' or ')})`;
  }
  if (!ent.scope) return '';
  if (user.dataScope === 'self' && ent.scope.owner) { params.push(user.id); return ` and ${ent.scope.owner} = $${params.length}`; }
  if (user.dataScope === 'dept' && ent.scope.dept) { params.push(user.dept); return ` and ${ent.scope.dept} = $${params.length}`; }
  return '';
}

async function scopedRecord(ent, id, user) {
  const params = [Number(id)];
  const scope = scopeSql(ent, user, params);
  return one(`select t.* from ${ent.table} t where t.id = $1 ${scope}`, params);
}

function listScope(ent, user, params) {
  const scope = scopeSql(ent, user, params);
  // 未领取线索属于共享线索池；领取后按归属隔离。
  return ent === ENT.lead && scope ? ` and (${scope.replace(/^ and /, '')} or t.in_pool = true)` : scope;
}

const MENU = { customer: 'crm_customer', contact: 'crm_customer', lead: 'crm_lead', leadPool: 'crm_lead_pool', opportunity: 'crm_opportunity', 'opportunity-board': 'crm_opportunity', opp: 'crm_opportunity', contract: 'crm_contract', order: 'crm_order', payment: 'crm_order', 'customer-pool': 'crm_pool' };
// Apply resource permissions and record scope to every CRM entry point.
router.use((req, res, next) => {
  (async () => {
    const parts = req.path.split('/').filter(Boolean);
    let kind = parts[0];
    if (kind === 'options') return next();
    const p = await acl.perms(req.user.role);
    if (kind === 'picklist') {
      kind = ({ pool: 'leadPool', owner: null })[parts[1]] || parts[1];
      if (parts[1] === 'owner') return next();
    }
    if (kind === 'followUp') {
      if (!['crm_customer', 'crm_lead', 'crm_opportunity', 'crm_contract'].some((m) => acl.can(p, 'menu', m)) && req.user.role !== 'admin')
        return res.status(403).json({ code: 403, message: '无权限查看跟进记录' });
    } else if (MENU[kind] && req.user.role !== 'admin' && !acl.can(p, 'menu', MENU[kind]))
      return res.status(403).json({ code: 403, message: '无权限访问该业务模块' });
    let ent = ENT[kind === 'opp' ? 'opportunity' : kind];
    const id = parts[1];
    if (kind === 'payment' && req.method === 'POST') { ent = ENT.order; }
    if (kind === 'customer-pool' && parts[2] === 'release') { ent = ENT.customer; }
    const recordId = kind === 'payment' ? req.body.orderId : id;
    const hasRecordId = ent && parts[0] !== 'picklist' && recordId != null && recordId !== 'summary';
    if (hasRecordId && (!/^[1-9]\d*$/.test(String(recordId)) || !Number.isSafeInteger(Number(recordId))))
      return res.status(400).json({ code: 400, message: '记录编号必须是正整数' });
    if (hasRecordId) {
      const row = kind === 'lead' && ['claim', 'assign'].includes(parts[2])
        ? await one('select * from crm_lead where id=$1 and in_pool=true', [Number(recordId)]) || await scopedRecord(ent, recordId, req.user)
        : await scopedRecord(ent, recordId, req.user);
      if (!row) return res.status(404).json({ code: 404, message: '记录不存在或不在当前数据范围内' });
    }
    if (['POST', 'PUT'].includes(req.method) && ENT[kind]) {
      const b = req.body || {};
      if (req.user.dataScope !== 'all' && req.method === 'PUT' && ('owner_id' in b && b.owner_id == null || 'owner_dept' in b && b.owner_dept == null))
        return res.status(400).json({ code: 400, message: '请使用退回公海功能变更客户归属' });
      if (req.user.dataScope !== 'all' && (b.owner_id != null || b.owner_dept != null)) {
        const owner = await one("select id, dept from sys_user where id=$1 and status='1'", [Number(b.owner_id || req.user.id)]);
        if (!owner || (req.user.dataScope === 'self' && owner.id !== req.user.id) || (req.user.dataScope === 'dept' && owner.dept !== req.user.dept))
          return res.status(403).json({ code: 403, message: '归属人超出当前数据范围' });
        b.owner_id = owner.id; b.owner_dept = owner.dept;
      }
      if (ENT[kind].write.owner_dept && b.owner_id != null) {
        const owner = await one("select dept from sys_user where id=$1 and status='1'", [Number(b.owner_id)]);
        if (!owner) return res.status(400).json({ code: 400, message: '归属人不存在或已停用' });
        b.owner_dept = owner.dept;
      }
      for (const [field, related] of [['customer_id', 'customer'], ['contract_id', 'contract'], ['lead_id', 'lead'], ['opp_id', 'opportunity']]) {
        if (b[field] != null && !await scopedRecord(ENT[related], b[field], req.user))
          return res.status(400).json({ code: 400, message: '关联记录不存在或不在当前数据范围内' });
      }
      if (kind === 'followUp') {
        if (!['customer', 'lead', 'opportunity', 'contract'].includes(b.biz_type) || !await scopedRecord(ENT[b.biz_type], b.biz_id, req.user))
          return res.status(400).json({ code: 400, message: '请选择有效的跟进对象' });
        if (!String(b.content || '').trim() || String(b.content).length > 500)
          return res.status(400).json({ code: 400, message: '跟进内容须为 1–500 字' });
        b.owner_id = req.user.id;
      }
      for (const field of ['amount', 'cost', 'credit_limit', 'est_amount', 'quantity', 'win_rate', 'capacity', 'discount', 'tax_rate']) {
        if (b[field] == null) continue;
        const value = Number(b[field]);
        if (!Number.isFinite(value) || value < 0 || (field === 'win_rate' && value > 100) || (['discount', 'tax_rate'].includes(field) && value > 1))
          return res.status(400).json({ code: 400, message: '请填写有效的金额、数量或比例' });
      }
      if (kind === 'opportunity' && b.stage && !OPP_STAGES.includes(b.stage))
        return res.status(400).json({ code: 400, message: '商机阶段无效' });
    }
    next();
  })().catch(next);
});

function coerce(type, v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (type === 'number') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (type === 'bool') return v === true || v === 'true' || v === '1' || v === 1;
  if (type === 'json') return typeof v === 'string' ? v : JSON.stringify(v);
  return String(v);
}

async function nextCode(ent) {
  if ((await getDb()).mode === 'pg') {
    const kind = Object.keys(ENT).find((key) => ENT[key] === ent);
    return (await one('select crm_next_code($1) as code', [kind])).code;
  }
  const c = ent.code;
  const row = await one(`select coalesce(max(cast(nullif(regexp_replace(${c.field}, '[^0-9]', '', 'g'), '') as bigint)), ${c.start - 1}) + 1 as n from ${ent.table}`);
  const n = num(row.n) || c.start;
  return c.prefix + String(n).padStart(5, '0');
}

// ---------------------------------------------------------------- 元数据
router.get('/options', async (req, res) => {
  res.json({
    code: 0, data: {
      industry: ['智能制造', '金融保险', '医疗健康', '教育培训', '互联网', '政府事业', '能源电力'],
      region: ['华东', '华北', '华南', '华中', '西南', '西北', '东北'],
      source: ['官网注册', '展会获客', '客户转介绍', '信息流广告', '电话陌拜', '线上活动'],
      level: ['A', 'B', 'C', 'D'],
      customerStatus: [['potential', '潜在客户'], ['active', '成交客户'], ['inactive', '流失客户']],
      leadStage: [['new', '新线索'], ['following', '跟进中'], ['qualified', '已确认'], ['converted', '已转客户'], ['invalid', '无效']],
      intentLevel: ['高', '中', '低'],
      oppStage: ['初步接洽', '需求确认', '方案报价', '商务谈判', '赢单', '输单'],
      contractStatus: [['draft', '草稿'], ['approving', '审批中'], ['effective', '生效'], ['closed', '已完结'], ['void', '作废']],
      payType: ['一次性', '分期', '年付'],
      orderStatus: [['pending', '待付款'], ['paid', '已付款'], ['delivered', '已交付'], ['done', '已完成'], ['refund', '已退款']],
      product: ['智学云课堂', '智慧书法平台', 'AI 作业批改', '数据中台', '私有化部署', '运维服务包'],
      followWay: ['电话', '拜访', '微信', '邮件'],
      followResult: ['有意向', '需跟进', '已拒绝', '已成交']
    }
  });
});

// 下拉用：客户/合同/线索简要列表
router.get('/picklist/:kind', async (req, res) => {
  const kind = req.params.kind;
  let rows = [];
  if (kind === 'customer') rows = await many('select id, name, cust_no from crm_customer order by id desc limit 500');
  else if (kind === 'contract') rows = await many('select id, name, contract_no, customer_id, amount from crm_contract order by id desc limit 500');
  else if (kind === 'lead') rows = await many('select id, name, company, lead_no from crm_lead order by id desc limit 500');
  else if (kind === 'opportunity') rows = await many('select id, name, opp_no from crm_opportunity order by id desc limit 300');
  else if (kind === 'pool') rows = await many('select id, name, code from crm_lead_pool order by id');
  else if (kind === 'owner') rows = await many("select id, real_name as name, dept from sys_user where status = '1' order by id");
  const entity = { customer: 'customer', contract: 'contract', lead: 'lead', opportunity: 'opportunity' }[kind];
  if (entity) {
    const params = [];
    const scope = scopeSql(ENT[entity], req.user, params);
    rows = await many(`select t.id, t.name, ${entity === 'customer' ? 't.cust_no' : entity === 'contract' ? 't.contract_no, t.customer_id, t.amount' : entity === 'lead' ? 't.company, t.lead_no' : 't.opp_no'} from ${ENT[entity].table} t where 1=1 ${scope} order by t.id desc limit 500`, params);
  }
  if (kind === 'owner' && req.user.dataScope !== 'all') rows = rows.filter((u) => req.user.dataScope === 'self' ? u.id === req.user.id : u.dept === req.user.dept);
  res.json({ code: 0, data: rows });
});

// ---------------------------------------------------------------- 通用列表/详情/增删改
router.get('/opportunity-board', async (req,res) => {
  const params=[]; const filters=[];
  if(req.query.keyword) { params.push('%'+req.query.keyword+'%'); filters.push(`(coalesce(t.name,'')||' '||coalesce(t.opp_no,'')||' '||coalesce(c.name,'')) ilike $${params.length}`); }
  if(req.query.stage) { params.push(req.query.stage); filters.push(`t.stage=$${params.length}`); }
  const scope=scopeSql(ENT.opportunity,req.user,params);
  const lanes=await many(`with ranked as (
    select ${ENT.opportunity.select},row_number() over(partition by t.stage order by t.expect_date nulls last,t.id desc) as rn
    from crm_opportunity t ${ENT.opportunity.joins} where 1=1 ${filters.length?' and '+filters.join(' and '):''} ${scope}
  ), grouped as (
    select stage,count(*)::int as count,coalesce(sum(est_amount),0) as amount,
      count(*) filter(where expect_date<current_date and stage not in ('赢单','输单'))::int as overdue,
      jsonb_agg(to_jsonb(ranked)-'rn' order by rn) filter(where rn<=10) as rows from ranked group by stage
  ) select * from grouped`,params);
  res.json({code:0,data:{lanes,total:lanes.reduce((s,l)=>s+l.count,0),perStage:10}});
});

router.get('/:entity', async (req, res, next) => {
  const ent = ENT[req.params.entity];
  if (!ent) return next();
  const page = Math.max(1, Number(req.query.page || 1));
  const size = Math.min(500, Math.max(1, Number(req.query.size || 20)));
  const params = [];
  const where = [];
  if (req.query.keyword) {
    params.push('%' + req.query.keyword + '%');
    if ((await getDb()).mode === 'pg' && ['customer','lead'].includes(req.params.entity)) {
      where.push(`(${ent.search.map((s) => `coalesce(${s},'')`).join("||' '||")} ) ilike $${params.length}`);
    } else where.push('(' + ent.search.map((s) => `cast(${s} as text) ilike $${params.length}`).join(' or ') + ')');
  }
  Object.keys(req.query).forEach((k) => {
    if (!k.startsWith('f.')) return;
    const field = k.slice(2);
    if (!ent.filterable.includes(field) && !ent.write[field]) return;
    const v = req.query[k];
    if (v === '' || v === undefined || v === null) return;
    params.push(v === 'true' ? true : v === 'false' ? false : v);
    where.push(`t.${field} = $${params.length}`);
  });
  let sql = `from ${ent.table} t ${ent.joins} where 1=1`;
  if (where.length) sql += ' and ' + where.join(' and ');
  sql += listScope(ent, req.user, params);
  const cnt = await one(`select count(*)::int as c ${sql}`, params);
  const sortBy = ent.write[req.query.sortBy] ? `t.${req.query.sortBy}` : null;
  const sortDir = String(req.query.sortDir).toLowerCase() === 'asc' ? 'asc' : 'desc';
  const order = sortBy ? `${sortBy} ${sortDir}` : ent.order;
  const rows = await many(`select ${ent.select} ${sql} order by ${order} limit ${size} offset ${(page - 1) * size}`, params);
  res.json({ code: 0, data: { rows, total: num(cnt.c), page, size, entity: req.params.entity, label: ent.label } });
});

router.get('/:entity/:id', async (req, res) => {
  const ent = ENT[req.params.entity];
  if (!ent) return res.status(404).json({ code: 404, message: '未知实体' });
  const row = await one(`select ${ent.select} from ${ent.table} t ${ent.joins} where t.id = $1`, [Number(req.params.id)]);
  if (!row) return res.status(404).json({ code: 404, message: '记录不存在' });
  res.json({ code: 0, data: row });
});

router.post('/:entity', async (req, res, next) => {
  const ent = ENT[req.params.entity];
  if (!ent) return next();
  const p = await acl.perms(req.user.role);
  if (req.user.role !== 'admin' && !acl.can(p, 'action', `${ent.perm}:add`)) {
    return res.status(403).json({ code: 403, message: `无权限新增${ent.label}` });
  }
  const b = req.body || {};
  const cols = [];
  const vals = [];
  const params = [];
  for (const [f, t] of Object.entries(ent.write)) {
    if ((ent.code && f === ent.code.field && !b[f]) || (f === 'owner_id' && !b[f]) || (b[f] === null && !['phone', 'email', 'address', 'remark'].includes(f))) continue;
    const v = coerce(t, b[f]);
    if (v === undefined) continue;
    cols.push(f); params.push(v); vals.push('$' + params.length);
  }
  if (ent.code && !cols.includes(ent.code.field)) {
    cols.push(ent.code.field); params.push(await nextCode(ent)); vals.push('$' + params.length);
  }
  // 归属人默认取当前用户（销售代表）
  if (ent.write.owner_id && !cols.includes('owner_id')) {
    cols.push('owner_id'); params.push(req.user.id); vals.push('$' + params.length);
  }
  if (ent.write.owner_dept && !cols.includes('owner_dept')) {
    cols.push('owner_dept'); params.push(req.user.dept); vals.push('$' + params.length);
  }
  if (!cols.length) return res.status(400).json({ code: 400, message: '没有可写入的字段' });
  const row = await one(`insert into ${ent.table} (${cols.join(',')}) values (${vals.join(',')}) returning id`, params);
  await q('insert into sys_oper_log (user_id, username, action, res_type, res_key, detail) values ($1,$2,$3,$4,$5,$6)',
    [req.user.id, req.user.username, 'create', req.params.entity, String(row.id), JSON.stringify(b).slice(0, 500)]);
  res.json({ code: 0, data: { id: row.id }, message: `${ent.label}已保存` });
});

router.put('/:entity/:id', async (req, res) => {
  const ent = ENT[req.params.entity];
  if (!ent) return res.status(404).json({ code: 404, message: '未知实体' });
  const p = await acl.perms(req.user.role);
  if (req.user.role !== 'admin' && !acl.can(p, 'action', `${ent.perm}:edit`)) {
    return res.status(403).json({ code: 403, message: `无权限修改${ent.label}` });
  }
  const b = req.body || {};
  const sets = [];
  const params = [];
  for (const [f, t] of Object.entries(ent.write)) {
    if (!(f in b)) continue;
    const v = coerce(t, b[f]);
    params.push(v); sets.push(`${f} = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ code: 400, message: '没有需要更新的字段' });
  params.push(Number(req.params.id));
  let sql = `update ${ent.table} set ${sets.join(', ')}`;
  if (ent.write.updated_at !== undefined || ['crm_customer', 'crm_lead', 'crm_contract'].includes(ent.table)) sql += `, updated_at = now()`;
  sql += ` where id = $${params.length}`;
  await q(sql, params);
  await q('insert into sys_oper_log (user_id, username, action, res_type, res_key, detail) values ($1,$2,$3,$4,$5,$6)',
    [req.user.id, req.user.username, 'update', req.params.entity, String(req.params.id), JSON.stringify(b).slice(0, 500)]);
  res.json({ code: 0, message: `${ent.label}已更新` });
});

router.delete('/:entity/:id', async (req, res) => {
  const ent = ENT[req.params.entity];
  if (!ent) return res.status(404).json({ code: 404, message: '未知实体' });
  const p = await acl.perms(req.user.role);
  if (req.user.role !== 'admin' && !acl.can(p, 'action', `${ent.perm}:delete`)) {
    return res.status(403).json({ code: 403, message: `无权限删除${ent.label}` });
  }
  await q(`delete from ${ent.table} where id = $1`, [Number(req.params.id)]);
  res.json({ code: 0, message: '已删除' });
});

// ---------------------------------------------------------------- 线索动作
router.post('/lead/:id/claim', async (req, res) => {
  const perms = await acl.perms(req.user.role);
  if (req.user.role !== 'admin' && !acl.can(perms, 'action', 'lead:claim')) return res.status(403).json({ code: 403, message: '无权限领取线索' });
  const id = Number(req.params.id);
  const lead = await one('select * from crm_lead where id = $1', [id]);
  if (!lead) return res.status(404).json({ code: 404, message: '线索不存在' });
  if (!lead.in_pool) return res.status(400).json({ code: 400, message: '该线索已被其他销售领取' });
  const claimed = await q(`update crm_lead set in_pool = false, owner_id = $1, owner_dept = $2, claim_time = now(), stage = case when stage = 'new' then 'following' else stage end, updated_at = now() where id = $3 and in_pool = true`,
    [req.user.id, req.user.dept, id]);
  if (!claimed.rowCount) return res.status(409).json({ code: 409, message: '该线索已被领取，请刷新' });
  res.json({ code: 0, message: '领取成功，该线索已归入你的名下' });
});

router.post('/lead/:id/assign', async (req, res) => {
  const p = await acl.perms(req.user.role);
  if (req.user.role !== 'admin' && !acl.can(p, 'action', 'lead:assign')) return res.status(403).json({ code: 403, message: '无权限分配线索' });
  const id = Number(req.params.id);
  const owner = await one('select * from sys_user where id = $1', [Number((req.body || {}).ownerId)]);
  if (!owner || owner.status !== '1') return res.status(400).json({ code: 400, message: '目标销售不存在或已停用' });
  if (req.user.dataScope === 'dept' && owner.dept !== req.user.dept) return res.status(403).json({ code: 403, message: '不能分配给其他部门的销售' });
  await q(`update crm_lead set owner_id = $1, owner_dept = $2, in_pool = false, claim_time = now(), updated_at = now() where id = $3`,
    [owner.id, owner.dept, id]);
  res.json({ code: 0, message: `已分配给 ${owner.real_name}` });
});

router.post('/lead/:id/convert', async (req, res) => {
  const perms = await acl.perms(req.user.role);
  if (req.user.role !== 'admin' && !acl.can(perms, 'action', 'lead:edit')) return res.status(403).json({ code: 403, message: '无权限转化线索' });
  const id = Number(req.params.id);
  if ((await getDb()).mode === 'pg') {
    const result = await one('select * from crm_convert_lead($1)', [id]);
    return res.json({ code: 0, data: { customerId: result.customer_id, custNo: result.cust_no }, message: '已转化为客户：' + result.cust_no });
  }
  const lead = await one('select * from crm_lead where id = $1', [id]);
  if (!lead) return res.status(404).json({ code: 404, message: '线索不存在' });
  if (lead.customer_id) return res.status(400).json({ code: 400, message: '该线索已转为客户' });
  const code = await nextCode(ENT.customer);
  const cust = await one(`insert into crm_customer (cust_no, name, industry, region, source, level, status, phone, owner_id, owner_dept, remark)
    values ($1,$2,$3,$4,$5,'B','potential',$6,$7,$8,$9) returning id`,
    [code, lead.company || lead.name, lead.industry, lead.region, lead.source, lead.phone, lead.owner_id || req.user.id, lead.owner_dept || req.user.dept, `由线索 ${lead.lead_no} 转化`]);
  await q('insert into crm_contact (customer_id, name, phone, is_primary) values ($1,$2,$3,true)', [cust.id, lead.name, lead.phone]);
  await q(`update crm_lead set stage = 'converted', customer_id = $1, converted_at = now(), in_pool = false, updated_at = now() where id = $2`, [cust.id, id]);
  res.json({ code: 0, data: { customerId: cust.id, custNo: code }, message: '已转化为客户：' + code });
});

// ---------------------------------------------------------------- 客户公海
// 公海定义：潜在客户（status=potential）且尚未归属任何销售；成交/流失客户不进公海
router.get('/customer-pool', async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const size = Math.min(200, Math.max(1, Number(req.query.size || 20)));
  const params = [];
  const extra = [];
  if (req.query.keyword) {
    params.push('%' + req.query.keyword + '%');
    extra.push(`(cast(c.name as text) like $${params.length} or cast(c.cust_no as text) like $${params.length} or cast(c.industry as text) like $${params.length} or cast(c.region as text) like $${params.length})`);
  }
  ['industry', 'region', 'level', 'source'].forEach((field) => {
    const k = 'f.' + field;
    if (!(k in req.query) || req.query[k] === '' || req.query[k] == null) return;
    params.push(req.query[k]);
    extra.push(`c.${field} = $${params.length}`);
  });
  const where = ` where c.status = 'potential' and c.owner_id is null ${extra.length ? 'and ' + extra.join(' and ') : ''}`;
  const cnt = await one(`select count(*)::int as c from crm_customer c${where}`, params);
  const rows = await many(
    `select c.*, u.real_name as owner_name from crm_customer c left join sys_user u on u.id = c.owner_id${where}
     order by c.created_at desc limit ${size} offset ${(page - 1) * size}`, params);
  const stat = await one(`select
      (select count(*)::int from crm_customer where status = 'potential' and owner_id is null) as total,
      (select count(*)::int from crm_customer where status = 'potential' and owner_id is not null) as claimed,
      coalesce((select sum(credit_limit) from crm_customer where status = 'potential' and owner_id is null), 0) as pool_credit`);
  res.json({ code: 0, data: { rows, total: num(cnt.c), page, size, stat } });
});

router.post('/customer-pool/:id/claim', async (req, res) => {
  const p = await acl.perms(req.user.role);
  if (req.user.role !== 'admin' && !acl.can(p, 'action', 'customer-pool:claim') && !acl.can(p, 'action', 'customer:edit')) {
    return res.status(403).json({ code: 403, message: '无权限领取公海客户' });
  }
  const id = Number(req.params.id);
  const c = await one('select * from crm_customer where id = $1', [id]);
  if (!c || c.status !== 'potential' || c.owner_id) return res.status(400).json({ code: 400, message: '该客户不在公海（已被领取或状态不是潜在客户）' });
  // 仅本人/本部门范围的销售领取后归入本人；全部数据范围用户领取的归全局公海
  const setOwner = req.user.id;
  const setDept = req.user.dept;
  const claimed = await q(`update crm_customer set owner_id = $1, owner_dept = $2, updated_at = now() where id = $3 and owner_id is null and status = 'potential'`,
    [setOwner, setDept, id]);
  if (!claimed.rowCount) return res.status(409).json({ code: 409, message: '该客户已被领取，请刷新' });
  await q('insert into sys_oper_log (user_id, username, action, res_type, res_key, detail) values ($1,$2,$3,$4,$5,$6)',
    [req.user.id, req.user.username, 'claim', 'customer_pool', String(id), `领取公海客户 ${c.cust_no}`]);
  res.json({ code: 0, message: setOwner ? `已领取 ${c.cust_no}，归入你的名下` : `已领取 ${c.cust_no}（全局共享池）` });
});

router.post('/customer-pool/:id/release', async (req, res) => {
  const p = await acl.perms(req.user.role);
  if (req.user.role !== 'admin' && !acl.can(p, 'action', 'customer-pool:release')) {
    return res.status(403).json({ code: 403, message: '无权限退回公海' });
  }
  const id = Number(req.params.id);
  const c = await one('select * from crm_customer where id = $1', [id]);
  if (!c) return res.status(404).json({ code: 404, message: '客户不存在' });
  if (c.status !== 'potential') return res.status(400).json({ code: 400, message: '仅潜在客户可退回公海' });
  await q(`update crm_customer set owner_id = null, owner_dept = null, status = 'potential', updated_at = now() where id = $1`, [id]);
  res.json({ code: 0, message: `${c.cust_no} 已退回公海` });
});

// ---------------------------------------------------------------- 订单回款（参考纷享销客：订单及回款管理）
router.get('/payment', async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const size = Math.min(500, Math.max(1, Number(req.query.size || 20)));
  const params = [];
  const where = [];
  if (req.query.orderId) { params.push(req.query.orderId); where.push(`o.id = $${params.length}`); }
  if (req.query.contractId) { params.push(req.query.contractId); where.push(`o.contract_id = $${params.length}`); }
  if (req.query.customerId) { params.push(req.query.customerId); where.push(`o.customer_id = $${params.length}`); }
  if (req.query.keyword) {
    params.push('%' + req.query.keyword + '%');
    where.push(`(cast(o.order_no as text) like $${params.length} or cast(c.name as text) like $${params.length} or cast(p.remark as text) like $${params.length})`);
  }
  const scope = scopeSql(ENT.order, req.user, params).replace(/t\./g, 'o.');
  const w = ' where 1=1' + (where.length ? ' and ' + where.join(' and ') : '') + scope;
  const params2 = [...params];
  const cnt = await one(
    `select count(*)::int as c from crm_payment p
     join crm_order o on o.id = p.order_id
     left join crm_customer c on c.id = o.customer_id${w}`, params2);
  const rows = await many(
    `select p.*, o.order_no, o.amount as order_amount, c.name as customer_name,
        (select coalesce(sum(p2.amount),0) from crm_payment p2 where p2.order_id = o.id) as paid_amount,
        o.status as order_status
     from crm_payment p
     join crm_order o on o.id = p.order_id
     left join crm_customer c on c.id = o.customer_id${w}
     order by p.pay_date desc, p.id desc limit ${size} offset ${(page - 1) * size}`, params2);
  res.json({ code: 0, data: { rows, total: num(cnt.c), page, size } });
});

router.post('/payment', async (req, res) => {
  const p = await acl.perms(req.user.role);
  if (req.user.role !== 'admin' && !acl.can(p, 'action', 'payment:add') && !acl.can(p, 'action', 'order:edit')) {
    return res.status(403).json({ code: 403, message: '无权限登记回款' });
  }
  const b = req.body || {};
  if (!b.orderId || !b.amount || !b.payDate) return res.status(400).json({ code: 400, message: '订单 / 金额 / 回款日期必填' });
  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount < 0.01 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001) return res.status(400).json({ code: 400, message: '回款金额至少 0.01 元，最多两位小数' });
  const result = await (await getDb()).transaction(async (tx) => {
    const o = (await tx.query('select * from crm_order where id=$1 for update', [Number(b.orderId)])).rows[0];
    if (!o) return { error: '订单不存在' };
    if (o.status === 'refund') return { error: '已退款订单不能登记回款' };
    const previous = (await tx.query('select coalesce(sum(amount),0) as s from crm_payment where order_id=$1', [o.id])).rows[0];
    const totalPaid = Math.round((num(previous.s) + amount) * 100) / 100;
    if (Math.round(totalPaid * 100) > Math.round(num(o.amount) * 100)) return { error: '回款金额不能超过订单未收款金额' };
    const row = (await tx.query(`insert into crm_payment (order_id, amount, pay_date, method, remark, owner_id) values ($1,$2,$3,$4,$5,$6) returning id`, [o.id, amount, b.payDate, b.method || '对公转账', b.remark || null, req.user.id])).rows[0];
    if (totalPaid >= num(o.amount) && o.status === 'pending') await tx.query("update crm_order set status='paid', pay_date=$1 where id=$2", [b.payDate, o.id]);
    return { id: row.id, totalPaid, orderAmount: num(o.amount) };
  });
  if (result.error) return res.status(400).json({ code: 400, message: result.error });
  res.json({ code: 0, data: { id: result.id }, message: `回款已登记，该订单累计回款 ${result.totalPaid}/${result.orderAmount}` });
});

// ---------------------------------------------------------------- 商机阶段推进（参考纷享销客：阶段推进 + 赢率评估）
const OPP_STAGES = ['初步接洽', '需求确认', '方案报价', '商务谈判', '赢单', '输单'];
const STAGE_RATE = { '初步接洽': 15, '需求确认': 35, '方案报价': 55, '商务谈判': 75, '赢单': 100, '输单': 0 };

router.post('/opp/:id/advance', async (req, res) => {
  const p = await acl.perms(req.user.role);
  if (req.user.role !== 'admin' && !acl.can(p, 'action', 'opp:edit')) {
    return res.status(403).json({ code: 403, message: '无权限推进商机' });
  }
  const id = Number(req.params.id);
  const o = await one('select * from crm_opportunity where id = $1', [id]);
  if (!o) return res.status(404).json({ code: 404, message: '商机不存在' });
  if (['赢单', '输单'].includes(o.stage)) return res.status(400).json({ code: 400, message: '商机已结束，不能继续推进' });
  const next = OPP_STAGES[OPP_STAGES.indexOf(o.stage) + 1];
  if (!next || !OPP_STAGES.includes(o.stage)) return res.status(400).json({ code: 400, message: '商机阶段无效，请先编辑阶段' });
  await q(`update crm_opportunity set stage = $1::varchar, win_rate = $2, closed_at = case when $1::varchar in ('赢单','输单') then now() else closed_at end where id = $3`,
    [next, STAGE_RATE[next], id]);
  res.json({ code: 0, data: { nextStage: next, winRate: STAGE_RATE[next] }, message: `已推进到「${next}」，赢单率 ${STAGE_RATE[next]}%` });
});

// ---------------------------------------------------------------- 客户 360
router.get('/customer/:id/360', async (req, res) => {
  const id = Number(req.params.id);
  const customer = await one('select t.*, u.real_name as owner_name from crm_customer t left join sys_user u on u.id = t.owner_id where t.id = $1', [id]);
  if (!customer) return res.status(404).json({ code: 404, message: '客户不存在' });
  const contacts = await many('select * from crm_contact where customer_id = $1 order by is_primary desc, id', [id]);
  const relatedRows = async (kind, sort) => {
    const params = [id];
    const scope = scopeSql(ENT[kind], req.user, params);
    return many(`select t.* from ${ENT[kind].table} t where t.customer_id=$1 ${scope} order by ${sort} limit 20`, params);
  };
  const visibleContracts = await relatedRows('contract', 't.sign_date desc');
  const visibleOrders = await relatedRows('order', 't.order_date desc');
  const visibleOpportunities = await relatedRows('opportunity', 't.id desc');
  const visibleLeads = await relatedRows('lead', 't.id desc');
  const followParams = [id];
  const follows = await many(`select t.*, u.real_name as owner_name from crm_follow_up t left join sys_user u on u.id=t.owner_id where t.biz_type='customer' and t.biz_id=$1 ${scopeSql(ENT.followUp, req.user, followParams)} order by t.created_at desc limit 50`, followParams);
  const contractParams = [id];
  const orderParams = [id];
  const sum = await one(`select coalesce(sum(t.amount),0) as contract_amount, count(*)::int as contract_cnt from crm_contract t where t.customer_id = $1 ${scopeSql(ENT.contract, req.user, contractParams)}`, contractParams);
  const orderSum = await one(`select coalesce(sum(t.amount),0) as order_amount, count(*)::int as order_cnt from crm_order t where t.customer_id = $1 ${scopeSql(ENT.order, req.user, orderParams)}`, orderParams);
  res.json({
    code: 0, data: {
      customer, contacts, contracts: visibleContracts, orders: visibleOrders, opportunities: visibleOpportunities, leads: visibleLeads, follows,
      summary: {
        contractAmount: num(sum.contract_amount), contractCnt: num(sum.contract_cnt),
        orderAmount: num(orderSum.order_amount), orderCnt: num(orderSum.order_cnt)
      }
    }
  });
});

// 列表页统计条
router.get('/:entity/summary/stats', async (req, res) => {
  const ent = ENT[req.params.entity];
  if (!ent) return res.status(404).json({ code: 404, message: '未知实体' });
  const params = [];
  const scope = listScope(ent, req.user, params);
  const spec = {
    customer: `select count(*)::int as total, sum(case when status='active' then 1 else 0 end)::int as active, sum(case when level='A' then 1 else 0 end)::int as top, coalesce(sum(credit_limit),0) as amount`,
    lead: `select count(*)::int as total, sum(case when in_pool then 1 else 0 end)::int as in_pool, sum(case when stage='converted' then 1 else 0 end)::int as converted, coalesce(sum(est_amount),0) as amount`,
    contract: `select count(*)::int as total, sum(case when status='effective' then 1 else 0 end)::int as active, coalesce(sum(amount),0) as amount, coalesce(sum(amount-cost),0) as profit`,
    order: `select count(*)::int as total, sum(case when status='pending' then 1 else 0 end)::int as pending, coalesce(sum(amount),0) as amount, coalesce(sum(quantity),0) as quantity`,
    opportunity: `select count(*)::int as total, sum(case when stage='赢单' then 1 else 0 end)::int as won, coalesce(sum(est_amount),0) as amount, coalesce(avg(win_rate),0) as win_rate`
  }[req.params.entity];
  if (!spec) return res.json({ code: 0, data: {} });
  const row = await one(spec + ` from ${ent.table} t where 1=1 ${scope}`, params);
  res.json({ code: 0, data: row });
});

module.exports = { router, ENT };
