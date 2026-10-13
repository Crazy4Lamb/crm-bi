const { getDb, q } = require('./index');
const RE = require('../services/reportEngine');
const MET = require('../services/metricEngine');
(async () => {
  await getDb();
  const m = (await q("select * from bi_metric where code = 'm_lead_convert_rate_day'")).rows[0];
  const ctx = await RE.loadReport(m.report_id);
  const built = RE.buildQuery(ctx, { dimsOverride: [m.date_field_key], dateRange: { from: '2026-10-12', to: '2026-10-12' }, withTotal: false }, null);
  console.log('SQL:\n' + built.sql);
  const r = await q(built.sql, built.params);
  console.log('raw:', JSON.stringify(r.rows));
  console.log('normalized:', JSON.stringify(RE.normalizeRows(r.rows, built.columns)));
  const series = await MET.computeMetricSeries(m, '2026-10-12', '2026-10-12', null);
  console.log('series:', JSON.stringify(series));
  const at = await MET.computeMetricAt(m, '2026-10-12', null);
  console.log('at:', at.value, '\n', at.sql);
  await getDb().then((d) => d.close());
})();
