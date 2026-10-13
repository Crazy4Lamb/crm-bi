/* 驾驶舱：按角色装配 KPI 卡片与统计图 */
(function () {
  const instances = [];
  let generation = 0;
  const CHART_LABELS = { bar: '柱形图', bar_h: '条形图', line: '折线图', area: '趋势面积图', pie: '饼图', doughnut: '环形图', scatter: '散点图', heatmap: '热度图', funnel: '销售漏斗', radar: '雷达图', gauge: '仪表盘' };
  const PERIOD_LABELS = { latest: '最新值', day: '当日', mtd: '本月累计', month: '整月', last7: '近 7 天', last30: '近 30 天', all: '累计', yesterday: '昨日', ytd: '本年累计' };

  function disposeAll() {
    instances.forEach((i) => { try { i.dispose(); } catch (e) { /* noop */ } });
    instances.length = 0;
  }

  function kpiCard(c) {
    return `<div class="kpi" data-code="${c.code}">
      <span class="kdot"></span>
      <div class="l"><span>${UI.esc(c.name)}</span><span class="badge gray">${UI.esc(PERIOD_LABELS[c.sumMode] || c.sumMode)}</span></div>
      <div class="v" data-v>--<span class="unit">${UI.esc(c.unit || '')}</span></div>
      <div class="f"><span data-g>—</span><span data-s></span></div>
      <div data-progress></div>
      <div class="spark" data-spark></div>
    </div>`;
  }

  function chartCard(c) {
    const scopeText = c.scope === 'self' ? '仅本人数据' : c.scope === 'dept' ? '本部门数据' : '全局数据';
    return `<div class="card" data-chart="${c.code}">
      <div class="card-hd">
        <div><div class="t">${UI.esc(c.name)}</div><div class="d">${UI.esc(CHART_LABELS[c.chartType] || c.chartType)} · ${UI.esc(scopeText)}</div></div>
        <div class="flex gap8"><button class="btn sm" data-act="data">数据明细</button></div>
      </div>
      <div class="card-bd"><div class="chart-box" data-box><div class="empty">加载中…</div></div></div>
    </div>`;
  }

  function fillCard(el, d) {
    if (!d.ok) {
      el.querySelector('[data-v]').innerHTML = '<span class="err" style="font-size:12px">' + UI.esc(d.error) + '</span>';
      return;
    }
    const c = d.data;
    el.querySelector('[data-v]').innerHTML = UI.esc(c.display) + `<span class="unit">${UI.esc(c.unit || '')}</span>`;
    const g = el.querySelector('[data-g]');
    const cmpText = { day: '较前一日', month: '较上期' }[c.compare] || '';
    if (c.growthText) {
      const up = c.growth >= 0;
      g.className = up ? 'up' : 'down';
      g.textContent = (up ? '▲ ' : '▼ ') + c.growthText + ' ' + cmpText;
    } else { g.textContent = '—'; }
    el.querySelector('[data-s]').textContent = '数据日 ' + (c.statDate || '');
    if (c.progress != null) {
      el.querySelector('[data-progress]').innerHTML = `
        <div class="mt8"><div style="height:6px;background:#eef2f8;border-radius:99px;overflow:hidden">
        <div style="height:100%;width:${Math.min(100, c.progress)}%;background:${UI.esc(c.color || '#2f6bff')}"></div></div>
        <div class="sm muted mt8">目标完成 ${c.progress}%（目标 ${UI.money(c.target)}）</div></div>`;
    }
    const sparkBox = el.querySelector('[data-spark]');
    if (c.spark && c.spark.length > 1) {
      const color = c.color || '#2f6bff';
      const inst = echarts.init(sparkBox);
      inst.setOption({
        grid: { left: 2, right: 2, top: 4, bottom: 2 },
        xAxis: { type: 'category', show: false, data: c.spark.map((s) => s.date), boundaryGap: false },
        yAxis: { type: 'value', show: false, scale: true },
        tooltip: { trigger: 'axis', confine: true, formatter: (p) => p[0].axisValue + '<br/>' + UI.esc(c.name) + '：' + UI.num(p[0].value, 2) },
        series: [{ type: 'line', data: c.spark.map((s) => s.value), smooth: true, showSymbol: false, lineStyle: { width: 1.6, color }, areaStyle: { color: color + '22' } }]
      });
      instances.push(inst);
    } else { sparkBox.innerHTML = ''; }
  }

  async function loadCards(container, codes, run) {
    if (!codes.length) return;
    const res = await API.get('/api/dashboard/widgets', { codes: codes.join(',') });
    if (generation !== run || !container.querySelector('.kpi')) return;
    (res.data || []).forEach((d) => {
      const el = container.querySelector(`.kpi[data-code="${d.code}"]`);
      if (el) fillCard(el, d);
    });
  }

  async function loadCharts(container, codes, run) {
    for (const code of codes) {
      if (run !== generation || !container.querySelector('[data-chart]')) return;
      const card = container.querySelector(`[data-chart="${code}"]`);
      if (!card) continue;
      const box = card.querySelector('[data-box]');
      try {
        const r = await API.get('/api/dashboard/widget/' + code);
        if (run !== generation || !card.isConnected) return;
        const d = r.data;
        if (!d.ok) { box.innerHTML = '<div class="err">' + UI.esc(d.error) + '</div>'; continue; }
        box.innerHTML = '';
        const inst = echarts.init(box);
        inst.setOption(d.data.option);
        instances.push(inst);
        const rows = d.data.rows || [];
        const cols = d.data.columns || [];
        card.querySelector('[data-act="data"]').onclick = () => {
          UI.modal({
            title: d.name + ' · 数据明细（' + rows.length + ' 行）',
            size: 'wide',
            body: `<div style="max-height:60vh;overflow:auto">${UI.table(
              cols.map((c) => ({
                key: c.key, name: c.name, align: c.type === 'number' ? 'right' : 'left',
                render: (row) => {
                  const v = row[c.key];
                  if (c.enum) { const m = UI.enumMap(c.enum); return UI.esc(m[v] || v || '-'); }
                  return UI.esc(UI.fmtByType(v, c.type, c.fmt));
                }
              })), rows)}</div>`
          });
        };
      } catch (e) {
        box.innerHTML = '<div class="err">' + UI.esc(e.message) + '</div>';
      }
    }
  }

  window.VIEWS = window.VIEWS || {};
  async function businessPulse(container, run) {
    const box = container.querySelector('#businessPulse');
    if (!box) return;
    const d = (await API.get('/api/dashboard/insights')).data;
    if (generation !== run || !box.isConnected || !d.enabled) return;
    box.innerHTML = `<div class="section-title"><div><h2>经营脉搏</h2><span>应收与待办实时统计 · 签约趋势来自分析快照</span></div><span class="badge purple">PostgreSQL 驱动</span></div>
      <div class="stat-strip mb16"><a class="stat-chip" href="#/order"><div class="l">待收款金额</div><div class="v">¥${UI.money(d.receivables.amount)}</div><div class="sm muted">${d.receivables.orders} 笔订单仍有余额 ↗</div></a><a class="stat-chip" href="#/opportunity"><div class="l">预计成交收入</div><div class="v">¥${UI.money(d.opportunities.forecast)}</div><div class="sm muted">进行中商机按赢率加权 ↗</div></a><a class="stat-chip" href="#/opportunity"><div class="l">超过预计成交日期</div><div class="v">${d.opportunities.overdue}<span class="sm"> 个商机</span></div><div class="sm muted">关注逾期机会，及时推进 ↗</div></a><div class="stat-chip"><div class="l">已到下次跟进时间</div><div class="v">${d.followups.due}<span class="sm"> 条记录</span></div><div class="sm muted">按已记录的下次跟进时间统计</div></div></div>
      <div class="card"><div class="card-hd"><div><div class="t">近 30 天有效签约与累计收入</div><div class="d">生效或已完结合同 · ${UI.esc(d.from)} 至 ${UI.esc(d.to)}</div></div><span class="badge ${d.snapshot.stale ? 'orange' : 'green'}">${d.snapshot.stale ? '快照待刷新' : '快照已同步'} · ${UI.dt(d.snapshot.refreshed_at)}</span></div><div class="card-bd"><div class="chart-box" data-pulse-chart></div></div></div>`;
    const inst = echarts.init(box.querySelector('[data-pulse-chart]'));
    inst.setOption({ color: ['#ff6a1a','#9c72e9'], tooltip: { trigger:'axis', confine:true }, legend:{ data:['日签约金额','区间累计金额'] }, grid:{left:65,right:80,top:45,bottom:35,containLabel:true}, xAxis:{type:'category',data:d.trend.map(x=>x.date.slice(5))},yAxis:[{type:'value',name:'日金额',axisLabel:{formatter:v=>UI.money(v)}},{type:'value',name:'累计金额',axisLabel:{formatter:v=>UI.money(v)}}],series:[{name:'日签约金额',type:'bar',barMaxWidth:18,itemStyle:{borderRadius:[4,4,0,0]},data:d.trend.map(x=>x.amount)},{name:'区间累计金额',type:'line',smooth:true,showSymbol:false,yAxisIndex:1,data:d.trend.map(x=>x.runningAmount)}] });
    instances.push(inst);
  }
  window.VIEWS['/dashboard'] = {
    title: '驾驶舱',
    async render(container, ctx) {
      const run = ++generation;
      disposeAll();
      const dash = ctx.query.get('dash') || '';
      const r = await API.get('/api/dashboard/mine', { dashboard: dash });
      const d = r.data;
      if (run !== generation) return;
      if (!d.dashboard) {
        container.innerHTML = '<div class="warn">当前角色尚未配置驾驶舱视图，请联系系统管理员在「权限矩阵」中分配。</div>';
        return;
      }
      APP.onDataDate(d.statDate || '');
      const flows = [
        ['/lead', '01', '线索获客', '发现下一位客户', '✦', 'orange'],
        ['/customer', '02', '客户经营', '连接与持续跟进', '◎', 'pink'],
        ['/opportunity', '03', '商机推进', '把握每一次机会', '↗', 'purple'],
        ['/contract', '04', '合同签约', '让合作顺利落地', '▤', 'mint'],
        ['/order', '05', '订单回款', '追踪收入与交付', '◷', 'sky']
      ].filter(([path]) => APP.canVisit(path));
      container.innerHTML = `
        <section class="workspace-hero"><div class="hero-copy"><span class="eyebrow">MAKE CONNECTIONS. GROW TOGETHER.</span><h1>${UI.esc(ctx.me.realName)}，让增长发生<span class="hero-dot">.</span></h1><p>从客户的第一声问候，到每一次成交。<br/>在这里，看见业务进展，找到今天的下一步。</p><div class="hero-tags"><span>✦ ${UI.esc(ctx.me.roleName)}工作空间</span><span>● 客户与经营数据一览</span></div></div><div class="hero-art" aria-hidden="true"><div class="art-orbit"></div><div class="art-circle">↗</div><div class="art-square">✦</div><div class="art-pill">一起，向上生长</div><div class="art-dot"></div></div></section>
        ${flows.length ? `<div class="section-title"><div><h2>销售全流程</h2><span>把每一次连接，变成增长的机会</span></div><span class="sm muted">按当前角色权限展示</span></div><div class="workflow mb16">${flows.map(([path, n, name, desc, icon, tone]) => `<a class="workflow-step ${tone}" href="#${path}"><span class="workflow-icon">${icon}</span><div><span class="step-number">${n}</span><b>${name}</b><small>${desc}</small></div><span class="workflow-arrow">↗</span></a>`).join('')}</div>` : ''}
        <div class="section-title"><div><h2>经营概览</h2><span>${UI.esc(d.dashboard.description || '用数据掌握业务进展')}</span></div></div>
        <div class="flex between center wrap gap12 mb12">
          <div class="tabs" style="margin:0;border:0">${d.dashboards.map((x) =>
            `<div class="tab ${x.code === d.dashboard.code ? 'active' : ''}" data-dash="${x.code}">${UI.esc(x.name)}</div>`).join('')}</div>
          <div class="flex gap8 center">
            <span class="badge green">指标数据日（T+1）：${UI.esc(d.statDate || '')}</span>
            <button class="btn sm" id="refreshDash">刷新</button>
          </div>
        </div>
        ${d.cards.length ? `<div class="grid cols-4 mb16">${d.cards.map(kpiCard).join('')}</div>` : ''}
        ${APP.database === 'pg' ? '<section id="businessPulse"></section>' : ''}
        <div class="section-title"><div><h2>增长洞察</h2><span>趋势、分布与转化，一目了然</span></div></div><div class="grid cols-2 dashboard-charts">${d.charts.map(chartCard).join('')}</div>`;

      container.querySelectorAll('[data-dash]').forEach((el) => {
        el.onclick = () => { location.hash = '#/dashboard?dash=' + el.dataset.dash; };
      });
      container.querySelector('#refreshDash').onclick = () => window.VIEWS['/dashboard'].render(container, ctx);

      await loadCards(container, d.cards.map((c) => c.code), run);
      await businessPulse(container, run);
      await loadCharts(container, d.charts.map((c) => c.code), run);
    },
    dispose() { generation++; disposeAll(); }
  };

  window.addEventListener('resize', () => instances.forEach((i) => { try { i.resize(); } catch (e) { /* noop */ } }));
})();
