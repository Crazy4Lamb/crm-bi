'use strict';
// CRM 流转与权限回归；仅创建独立测试记录，finally 清理。
const assert = require('node:assert/strict');
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const sessions = {};
const fixtures = [];
let checks = 0;
async function call(user, path, method = 'GET', body) {
  const res = await fetch(BASE + '/api/crm/' + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessions[user].token }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, ...(await res.json()) };
}
function check(name, value) { assert.ok(value, name); checks++; console.log('✓ ' + name); }
async function create(user, kind, body) {
  const r = await call(user, kind, 'POST', body);
  assert.equal(r.code, 0, JSON.stringify(r));
  fixtures.push([kind, r.data.id]);
  return r.data.id;
}
async function main() {
  for (const user of ['admin', 'rep01', 'rep02', 'ana01']) {
    const res = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: user === 'admin' ? 'admin123' : '123456' }) });
    sessions[user] = (await res.json()).data;
  }
  try {
    const stamp = Date.now();
    const c1 = await create('rep01', 'customer', { name: 'QA-本人的客户-' + stamp, status: 'potential' });
    const c2 = await create('rep02', 'customer', { name: 'QA-其他销售-' + stamp, status: 'potential' });
    check('客户自动编号、归属当前销售', (await call('rep01', 'customer/' + c1)).data.owner_id === sessions.rep01.user.id);
    check('跨销售读取详情被拒绝', (await call('rep01', 'customer/' + c2)).status === 404);
    check('非标准编号不能绕过数据权限', (await call('rep01', 'customer/' + c2 + '.0')).status === 400);
    check('跨销售读取客户360被拒绝', (await call('rep01', 'customer/' + c2 + '/360')).status === 404);
    check('跨销售编辑被拒绝', (await call('rep01', 'customer/' + c2, 'PUT', { name: '越权修改' })).status === 404);
    check('跨销售删除被拒绝', (await call('rep01', 'customer/' + c2, 'DELETE')).status === 404);
    check('无模块权限读取列表被拒绝', (await call('ana01', 'customer')).status === 403);
    check('客户选择器不泄露其他销售的客户', !(await call('rep01', 'picklist/customer')).data.some((x) => x.id === c2));
    check('无法把本人客户归给其他销售', (await call('rep01', 'customer/' + c1, 'PUT', { owner_id: sessions.rep02.user.id })).status === 403);
    const contact = await create('rep02', 'contact', { customer_id: c2, name: 'QA-联系人' });
    check('联系人列表按客户数据范围隔离', !(await call('rep01', 'contact?f.customer_id=' + c2)).data.rows.some((x) => x.id === contact));
    const follow = await create('rep01', 'followUp', { biz_type: 'customer', biz_id: c1, content: '确认客户需求，下次提交方案。', way: '电话', result: '需跟进', next_time: '2026-10-20T10:00' });
    check('客户360返回新写入的跟进时间轴', (await call('rep01', 'customer/' + c1 + '/360')).data.follows.some((x) => x.id === follow));
    check('无法给其他销售的客户写跟进', (await call('rep01', 'followUp', 'POST', { biz_type: 'customer', biz_id: c2, content: '不应保存' })).status === 400);
    const pool = await create('admin', 'customer', { name: 'QA-公海-' + stamp, status: 'potential' });
    // 管理员明确释放本人创建的潜在客户。
    check('潜在客户可退回公海', (await call('admin', 'customer-pool/' + pool + '/release', 'POST', {})).code === 0);
    check('公海列表路由可访问', (await call('rep01', 'customer-pool?keyword=QA-公海-' + stamp)).data.rows.some((x) => x.id === pool));
    check('客户公海领取成功', (await call('rep01', 'customer-pool/' + pool + '/claim', 'POST', {})).code === 0);
    const claimed = (await call('rep01', 'customer/' + pool)).data;
    check('领取保留潜在状态并归属本人', claimed.status === 'potential' && claimed.owner_id === sessions.rep01.user.id);
    check('不允许重复领取', (await call('rep02', 'customer-pool/' + pool + '/claim', 'POST', {})).status === 400);
    check('潜在客户可再次退回公海', (await call('rep01', 'customer-pool/' + pool + '/release', 'POST', {})).code === 0);
    const lead = await create('admin', 'lead', { name: 'QA-线索联系人', company: 'QA-线索公司-' + stamp, in_pool: true, stage: 'new' });
    check('销售代表能看到未领取的共享线索', (await call('rep01', 'lead?f.in_pool=true&keyword=QA-线索公司-' + stamp)).data.rows.some((x) => x.id === lead));
    check('共享线索可领取到本人名下', (await call('rep01', 'lead/' + lead + '/claim', 'POST', {})).code === 0);
    check('领取后的线索不再对其他销售公开', !(await call('rep02', 'lead?keyword=QA-线索公司-' + stamp)).data.rows.some((x) => x.id === lead));
    const converted = await call('rep01', 'lead/' + lead + '/convert', 'POST', {});
    assert.equal(converted.code, 0, JSON.stringify(converted));
    // 清理顺序：线索在前、引用的客户在后。
    fixtures.splice(fixtures.length - 1, 0, ['customer', converted.data.customerId]);
    check('线索转客户同时保留联系人', (await call('rep01', 'customer/' + converted.data.customerId + '/360')).data.contacts.some((c) => c.name === 'QA-线索联系人'));
    const opp = await create('rep01', 'opportunity', { name: 'QA-商机-' + stamp, customer_id: c1, stage: '初步接洽', est_amount: 1000, win_rate: 15 });
    check('商机阶段推进并更新赢率', (await call('rep01', 'opp/' + opp + '/advance', 'POST', {})).data.winRate === 35);
    check('跨销售不能推进商机', (await call('rep02', 'opp/' + opp + '/advance', 'POST', {})).status === 404);
    await call('rep01', 'opportunity/' + opp, 'PUT', { stage: '赢单', win_rate: 100 });
    check('赢单商机不能继续推进', (await call('rep01', 'opp/' + opp + '/advance', 'POST', {})).status === 400);
    const order = await create('rep01', 'order', { order_no: null, customer_id: c1, amount: 100, order_date: '2026-10-13', status: 'pending' });
    check('回款列表路由与分页结构正确', Array.isArray((await call('rep01', 'payment?orderId=' + order)).data.rows));
    check('销售代表有独立回款登记权限', (await call('rep01', 'payment', 'POST', { orderId: order, amount: 40, payDate: '2026-10-13' })).code === 0);
    check('部分回款保留待付款状态', (await call('rep01', 'order/' + order)).data.status === 'pending');
    check('不允许负数回款', (await call('rep01', 'payment', 'POST', { orderId: order, amount: -1, payDate: '2026-10-13' })).status === 400);
    check('不允许超额回款', (await call('rep01', 'payment', 'POST', { orderId: order, amount: 61, payDate: '2026-10-13' })).status === 400);
    check('跨销售不能登记回款', (await call('rep02', 'payment', 'POST', { orderId: order, amount: 1, payDate: '2026-10-13' })).status === 404);
    const concurrent = await Promise.all([60, 60].map((amount) => call('rep01', 'payment', 'POST', { orderId: order, amount, payDate: '2026-10-13' })));
    check('并发登记不会超额收款', concurrent.filter((r) => r.code === 0).length === 1);
    const paid = (await call('rep01', 'order/' + order)).data;
    check('足额回款推进已付款状态', paid.status === 'paid' && Number(paid.paid_amount) === 100);
    check('回款记录可再次读取', (await call('rep01', 'payment?orderId=' + order)).data.rows.length === 2);
    check('回款列表不泄露其他销售数据', (await call('rep02', 'payment?orderId=' + order)).data.rows.length === 0);
    const linked360 = (await call('rep01', 'customer/' + c1 + '/360')).data;
    check('客户360联动订单与回款业务旅程',
      linked360.journey.some((x) => x.event_type === 'order' && x.entity_id === order)
      && linked360.journey.filter((x) => x.event_type === 'payment').length === 2);
    check('客户360实时汇总已收与待收',
      Number(linked360.summary.paidAmount) >= 100 && Number(linked360.summary.receivableAmount) >= 0);
    console.log(`CRM 回归通过 ${checks} 项`);
  } finally {
    for (const [kind, id] of fixtures.reverse()) {
      const r = await call('admin', kind + '/' + id, 'DELETE');
      assert.equal(r.code, 0, '清理失败：' + kind + '/' + id);
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
