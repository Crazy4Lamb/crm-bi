/* 统计图中心（浏览全部图型）与统计图设计（维度/系列/统计方式/样式 + 实时预览） */
(function () {
  const TYPE_LABEL = { bar: '柱形图', bar_h: '条形图', line: '折线图', area: '面积图', pie: '饼图', doughnut: '环形图', scatter: '散点图', heatmap: '热度图', funnel: '漏斗图', radar: '雷达图', gauge: '仪表盘' };
  const AGG = { sum: '求和', count: '计数', count_distinct: '去重计数', avg: '平均值', max: '最大值', min: '最小值' };
  const PALETTE = { blue: '经典蓝', purple: '科技紫', green: '增长绿', orange: '活力橙', teal: '青蓝', red: '警示红', multi: '多彩', heat: '热力' };
  const charts = [];

  function renderChart(box, option) {
    const inst = echarts.init(box);
    inst.setOption(option);
    charts.push(inst);
    return inst;
  }

  // ================================================================ 统计图中心
  async function gallery(container, ctx) {
    charts.forEach((c) => { try { c.dispose(); } catch (e) { /* noop */ } });
    charts.length = 0;
    const lib = (await API.get('/api/dashboard/widget-library')).data;
    const chartWidgets = lib.filter((w) => w.widgetType === 'chart');
    const state = { type: '', scope: 'global' };

    container.innerHTML = `
      <div class="card mb16"><div class="card-bd">
        <div class="flex wrap gap8 center">
          <select class="input" id="typeSel" style="width:170px"><option value="">全部图型</option>${Object.entries(TYPE_LABEL).map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
          <select class="input" id="scopeSel" style="width:150px"><option value="global">全量数据</option><option value="dept">本部门</option><option value="self">仅本人</option></select>
          <button class="btn sm" id="reloadBtn">刷新</button>
          <div style="flex:1"></div>
          ${ctx.can('widget:design') ? '<button class="btn primary" id="toDesign">+ 设计统计图</button>' : ''}
        </div>
      </div></div>
      <div class="grid cols-2" id="grid"></div>`;

    const draw = async () => {
      const grid = container.querySelector('#grid');
      const list = chartWidgets.filter((w) => !state.type || w.chartType === state.type);
      if (!list.length) { grid.innerHTML = '<div class="card"><div class="empty">没有符合条件的统计图</div></div>'; return; }
      grid.innerHTML = list.map((w) => `
        <div class="card" data-code="${w.code}">
          <div class="card-hd">
            <div><div class="t">${UI.esc(w.name)}</div><div class="d">${TYPE_LABEL[w.chartType] || w.chartType} · ${w.scope === 'self' ? '仅本人' : w.scope === 'dept' ? '本部门' : '全局'} · ${w.dims.length} 维度 / ${w.series.length} 系列</div></div>
            <div class="flex gap8"><button class="btn sm" data-act="detail">数据</button>${ctx.can('widget:design') ? '<button class="btn sm" data-act="edit">编辑</button>' : ''}</div>
          </div>
          <div class="card-bd"><div class="chart-box" data-box><div class="empty">加载中…</div></div></div>
        </div>`).join('');
      // 批量取数（每批 20 个，避免逐个请求过慢）
      const byCode = new Map();
      try {
        for (let i = 0; i < list.length; i += 20) {
          const chunk = list.slice(i, i + 20).map((w) => w.code);
          const res = await API.get('/api/dashboard/widgets', { codes: chunk.join(',') });
          if (!container.isConnected) return;
          (res.data || []).forEach((d) => byCode.set(d.code, d));
        }
      } catch (err) {
        grid.innerHTML = `<div class="card"><div class="card-bd"><div class="err">${UI.esc(err.message)}</div></div></div>`;
        return;
      }

      for (const w of list) {
        const card = grid.querySelector(`[data-code="${w.code}"]`);
        const box = card.querySelector('[data-box]');
        const d = byCode.get(w.code);
        if (!d || !d.ok) { box.innerHTML = `<div class="err">${UI.esc((d && d.error) || '取数失败')}</div>`; continue; }
        try {
          box.innerHTML = '';
          renderChart(box, d.data.option);
          card.querySelector('[data-act="detail"]').onclick = () => showDetail(d);
          const e = card.querySelector('[data-act="edit"]');
          if (e) e.onclick = () => { location.hash = '#/widget-design?id=' + w.id; };
        } catch (err) { box.innerHTML = `<div class="err">${UI.esc(err.message)}</div>`; }
      }
    };

    function showDetail(d) {
      UI.modal({
        title: d.name + ' · 数据明细（' + (d.data.rows || []).length + ' 行）', size: 'wide',
        body: UI.table((d.data.columns || []).map((c) => ({
          key: c.key, name: c.name, align: c.type === 'number' ? 'right' : 'left',
          render: (row) => c.enum ? UI.esc((UI.enumMap(c.enum)[row[c.key]] || row[c.key] || '-')) : UI.esc(UI.fmtByType(row[c.key], c.type, c.fmt))
        })), d.data.rows || [])
      });
    }

    container.querySelector('#typeSel').onchange = (e) => { state.type = e.target.value; draw(); };
    container.querySelector('#reloadBtn').onclick = () => draw();
    const td = container.querySelector('#toDesign');
    if (td) td.onclick = () => { location.hash = '#/widget-design'; };
    await draw();
  }

  // ================================================================ 统计图设计
  async function designer(container, ctx, presetId) {
    charts.forEach((c) => { try { c.dispose(); } catch (e) { /* noop */ } });
    charts.length = 0;
    const meta = (await API.get('/api/chart/meta')).data;
    const lib = (await API.get('/api/chart/list')).data.filter((w) => w.widget_type === 'chart');
    const state = { id: presetId ? Number(presetId) : null, cfg: null, timer: null };

    container.innerHTML = `
      <div class="split wide-left">
        <div class="card" style="align-self:start">
          <div class="card-hd"><div><div class="t">统计图列表</div><div class="d">共 ${lib.length} 个</div></div><button class="btn sm primary" id="newBtn">新建</button></div>
          <div class="card-bd" style="max-height:72vh;overflow:auto">
            ${lib.map((w) => `<div class="list-item" data-id="${w.id}"><div class="flex between center"><b>${UI.esc(w.name)}</b><span class="tag">${TYPE_LABEL[w.chart_type] || w.chart_type || w.widget_type}</span></div>
              <div class="sm muted mono">${UI.esc(w.code)}</div></div>`).join('')}
          </div>
        </div>
        <div id="design"><div class="empty">选择左侧统计图或将新建</div></div>
      </div>`;

    container.querySelectorAll('.list-item').forEach((el) => {
      el.onclick = () => load(Number(el.dataset.id));
    });
    container.querySelector('#newBtn').onclick = () => newChart();

    function newChart() {
      state.id = null;
      const rep = meta.reports[0];
      const dims = rep ? rep.fields.filter((f) => f.field_role === 'dimension' && !f.is_custom) : [];
      const meas = rep ? rep.fields.filter((f) => f.field_role === 'measure') : [];
      state.cfg = {
        name: '新建统计图', chartType: 'bar', reportId: rep ? rep.id : null,
        dims: dims[0] ? [dims[0].field_key] : [],
        series: meas[0] ? [{ key: meas[0].field_key, agg: 'sum', name: meas[0].field_name }] : [],
        filters: [], sortStrategy: 'value_desc', limit: 20, scope: 'global', style: { palette: 'blue', legend: 'top' }
      };
      render();
    }

    async function load(id) {
      state.id = id;
      container.querySelectorAll('.list-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.id) === id));
      const w = (await API.get('/api/chart/' + id)).data;
      state.cfg = {
        name: w.name, code: w.code, chartType: w.chart_type, reportId: w.report_id, metricId: w.metric_id,
        dims: w.dimension_keys || [], series: w.series || [], filters: w.filters || [],
        sortStrategy: w.sort_strategy || 'value_desc', limit: w.limit_rows || 20, scope: w.scope || 'global',
        style: w.style || {}, unit: w.unit
      };
      render();
    }

    const curReport = () => meta.reports.find((r) => r.id === Number(state.cfg.reportId)) || null;

    function render() {
      const c = state.cfg;
      const rep = curReport();
      const dims = rep ? rep.fields.filter((f) => f.field_role === 'dimension' && !f.is_custom) : [];
      const meas = rep ? rep.fields.filter((f) => f.field_role === 'measure') : [];
      const isGauge = c.chartType === 'gauge';

      container.querySelector('#design').innerHTML = `
        <div class="card mb16">
          <div class="card-hd"><div><div class="t">${UI.esc(c.name)}</div><div class="d">${state.id ? '编辑已有统计图' : '新建统计图'} · ${TYPE_LABEL[c.chartType] || c.chartType}</div></div>
            <div class="flex gap8">
              ${state.id ? '<button class="btn sm danger" id="delBtn">删除</button>' : ''}
              <button class="btn sm primary" id="saveBtn">保存</button>
            </div>
          </div>
          <div class="card-bd">
            <div class="grid cols-3">
              <div class="field"><label>名称</label><input class="input" data-cfg="name" value="${UI.esc(c.name)}" /></div>
              <div class="field"><label>图型</label><select class="input" data-cfg="chartType">${UI.options(meta.chartTypes, c.chartType)}</select></div>
              <div class="field"><label>数据来源报表</label><select class="input" data-cfg="reportId" ${isGauge ? 'disabled' : ''}>${UI.options(meta.reports.map((r) => [r.id, `${r.name}（${r.dataset_name}）`]), c.reportId)}</select></div>
            </div>
            ${isGauge ? '<div class="warn">仪表盘图型使用指标（T+1）作为数据源，请在驾驶舱/指标设计中维护；此处仅配置样式与目标值。</div>' : `
            <div class="field"><label>分组维度（可多选，热力图为两个维度）</label>
              <div class="flex wrap gap12">${dims.map((f) => `<label class="flex center gap8"><input type="checkbox" data-dim="${f.field_key}" ${c.dims.includes(f.field_key) ? 'checked' : ''}/> ${UI.esc(f.field_name)} <span class="tag">${f.field_key}</span></label>`).join('') || '<span class="muted">该报表没有可用维度</span>'}</div>
            </div>
            <div class="field"><label>数值系列（每个系列可选择统计方式）</label>
              <div class="tbl-wrap"><table class="tbl"><thead><tr><th>度量字段</th><th>统计方式</th><th>系列名称</th><th>按维度拆分</th><th></th></tr></thead>
              <tbody id="seriesBody">${c.series.map((s, i) => seriesRow(s, i, meas, dims)).join('')}</tbody></table></div>
              <button class="btn sm mt8" id="addSeries">+ 添加系列</button>
            </div>`}
            <div class="grid cols-4">
              <div class="field"><label>排序方式</label><select class="input" data-cfg="sortStrategy">${UI.options(meta.sortStrategies, c.sortStrategy)}</select></div>
              <div class="field"><label>最多显示条数</label><input class="input" type="number" data-cfg="limit" value="${c.limit}" /></div>
              <div class="field"><label>数据范围</label><select class="input" data-cfg="scope">${UI.options(meta.scopes, c.scope)}</select></div>
              <div class="field"><label>调色板</label><select class="input" data-style="palette">${UI.options(meta.palettes, c.style.palette || 'blue')}</select></div>
            </div>
            <div class="grid cols-4">
              <div class="field"><label>图例位置</label><select class="input" data-style="legend">${UI.options([['top', '顶部'], ['right', '右侧']], c.style.legend || 'top')}</select></div>
              <div class="field"><label>样式</label>
                <div class="flex wrap gap12 mt8">
                  <label class="flex center gap8"><input type="checkbox" data-style="stack" ${c.style.stack ? 'checked' : ''}/> 堆叠</label>
                  <label class="flex center gap8"><input type="checkbox" data-style="smooth" ${c.style.smooth ? 'checked' : ''}/> 平滑</label>
                  <label class="flex center gap8"><input type="checkbox" data-style="showLabel" ${c.style.showLabel ? 'checked' : ''}/> 显示数值</label>
                </div>
              </div>
              <div class="field"><label>目标值（仪表盘/目标完成率）</label><input class="input" type="number" data-style="target" value="${c.style.target || ''}" /></div>
              <div class="field"><label>单位</label><input class="input" data-cfg="unit" value="${UI.esc(c.unit || '')}" /></div>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-hd"><div><div class="t">实时预览</div><div class="d">修改配置后自动刷新</div></div><div class="sm muted" id="previewMsg"></div></div>
          <div class="card-bd"><div class="chart-box" id="previewBox" style="height:340px"><div class="empty">配置中…</div></div></div>
        </div>`;
      bind();
      preview();
    }

    function seriesRow(s, i, meas, dims) {
      return `<tr>
        <td><select class="input" data-si="${i}" data-sk="key">${UI.options(meas.map((f) => [f.field_key, `${f.field_name}（${f.field_key}）`]), s.key)}</select></td>
        <td><select class="input" data-si="${i}" data-sk="agg">${UI.options(Object.entries(AGG).map(([v, t]) => [v, t]), s.agg || 'sum')}</select></td>
        <td><input class="input" data-si="${i}" data-sk="name" value="${UI.esc(s.name || '')}" /></td>
        <td><select class="input" data-si="${i}" data-sk="splitBy">${UI.options([[ '', '不拆分']].concat(dims.map((d) => [d.field_key, d.field_name])), s.splitBy || '')}</select></td>
        <td><button class="btn-link danger" data-sdel="${i}">删除</button></td>
      </tr>`;
    }

    function bind() {
      container.querySelectorAll('[data-cfg]').forEach((el) => {
        el.onchange = () => {
          const k = el.dataset.cfg;
          state.cfg[k] = k === 'limit' || k === 'reportId' ? Number(el.value) : el.value;
          if (k === 'reportId' || k === 'chartType') {
            if (k === 'reportId') {
              const rep = curReport();
              const dims = rep ? rep.fields.filter((f) => f.field_role === 'dimension' && !f.is_custom) : [];
              const meas = rep ? rep.fields.filter((f) => f.field_role === 'measure') : [];
              state.cfg.dims = dims[0] ? [dims[0].field_key] : [];
              state.cfg.series = meas[0] ? [{ key: meas[0].field_key, agg: 'sum', name: meas[0].field_name }] : [];
            }
            render();
            return;
          }
          preview();
        };
      });
      container.querySelectorAll('[data-dim]').forEach((el) => {
        el.onchange = () => {
          const k = el.dataset.dim;
          if (el.checked) { if (!state.cfg.dims.includes(k)) state.cfg.dims.push(k); }
          else state.cfg.dims = state.cfg.dims.filter((x) => x !== k);
          preview();
        };
      });
      container.querySelectorAll('[data-style]').forEach((el) => {
        el.onchange = () => {
          const k = el.dataset.style;
          state.cfg.style[k] = el.type === 'checkbox' ? el.checked : (k === 'target' ? Number(el.value) || 0 : el.value);
          preview();
        };
      });
      container.querySelectorAll('[data-sk]').forEach((el) => {
        el.onchange = () => {
          const i = Number(el.dataset.si);
          state.cfg.series[i][el.dataset.sk] = el.value;
          preview();
        };
      });
      container.querySelectorAll('[data-sdel]').forEach((el) => {
        el.onclick = () => { state.cfg.series.splice(Number(el.dataset.sdel), 1); render(); };
      });
      const add = container.querySelector('#addSeries');
      if (add) add.onclick = () => {
        const rep = curReport();
        const meas = rep ? rep.fields.filter((f) => f.field_role === 'measure') : [];
        if (!meas.length) return UI.toast('该报表没有可用度量', 'err');
        state.cfg.series.push({ key: meas[0].field_key, agg: 'sum', name: meas[0].field_name });
        render();
      };
      const del = container.querySelector('#delBtn');
      if (del) del.onclick = () => UI.confirmBox('删除统计图', '删除后不可恢复，确定删除？', async () => {
        try { await API.del('/api/chart/' + state.id); UI.toast('已删除', 'ok'); location.hash = '#/widget-design'; location.reload(); } catch (e) { UI.toast(e.message, 'err'); }
      });
      container.querySelector('#saveBtn').onclick = save;
    }

    function preview() {
      const msg = container.querySelector('#previewMsg');
      const box = container.querySelector('#previewBox');
      if (!state.cfg.reportId || state.cfg.chartType === 'gauge') {
        if (state.cfg.chartType === 'gauge') { box.innerHTML = '<div class="empty">仪表盘预览请在驾驶舱查看（数据来自 T+1 指标）</div>'; }
        return;
      }
      clearTimeout(state.timer);
      state.timer = setTimeout(async () => {
        msg.textContent = '渲染中…';
        try {
          const r = await API.post('/api/chart/preview', state.cfg);
          box.innerHTML = '';
          const inst = echarts.init(box);
          inst.setOption(r.data.option);
          charts.push(inst);
          msg.textContent = `${(r.data.rows || []).length} 行数据 · 数据范围 ${r.data.scope === 'global' ? '全量' : r.data.scope === 'dept' ? '本部门' : '仅本人'}`;
        } catch (e) {
          box.innerHTML = `<div class="err">${UI.esc(e.message)}</div>`;
          msg.textContent = '配置有误';
        }
      }, 350);
    }

    async function save() {
      const c = state.cfg;
      if (!c.name) return UI.toast('请填写名称', 'err');
      if (c.chartType !== 'gauge' && (!c.reportId || !c.series.length)) return UI.toast('请选择数据来源与至少一个系列', 'err');
      try {
        if (state.id) {
          await API.put('/api/chart/' + state.id, c);
          UI.toast('已保存', 'ok');
        } else {
          const r = await API.post('/api/chart', { ...c, widgetType: 'chart' });
          state.id = r.data.id;
          UI.toast('已创建并授权给当前角色', 'ok');
        }
        const lib2 = (await API.get('/api/chart/list')).data.filter((w) => w.widget_type === 'chart');
        lib.length = 0; lib.push(...lib2);
        await load(state.id);
      } catch (e) { UI.toast(e.message, 'err'); }
    }

    if (state.id) await load(state.id); else newChart();
  }

  window.addEventListener('resize', () => charts.forEach((c) => { try { c.resize(); } catch (e) { /* noop */ } }));

  window.VIEWS = window.VIEWS || {};
  window.VIEWS['/chart'] = { title: '统计图中心', render: gallery, dispose() { charts.forEach((c) => c.dispose()); charts.length = 0; } };
  window.VIEWS['/widget-design'] = { title: '统计图设计', render: (c, ctx) => designer(c, ctx, ctx.query.get('id')) };
})();
