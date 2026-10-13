'use strict';
const assert = require('node:assert/strict');
const cfg = require('../server/config');
const { Pool } = require('pg');
const db = require('../server/db');
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const sessions={}; const fixtures=[]; let checks=0;
function check(name, ok) { assert.ok(ok,name); checks++; console.log('✓ '+name); }
async function api(user,path,method='GET',body) {
  const res=await fetch(BASE+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+sessions[user].token},body:body?JSON.stringify(body):undefined});
  return {status:res.status,...await res.json()};
}
async function create(user,kind,body) {
  const r=await api(user,'/api/crm/'+kind,'POST',body); assert.equal(r.code,0,JSON.stringify(r)); fixtures.push([kind,r.data.id]); return r.data.id;
}
async function main() {
  assert.equal(cfg.dbMode,'pg','PostgreSQL tests require DB_MODE=pg');
  const raw=new Pool({...cfg.pg,max:3});
  const client=await raw.connect();
  try {
    for(const user of ['admin','rep01','rep02']) {
      const r=await fetch(BASE+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:user,password:user==='admin'?'admin123':'123456'})});
      const result=await r.json(); assert.equal(result.code,0); sessions[user]=result.data;
    }
    const health=await(await fetch(BASE+'/api/health')).json();
    check('HTTP 服务确实使用真实 PostgreSQL',health.data.mode==='pg');
    const identity=(await client.query('select version(),current_user,(select rolsuper or rolbypassrls from pg_roles where rolname=current_user) as privileged')).rows[0];
    check('连接 PostgreSQL 18 普通运行账号',identity.version.startsWith('PostgreSQL 18.')&&!identity.privileged&&identity.current_user==='crm_app');
    check('未设置业务上下文时私人订单默认不可见',Number((await client.query('select count(*) from crm_order')).rows[0].count)===0);
    const policies=(await client.query("select count(*) from pg_policies where schemaname='public'")).rows[0];
    check('数据库已启用行级安全策略',Number(policies.count)>=15);
    await client.query('begin');
    await client.query("select set_config('crm.user_id',$1,true),set_config('crm.data_scope','self',true),set_config('crm.dept',$2,true),set_config('crm.role','sales_rep',true)",[String(sessions.rep01.user.id),sessions.rep01.user.dept]);
    const orders=(await client.query('select distinct owner_id from crm_order')).rows;
    check('没有 API 过滤的直接 SQL 也只返回本人订单',orders.length===1&&orders[0].owner_id===sessions.rep01.user.id);
    await client.query('commit');
    check('事务提交后数据范围设置没有泄露到复用连接',Number((await client.query('select count(*) from crm_order')).rows[0].count)===0);
    const stamp=Date.now();
    const manyCreated=await Promise.all(Array.from({length:12},(_,i)=>api('rep01','/api/crm/customer','POST',{name:`PG-QA-${stamp}-${i}`,status:'potential'})));
    for(const result of manyCreated) {assert.equal(result.code,0,JSON.stringify(result));fixtures.push(['customer',result.data.id]);}
    const details=await Promise.all(manyCreated.map(r=>api('rep01','/api/crm/customer/'+r.data.id)));
    check('并发新增由数据库序列生成唯一编号',new Set(details.map(r=>r.data.cust_no)).size===12);
    const searches=await create('rep01','customer',{name:'PG-QA-MixedCase-'+stamp,status:'potential'});
    const found=await api('rep01','/api/crm/customer?keyword='+encodeURIComponent('mixedcase-'+stamp));
    check('GIN 对应的 ILIKE 搜索支持不区分大小写',found.data.rows.some(r=>r.id===searches));
    const lead=await create('rep01','lead',{name:'PG-QA-联系人',company:'PG-QA-转化-'+stamp,stage:'following',in_pool:false});
    const conversions=await Promise.all([0,1].map(()=>api('rep01','/api/crm/lead/'+lead+'/convert','POST',{})));
    const success=conversions.filter(r=>r.code===0);
    check('并发线索转化只生成一个客户',success.length===1&&conversions.some(r=>r.status===400));
    fixtures.splice(fixtures.length-1,0,['customer',success[0].data.customerId]);
    const converted=await api('rep01','/api/crm/customer/'+success[0].data.customerId+'/360');
    check('数据库函数原子写入客户、联系人与线索关联',converted.data.contacts.length===1&&(await api('rep01','/api/crm/lead/'+lead)).data.customer_id===success[0].data.customerId);
    await assert.rejects((await db.getDb()).transaction(async()=>{await db.q("insert into crm_customer(name,status,owner_id,owner_dept) values($1,'potential',$2,$3)",['PG-QA-ROLLBACK-'+stamp,sessions.rep01.user.id,sessions.rep01.user.dept]);throw new Error('rollback probe');}),/rollback probe/);
    check('失败事务不会残留业务或审计写入',Number((await db.one('select count(*) from crm_customer where name=$1',['PG-QA-ROLLBACK-'+stamp])).count)===0&&Number((await db.one("select count(*) from crm_audit where after_data @> $1::jsonb",[JSON.stringify({name:'PG-QA-ROLLBACK-'+stamp})])).count)===0);
    const order=await create('rep01','order',{customer_id:searches,amount:100,order_date:'2026-10-13',status:'pending'});
    await assert.rejects(db.q('insert into crm_payment(order_id,amount,pay_date) values($1,101,current_date)',[order]),e=>e.code==='23514');
    check('绕过 API 的超额回款仍被数据库触发器拒绝',Number((await db.one('select count(*) from crm_payment where order_id=$1',[order])).count)===0);
    const concurrent=await Promise.allSettled([60,60].map(amount=>db.q('insert into crm_payment(order_id,amount,pay_date) values($1,$2,current_date) returning id',[order,amount])));
    check('数据库行锁阻止直接 SQL 并发超额回款',concurrent.filter(r=>r.status==='fulfilled').length===1&&concurrent.filter(r=>r.status==='rejected'&&r.reason.code==='23514').length===1);
    const partial=(await db.one('select * from crm_order where id=$1',[order]));
    check('数据库部分回款保留待付款状态',partial.status==='pending');
    await assert.rejects(db.q('update crm_order set amount=50 where id=$1',[order]),e=>e.code==='23514');
    check('数据库拒绝把订单金额降低至已收款之下',true);
    await db.q('insert into crm_payment(order_id,amount,pay_date) values($1,40,current_date)',[order]);
    check('直接 SQL 足额回款也会推进付款状态',(await db.one('select status from crm_order where id=$1',[order])).status==='paid');
    await db.q('delete from crm_payment where order_id=$1 and amount=40',[order]);
    check('撤销回款后数据库同步付款状态',(await db.one('select status from crm_order where id=$1',[order])).status==='pending');
    const contract=await create('rep01','contract',{customer_id:searches,name:'PG-QA-快照-'+stamp,amount:1000,cost:200,sign_date:'2026-10-13',status:'effective'});
    const stale=await api('admin','/api/sys/postgres');
    check('合同写入自动标记经营快照待刷新',stale.data.snapshot.stale===true);
    check('非管理员不能刷新经营快照',(await api('rep01','/api/sys/postgres/refresh','POST',{})).status===403);
    await api('admin','/api/sys/postgres/refresh','POST',{});
    const latest=await api('admin','/api/sys/postgres');
    check('并发刷新物化视图后版本一致',latest.data.snapshot.stale===false);
    check('真实诊断包含 GIN 索引、连接池和已应用迁移',latest.data.indexes.some(i=>i.indexdef.includes('gin'))&&latest.data.pool.max>0&&latest.data.migrations.length>=3);
    const pulse=await api('rep01','/api/dashboard/insights');
    check('经营脉搏返回 30 天窗口函数结果',pulse.data.trend.length===30);
    let sum=0; check('SQL 窗口累计金额与明细一致',pulse.data.trend.every(r=>{sum+=r.amount;return Math.abs(sum-r.runningAmount)<0.01;}));
    const date=pulse.data.trend.at(-1).date;
    const ownerSum=await db.one("select coalesce(sum(amount),0) as total from crm_contract where sign_date=$1 and owner_id=$2 and status in ('effective','closed')",[date,sessions.rep01.user.id]);
    check('物化视图访问函数按销售范围返回数据',Math.abs(Number(ownerSum.total)-pulse.data.trend.at(-1).amount)<0.01);
    await assert.rejects(client.query('select * from bi_sales_daily limit 1'),e=>e.code==='42501');
    check('普通账号无法直接读取全局物化视图',true);
    const audit=await db.one("select count(*) as n from crm_audit where table_name='crm_contract' and record_id=$1 and after_data @> $2::jsonb",[contract,JSON.stringify({name:'PG-QA-快照-'+stamp})]);
    check('JSONB 审计记录包含真实变更内容',Number(audit.n)>0);
    const race=await Promise.all(Array.from({length:24},(_,i)=>{const user=i%2?'rep01':'rep02';return api(user,'/api/crm/order?size=5').then(r=>({user,rows:r.data.rows}));}));
    check('并发请求和连接复用不混淆用户的数据范围',race.every(r=>r.rows.every(x=>x.owner_id===sessions[r.user].user.id)));
    const board=await api('rep01','/api/crm/opportunity-board');
    const oppCount=await api('rep01','/api/crm/opportunity?size=1');
    check('阶段看板统计全部商机，独立于列表分页',board.data.total===oppCount.data.total&&board.data.total>20);
    check('数据库按阶段限制明细条数',board.data.lanes.every(l=>l.rows.length<=10));
    check('阶段看板不泄露其他销售数据',board.data.lanes.every(l=>l.rows.every(r=>r.owner_id===sessions.rep01.user.id)));
    check('阶段看板总数等于各阶段计数之和',board.data.total===board.data.lanes.reduce((n,l)=>n+l.count,0));
    console.log(`PostgreSQL 回归通过 ${checks} 项`);
  } finally {
    for(const [kind,id] of fixtures.reverse()) {
      const r=await api('admin','/api/crm/'+kind+'/'+id,'DELETE'); assert.equal(r.code,0,'清理失败 '+kind+'/'+id);
    }
    if(sessions.admin) await api('admin','/api/sys/postgres/refresh','POST',{});
    client.release();await raw.end();await(await db.getDb()).close();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
