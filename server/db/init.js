'use strict';
/**
 * 一键初始化：建表 → 元数据（角色/权限/数据集/报表/图表/指标/任务）→ 业务演示数据 → 回算 T+1 指标
 * 用法：node server/db/init.js  （等价于 npm run initdb）
 */
const { migrate } = require('./migrate');
const { getDb, q, one } = require('./index');
const metaSeed = require('./seed-meta');
const crmSeed = require('./seed-crm');
const RE = require('../services/reportEngine');
const MET = require('../services/metricEngine');

const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS || 120);

async function main() {
  const t0 = Date.now();
  await migrate();
  const db = await getDb();
  console.log('='.repeat(72));
  console.log('CRM+BI 初始化  数据库：' + db.label);
  console.log('='.repeat(72));

  const existing = await one('select (select count(*) from sys_user)+(select count(*) from sys_role)+(select count(*) from crm_customer)+(select count(*) from crm_contract) as n');
  if (Number(existing.n)>0) {
    console.log('Existing data preserved. Migrations applied; demo seeding skipped.');
    if(db.mode==='pg') await q('select crm_analyze_business()');
    await db.close(); return;
  }
  console.log('[1/4] Versioned schema migrations applied.');
  await db.transaction(async () => {

  // 2. 元数据
  const t2 = Date.now();
  const meta = await metaSeed.run();
  console.log(`[2/4] 元数据已写入（${Date.now() - t2}ms）：` +
    `角色 ${meta.roles} / 用户 ${meta.users} / 菜单 ${meta.menus} / 授权 ${meta.acl} 条 / ` +
    `数据集 ${meta.datasets}(${meta.dataset_fields} 字段) / 报表 ${meta.reports} / 卡片+图表 ${meta.widgets} / 指标 ${meta.metrics} / 驾驶舱 ${meta.dashboards} / 任务 ${meta.tasks}`);

  // 3. 业务数据
  const t3 = Date.now();
  const counts = await crmSeed.run();
  console.log(`[3/4] 业务数据已生成（${Date.now() - t3}ms）：` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));

  // 4. T+1 指标回算
  const t4 = Date.now();
  const metrics = (await q("select * from bi_metric where status = '1' order by id")).rows;
  const dates = [];
  for (let i = BACKFILL_DAYS; i >= 1; i--) dates.push(RE.fmtDate(RE.addDays(RE.today(), -i)));
  let total = 0;
  const detail = [];
  for (const m of metrics) {
    const r = await MET.persistMetric(m, dates, {});
    total += r.rows;
    const last = r.detail[r.detail.length - 1];
    detail.push(`${m.name}=${last ? last.value : '-'}`);
  }
  console.log(`[4/4] T+1 指标已回算（${Date.now() - t4}ms）：${metrics.length} 个指标 × ${dates.length} 天，共 ${total} 条`);
  console.log('      最新数据日 ' + dates[dates.length - 1] + ' 的值：' + detail.join(' | '));
  if (db.mode === 'pg') {
    await q('select crm_sync_code_sequences()');
    await q('select bi_refresh_sales()');
    await q('select crm_analyze_business()');
  }
  });

  const user = await one("select count(*)::int as c from sys_user");
  console.log('-'.repeat(72));
  console.log(`完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s。用户数 ${user.c}`);
  console.log('演示账号：admin/admin123（系统管理员）、gm01/123456（总经理）、dir01/123456（销售总监）、rep01/123456（销售代表）、ana01/123456（数据分析师）、svc01/123456（客服专员）');
  console.log('启动服务：npm start   访问 http://127.0.0.1:' + require('../config').port + '/');
  console.log('='.repeat(72));
  // 确保文件系统完成落盘后退出。
  await db.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('[init] 初始化失败：', e);
  process.exit(1);
});
