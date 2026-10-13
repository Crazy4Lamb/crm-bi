'use strict';
const { getDb, one, many, num } = require('../db');
const RE = require('./reportEngine');
async function insights() {
  const db = await getDb();
  if (db.mode !== 'pg') return { enabled: false };
  const to = RE.fmtDate(RE.today());
  const from = RE.fmtDate(RE.addDays(RE.today(), -29));
  const [receivables, opportunities, followups, trend, snapshot] = await Promise.all([
    one("select coalesce(sum(unpaid_amount),0) as amount,count(*) filter(where unpaid_amount>0)::int as orders from crm_order_balance where status<>'refund'"),
    one("select count(*) filter(where expect_date<current_date)::int as overdue,coalesce(sum(est_amount*win_rate/100.0),0) as forecast from crm_opportunity where stage not in ('赢单','输单')"),
    one("select count(*) filter(where next_time<=now())::int as due from crm_follow_up where next_time is not null"),
    many('select * from bi_sales_trend($1::date,$2::date)', [from, to]),
    one('select refreshed_at,source_version,refreshed_version,source_version>refreshed_version as stale from bi_refresh_state where id=1')
  ]);
  return { enabled: true, from, to, receivables: { amount: num(receivables.amount), orders: receivables.orders }, opportunities: { overdue: opportunities.overdue, forecast: num(opportunities.forecast) }, followups: { due: followups.due }, snapshot, trend: trend.map((r) => ({ date: r.stat_date, amount: num(r.sales_amount), contracts: num(r.contract_count), profit: num(r.profit), runningAmount: num(r.running_amount), previousAmount: r.previous_amount == null ? null : num(r.previous_amount) })) };
}
async function diagnostics() {
  const db = await getDb();
  if (db.mode !== 'pg') return { enabled: false, mode: db.mode };
  const [database, indexes, policies, snapshot, audit, migrations, tables, plan] = await Promise.all([
    one('select version() as version,current_database() as name,current_user as user,pg_database_size(current_database()) as bytes,(select rolsuper from pg_roles where rolname=current_user) as superuser,(select rolbypassrls from pg_roles where rolname=current_user) as bypass_rls'),
    many("select indexname,tablename,indexdef from pg_indexes where schemaname='public' order by tablename,indexname"),
    many("select tablename,policyname,cmd from pg_policies where schemaname='public' order by tablename,policyname"),
    one('select *,source_version>refreshed_version as stale from bi_refresh_state where id=1'),
    one('select count(*)::int as records,max(occurred_at) as latest from crm_audit'),
    many('select version,applied_at from app_migration order by version').catch(() => []),
    many("select relname,n_live_tup,seq_scan,idx_scan from pg_stat_user_tables where schemaname='public' and relname like 'crm_%' order by relname"),
    many("explain (analyze,buffers,format json) select id from crm_customer where (coalesce(name,'')||' '||coalesce(cust_no,'')||' '||coalesce(phone,'')||' '||coalesce(industry,'')||' '||coalesce(region,'')) ilike '%科技%' order by created_at desc limit 20")
  ]);
  return { enabled: true, database, pool: db.poolStats(), indexes, policies, snapshot, audit, migrations, tables, searchPlan: plan[0]['QUERY PLAN'][0] };
}
async function refresh() {
  if ((await getDb()).mode !== 'pg') return false;
  return (await one('select bi_refresh_sales() as refreshed')).refreshed;
}
module.exports = { insights, diagnostics, refresh };
