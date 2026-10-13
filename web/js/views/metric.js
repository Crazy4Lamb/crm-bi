/* 指标设计：定义 T+1 指标（数据来源报表 + 度量 + 统计方式 + 日期口径 + 过滤），查看指标值序列与区间统计 */
(function () {
  const instances = [];
  const DATE_MODE = { day: '当日', mtd: '本月累计', month: '整月', last7: '近 7 天', last30: '近 30 天', all: '全部' };
  const AGG = { sum: '求和', count: '计数', count_distinct: '去重计数', avg: '平均值', max: '最大值', min: '最小值' };

  function dispose() {
    instances.forEach((i) => { try { i.dispose(); } catch (e) { /* noop */ } });
    instances.length = 0;
  }
  const fmtDate = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  async function render(container, ctx) {
    dispose();
    const editable = ctx.can('metric:design');
    const meta = (await API.get('/api/metric/meta')).data;
    const list = (await API.get('/api/metric/list')).data;
    const state = { id: null, cfg: null, list, filter: { group: '', kw: '' }, values: null, vFrom: '', vTo: '' };

    const groups = [...new Set(list.map((x) => x.metric_group).filter(Boolean))];
    const today = new Date();

    container.innerHTML = `
      <div class="split wide-left">
        <div class="card" style="align-self:start">
          <div class="card-hd"><div><div class="t">指标库</div><div class="d">共 ${list.length} 个指标</div></div>
            ${editable ? '<button class="btn sm primary" id="newBtn">新建指标</button>' : ''}</div>
          <div class="card-bd">
            <div class="flex gap8 mb12">
              <select class="input" id="groupSel" style="width:130px">${UI.options([['', '全部分组']].concat(groups.map((g) => [g, g])), '')}</select>
              <input class="input" id="kw" placeholder="搜索名称 / 编码" />
            </div>
            <div id="mlist" style="max-height:66vh;overflow:auto"></div>
          </div>
        </div>
        <div id="design"><div class="empty">加载中…</div></div>
      </div>`;

    // ---- 左侧列表 ----
    function drawList() {
      const box = container.querySelector('#mlist');
      const f = state.filter;
      const rows = state.list.filter((m) =>
        (!f.group || m.metric_group === f.group) &&
        (!f.kw || (m.name + m.code).toLowerCase().includes(f.kw.toLowerCase())));
      if (!rows.length) { box.innerHTML = '<div class="empty">没有匹配的指标</div>'; return; }
      const byGroup = {};
      rows.forEach((m) => { const g = m.metric_group || '未分组'; (byGroup[g] = byGroup[g] || []).push(m); });
      box.innerHTML = Object.entries(byGroup).map(([g, items]) => `
        <div class="nav-group" style="padding-left:0">${UI.esc(g)}</div>
        ${items.map((m) => `<div class="list-item ${state.id === m.id ? 'active' : ''}" data-id="${m.id}">
          <div class="flex between center"><b>${UI.esc(m.name)}</b><span class="tag">${UI.esc(AGG[m.agg_fn] || m.agg_fn)}</span></div>
          <div class="sm muted">${UI.esc(DATE_MODE[m.date_mode] || m.date_mode)} · ${m.unit ? UI.esc(m.unit) : '—'} · 最新 ${m.last_value == null ? '—' : UI.num(m.last_value)}${m.last_value == null ? '' : ''}</div>
          <div class="sm mono muted">${UI.esc(m.code)}</div>
        </div>`).join('')}`).join('');
      box.querySelectorAll('.list-item').forEach((el) => { el.onclick = () => load(Number(el.dataset.id)); });
    }

    container.querySelector('#groupSel').onchange = (e) => { state.filter.group = e.target.value; drawList(); };
    container.querySelector('#kw').oninput = (e) => { state.filter.kw = e.target.value; drawList(); };
    const nb = container.querySelector('#newBtn');
    if (nb) nb.onclick = () => createNew();

    // ---- 右侧设计 ----
    const curReport = () => meta.reports.find((r) => r.id === Number(state.cfg && state.cfg.reportId)) || null;
    const repFields = (rep, role) => (rep ? rep.fields.filter((f) => f.field_role === role) : []);
    const dateFields = (rep) => {
      if (!rep) return [];
      const dts = rep.fields.filter((f) => f.field_type === 'date' && !f.is_custom);
      return dts.length ? dts : rep.fields.filter((f) => f.field_role === 'dimension' && !f.is_custom);
    };

    function createNew() {
      const rep = meta.reports[0];
      const meas = repFields(rep, 'measure');
      const dts = dateFields(rep);
      state.id = null;
      state.cfg = {
        name: '新建指标', code: '', metricGroup: '自定义',
        reportId: rep ? rep.id : null,
        measureKey: meas[0] ? meas[0].field_key : null,
        aggFn: meas[0] && meas[0].agg_fn && meas[0].agg_fn !== 'none' ? meas[0].agg_fn : 'sum',
        dateFieldKey: dts[0] ? dts[0].field_key : null,
        dateMode: 'day', filters: [], unit: '', precision: 0, direction: 'up', description: '', status: '1'
      };
      const r0 = new Date(today); r0.setDate(r0.getDate() - 1);
      state.vFrom = fmtDate(new Date(today.getTime() - 29 * 86400000));
      state.vTo = fmtDate(r0);
      state.values = null;
      draw();
    }

    async function load(id) {
      state.id = id;
      drawList();
      const m = (await API.get('/api/metric/' + id)).data;
      state.cfg = {
        name: m.name, code: m.code, metricGroup: m.metric_group || '', reportId: m.report_id,
        measureKey: m.measure_key, aggFn: m.agg_fn || 'sum', dateFieldKey: m.date_field_key,
        dateMode: m.date_mode || 'day', filters: m.filters || [], unit: m.unit || '',
        precision: m.precision == null ? 0 : m.precision, direction: m.direction || 'up',
        description: m.description || '', status: m.status || '1'
      };
      const r0 = new Date(today); r0.setDate(r0.getDate() - 1);
      if (!state.vFrom) state.vFrom = fmtDate(new Date(today.getTime() - 29 * 86400000));
      if (!state.vTo) state.vTo = fmtDate(r0);
      draw();
      loadValues();
    }

    function draw() {
      const c = state.cfg;
      const rep = curReport();
      const meas = repFields(rep, 'measure');
      const dts = dateFields(rep);
      const ro = editable ? '' : 'disabled';

      container.querySelector('#design').innerHTML = `
        <div class="card mb16">
          <div class="card-hd">
            <div><div class="t">${UI.esc(c.name)}</div><div class="d">${state.id ? '编辑指标 · ' + UI.esc(c.code) : '新建指标 · 保存后可在任务管理中执行计算'}</div></div>
            <div class="flex gap8">
              ${state.id ? '<button class="btn sm" id="previewBtn">试算</button><button class="btn sm" id="computeBtn">补算</button>' : ''}
              ${state.id && editable ? '<button class="btn sm danger" id="delBtn">删除</button>' : ''}
              <button class="btn sm primary" id="saveBtn" ${ro}>保存</button>
            </div>
          </div>
          <div class="card-bd">
            <div class="grid cols-3">
              <div class="field"><label>指标名称 *</label><input class="input" data-cfg="name" value="${UI.esc(c.name)}" ${ro} /></div>
              <div class="field"><label>指标编码${state.id ? '（不可修改）' : ''}</label><input class="input mono" data-cfg="code" value="${UI.esc(c.code)}" placeholder="留空自动生成" ${state.id ? 'disabled' : ro} /></div>
              <div class="field"><label>指标分组</label><input class="input" data-cfg="metricGroup" value="${UI.esc(c.metricGroup)}" list="groupList" ${ro} />
                <datalist id="groupList">${groups.map((g) => `<option value="${UI.esc(g)}"></option>`).join('')}</datalist></div>
            </div>
            <div class="grid cols-3">
              <div class="field"><label>数据来源报表 *</label><select class="input" data-cfg="reportId" ${ro}>${UI.options(meta.reports.map((r) => [r.id, `${r.name}（${r.dataset_name}）`]), c.reportId)}</select></div>
              <div class="field"><label>度量字段 *</label><select class="input" data-cfg="measureKey" ${ro}>${UI.options(meas.map((f) => [f.field_key, `${f.field_name}（${f.field_key}）`]), c.measureKey)}</select></div>
              <div class="field"><label>统计方式</label><select class="input" data-cfg="aggFn" ${ro}>${UI.options(meta.aggs.map((a) => [a.value, a.label]), c.aggFn)}</select></div>
            </div>
            <div class="grid cols-3">
              <div class="field"><label>日期字段 *</label><select class="input" data-cfg="dateFieldKey" ${ro}>${UI.options(dts.map((f) => [f.field_key, `${f.field_name}（${f.field_key}）`]), c.dateFieldKey)}</select></div>
              <div class="field"><label>日期口径</label><select class="input" data-cfg="dateMode" ${ro}>${UI.options(meta.dateModes, c.dateMode)}</select></div>
              <div class="field"><label>单位</label><input class="input" data-cfg="unit" value="${UI.esc(c.unit)}" list="unitList" ${ro} />
                <datalist id="unitList">${(meta.units || []).map((u) => `<option value="${UI.esc(u)}"></option>`).join('')}</datalist></div>
            </div>
            <div class="grid cols-4">
              <div class="field"><label>小数位</label><input class="input" type="number" min="0" max="4" data-cfg="precision" value="${c.precision}" ${ro} /></div>
              <div class="field"><label>目标方向</label><select class="input" data-cfg="direction" ${ro}>${UI.options(meta.directions, c.direction)}</select></div>
              <div class="field"><label>状态</label><select class="input" data-cfg="status" ${ro}>${UI.options([['1', '启用'], ['0', '停用']], c.status)}</select></div>
              <div class="field"><label>说明</label><input class="input" data-cfg="description" value="${UI.esc(c.description)}" ${ro} /></div>
            </div>
            <div class="field"><label>固定过滤条件（作用于该指标的全部取数）</label>
              <div id="filterArea">${c.filters.map((f, i) => filterRow(f, i, rep, ro)).join('') || '<div class="sm muted">暂无过滤条件</div>'}</div>
              ${editable ? '<button class="btn sm mt8" id="addFilter">+ 添加过滤条件</button>' : ''}
            </div>
            <div class="hint mt12">指标口径：对「${UI.esc(rep ? rep.name : '-')}」按 <span class="mono">${UI.esc(c.dateFieldKey || '-')}</span> 分组，取 ${UI.esc(DATE_MODE[c.dateMode] || '')} 的 <b>${UI.esc(AGG[c.aggFn] || c.aggFn)}</b>，落库到指标值表（数据日 T+1）。</div>
          </div>
        </div>
        <div class="card">
          <div class="card-hd">
            <div><div class="t">指标值序列</div><div class="d">按数据日（stat_date）展示，可试算未落库的值</div></div>
            <div class="flex gap8 center">
              <input class="input" type="date" id="vFrom" value="${state.vFrom}" style="width:150px" />
              <span class="muted">~</span>
              <input class="input" type="date" id="vTo" value="${state.vTo}" style="width:150px" />
              <button class="btn sm" id="reloadValues">查询</button>
            </div>
          </div>
          <div class="card-bd">
            ${state.id ? `<div class="chart-box" id="metricTrend" style="height:240px"></div>
            <div id="valSummary" class="grid cols-4 mt12"></div>
            <div id="valTable" class="mt12"></div>` : '<div class="empty">保存指标后可查看指标值序列</div>'}
          </div>
        </div>`;

      bind();
    }

    function filterRow(f, i, rep, ro) {
      const dims = rep ? rep.fields.filter((x) => !x.is_custom) : [];
      return `<div class="flex gap8 center mb8">
        <select class="input" style="width:200px" data-fi="${i}" data-fk="fieldKey" ${ro}>${UI.options(dims.map((x) => [x.field_key, `${x.field_name}（${x.field_key}）`]), f.fieldKey)}</select>
        <select class="input" style="width:120px" data-fi="${i}" data-fk="op" ${ro}>${UI.options(meta.ops, f.op || 'eq')}</select>
        <input class="input" style="width:170px" data-fi="${i}" data-fk="value" value="${UI.esc(f.value == null ? '' : f.value)}" placeholder="值" ${ro} />
        <input class="input" style="width:150px" data-fi="${i}" data-fk="value2" value="${UI.esc(f.value2 == null ? '' : f.value2)}" placeholder="区间结束值" ${ro} />
        ${editable ? `<button class="btn-link danger" data-fdel="${i}">删除</button>` : ''}
      </div>`;
    }

    function bind() {
      const c = state.cfg;
      container.querySelectorAll('[data-cfg]').forEach((el) => {
        el.onchange = () => {
          const k = el.dataset.cfg;
          c[k] = ['reportId', 'precision'].includes(k) ? Number(el.value) : el.value;
          if (k === 'reportId') {
            const rep = curReport();
            const meas = repFields(rep, 'measure');
            const dts = dateFields(rep);
            c.measureKey = meas[0] ? meas[0].field_key : null;
            c.aggFn = meas[0] && meas[0].agg_fn && meas[0].agg_fn !== 'none' ? meas[0].agg_fn : 'sum';
            c.dateFieldKey = dts[0] ? dts[0].field_key : null;
            c.filters = [];
            draw();
          }
        };
      });
      container.querySelectorAll('[data-fk]').forEach((el) => {
        el.onchange = () => { const f = c.filters[Number(el.dataset.fi)]; if (f) f[el.dataset.fk] = el.value; };
      });
      container.querySelectorAll('[data-fdel]').forEach((el) => {
        el.onclick = () => { c.filters.splice(Number(el.dataset.fdel), 1); draw(); };
      });
      const af = container.querySelector('#addFilter');
      if (af) af.onclick = () => {
        const rep = curReport();
        const dims = rep ? rep.fields.filter((x) => !x.is_custom) : [];
        if (!dims.length) return UI.toast('该报表没有可用字段', 'err');
        c.filters.push({ fieldKey: dims[0].field_key, op: 'eq', value: '', value2: '' });
        draw();
      };
      container.querySelector('#saveBtn').onclick = save;
      const pv = container.querySelector('#previewBtn');
      if (pv) pv.onclick = preview;
      const cp = container.querySelector('#computeBtn');
      if (cp) cp.onclick = compute;
      const dl = container.querySelector('#delBtn');
      if (dl) dl.onclick = () => UI.confirmBox('删除指标', '将同时删除该指标的历史指标值与卡片引用，确定删除？', async () => {
        try { await API.del('/api/metric/' + state.id); UI.toast('已删除', 'ok'); reload(); } catch (e) { UI.toast(e.message, 'err'); }
      });
      const rf = container.querySelector('#reloadValues');
      if (rf) rf.onclick = () => {
        state.vFrom = container.querySelector('#vFrom').value;
        state.vTo = container.querySelector('#vTo').value;
        loadValues();
      };
    }

    async function reload() {
      const l = (await API.get('/api/metric/list')).data;
      state.list.length = 0; state.list.push(...l);
      state.id = null;
      drawList();
      createNew();
    }

    async function save() {
      const c = state.cfg;
      if (!c.name) return UI.toast('请填写指标名称', 'err');
      if (!c.reportId || !c.measureKey || !c.dateFieldKey) return UI.toast('数据来源、度量字段、日期字段必填', 'err');
      const payload = { ...c, filters: (c.filters || []).filter((f) => f.fieldKey && (f.value !== '' || ['isnull', 'notnull'].includes(f.op))) };
      try {
        if (state.id) { await API.put('/api/metric/' + state.id, payload); UI.toast('已保存', 'ok'); await reloadKeep(state.id); }
        else { const r = await API.post('/api/metric', payload); UI.toast(r.message || '已创建', 'ok'); state.id = r.data.id; await reloadKeep(r.data.id); }
      } catch (e) { UI.toast(e.message, 'err'); }
    }

    async function reloadKeep(id) {
      const l = (await API.get('/api/metric/list')).data;
      state.list.length = 0; state.list.push(...l);
      await load(id);
    }

    /** 日期输入弹窗（from/to 都为可选，只填 from 即单日） */
    function askRange(title, defFrom, defTo, onOk) {
      UI.modal({
        title,
        body: `<div class="grid cols-2">
            <div class="field"><label>起始日</label><input class="input" id="askFrom" type="date" value="${defFrom || ''}" /></div>
            <div class="field"><label>结束日（留空则只补起始日）</label><input class="input" id="askTo" type="date" value="${defTo || ''}" /></div>
          </div><div class="sm muted mt8">计算会覆盖同一天已有的指标值；试算不落库。</div>`,
        buttons: [
          { text: '取消' },
          {
            text: '确定', type: 'primary',
            onClick: (close, mask) => {
              const from = mask.querySelector('#askFrom').value;
              const to = mask.querySelector('#askTo').value;
              close();
              if (!from) return UI.toast('请选择起始日', 'err');
              onOk(from, to || from);
            }
          }
        ]
      });
    }

    async function preview() {
      askRange('试算指标值（不落库）', state.vTo || '', '', async (from) => {
        try {
          const r = await API.post('/api/metric/' + state.id + '/preview', { statDate: from });
          UI.toast(`试算 ${from}：${UI.num(r.data.value)}（未落库）`, 'ok');
        } catch (e) { UI.toast('试算失败：' + e.message, 'err'); }
      });
    }

    async function compute() {
      askRange('补算指标值并落库', state.vFrom, state.vTo, async (from, to) => {
        try {
          UI.toast('计算中，请稍候…');
          const r = await API.post('/api/metric/' + state.id + '/compute', from === to ? { statDate: from } : { from, to });
          UI.toast(r.message || '完成', 'ok');
          loadValues();
        } catch (e) { UI.toast('补算失败：' + e.message, 'err'); }
      });
    }

    async function loadValues() {
      if (!state.id) return;
      const trend = container.querySelector('#metricTrend');
      const sumBox = container.querySelector('#valSummary');
      const tbl = container.querySelector('#valTable');
      if (!trend) return;
      trend.innerHTML = '<div class="empty">加载中…</div>';
      try {
        const r = (await API.get('/api/metric/' + state.id + '/values', { from: state.vFrom, to: state.vTo })).data;
        state.values = r;
        const vs = r.values || [];
        const m = r.metric || {};
        if (!vs.length) {
          trend.innerHTML = '<div class="empty">该区间还没有指标值，可在上方「补算」或到「任务管理」中执行任务</div>';
          sumBox.innerHTML = ''; tbl.innerHTML = ''; return;
        }
        const unit = m.unit || '';
        trend.innerHTML = '';
        const inst = echarts.init(trend);
        inst.setOption({
          grid: { left: 56, right: 24, top: 30, bottom: 34 },
          tooltip: { trigger: 'axis', confine: true, formatter: (p) => p[0].axisValue + '<br/>' + UI.esc(m.name || '') + '：' + UI.num(p[0].value, m.precision || 2) + unit },
          xAxis: { type: 'category', data: vs.map((v) => v.statDate), axisLabel: { color: '#6b7a90' } },
          yAxis: { type: 'value', scale: true, axisLabel: { color: '#6b7a90' }, splitLine: { lineStyle: { color: '#eef2f8' } } },
          series: [{
            type: 'line', smooth: true, symbolSize: 5, data: vs.map((v) => v.value),
            lineStyle: { width: 2.2, color: m.direction === 'down' ? '#12a150' : '#2f6bff' },
            itemStyle: { color: m.direction === 'down' ? '#12a150' : '#2f6bff' },
            areaStyle: { color: (m.direction === 'down' ? '#12a150' : '#2f6bff') + '1f' }
          }]
        });
        instances.push(inst);

        const s = r.summary;
        sumBox.innerHTML = [
          ['区间条数', UI.num(s.count) + ' 天', null],
          ['最新值', UI.num(s.lastValue, m.precision || 2) + unit, s.lastDate],
          ['区间合计', UI.num(s.sum, m.precision || 2) + unit, null],
          ['区间均值', UI.num(s.avg, m.precision || 2) + unit, null],
          ['最大值', UI.num(s.max, m.precision || 2) + unit, null],
          ['最小值', UI.num(s.min, m.precision || 2) + unit, null]
        ].map(([k, v, d]) => `
          <div class="kpi" style="padding:12px">
            <div class="l"><span>${UI.esc(k)}</span></div>
            <div class="v" style="font-size:20px">${UI.esc(v)}</div>
            ${d ? `<div class="f"><span>${UI.esc(d)}</span></div>` : ''}
          </div>`).join('');

        tbl.innerHTML = UI.table([
          { key: 'statDate', name: '数据日', width: 120 },
          { key: 'value', name: '指标值', align: 'right', render: (row) => UI.num(row.value, m.precision || 2) },
          { key: 'prevValue', name: '上期值', align: 'right', render: (row) => (row.prevValue == null ? '-' : UI.num(row.prevValue, m.precision || 2)) },
          {
            key: 'growth', name: '环比', align: 'right',
            render: (row) => (row.growth == null ? '-' : `<span class="${row.growth >= 0 ? 'up' : 'down'}">${row.growth >= 0 ? '▲' : '▼'} ${(Math.abs(row.growth) * 100).toFixed(2)}%</span>`)
          },
          { key: 'calcTime', name: '计算时间', fmt: 'dt' }
        ], vs, {});
      } catch (e) {
        trend.innerHTML = '<div class="err">' + UI.esc(e.message) + '</div>';
      }
    }

    drawList();
    if (list.length) await load(list[0].id); else createNew();
  }

  window.addEventListener('resize', () => instances.forEach((i) => { try { i.resize(); } catch (e) { /* noop */ } }));

  window.VIEWS = window.VIEWS || {};
  window.VIEWS['/metric-design'] = { title: '指标设计', render };
})();
