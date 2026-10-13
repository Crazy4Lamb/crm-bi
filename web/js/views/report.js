/* 报表中心（执行/分组/排序/合计/导出/SQL）与报表设计（字段、自定义公式、过滤） */
(function () {
  const fmtCell = (col, v) => {
    if (v === null || v === undefined) return '-';
    if (col.enum) { const m = UI.enumMap(col.enum); return UI.esc(m[v] || v); }
    if (col.fmt === 'currency') return UI.money(v);
    if (col.fmt === 'percent') return UI.pct(v);
    if (col.type === 'number') return UI.num(v, col.fmt === 'number' ? 0 : 2);
    if (col.type === 'date') return UI.date(v);
    return UI.esc(v);
  };
  const aggLabel = { none: '不聚合', sum: '求和', count: '计数', count_distinct: '去重计数', avg: '平均值', max: '最大值', min: '最小值' };

  // ================================================================ 报表中心
  async function runner(container, ctx, presetId) {
    const list = (await API.get('/api/report/list')).data;
    const meta = (await API.get('/api/report/meta')).data;
    const cats = [...new Set(list.map((r) => r.category || '其他'))];
    const state = {
      reportId: presetId || (list[0] && list[0].id), page: 1, size: 20, filters: [], orderKey: '', orderDir: 'desc',
      fieldKeys: null, withTotal: true, scope: 'global', data: null
    };
    const canDesign = ctx.can('report:design');

    container.innerHTML = `
      <div class="split">
        <div class="card" style="align-self:start">
          <div class="card-hd"><div><div class="t">报表目录</div><div class="d">共 ${list.length} 张</div></div>
            ${canDesign ? '<button class="btn sm primary" id="newReport">新建</button>' : ''}</div>
          <div class="card-bd" style="max-height:70vh;overflow:auto">
            ${cats.map((c) => `<div class="nav-group" style="padding-left:0">${UI.esc(c)}</div>` + list.filter((r) => (r.category || '其他') === c).map((r) => `
              <div class="list-item" data-id="${r.id}"><div class="flex between center"><b>${UI.esc(r.name)}</b><span class="tag">${r.field_count} 字段</span></div>
              <div class="sm muted mt8">${UI.esc(r.description || '')}</div>
              <div class="sm" style="color:#9aa3b2;margin-top:2px">数据集：${UI.esc(r.dataset_name)}</div></div>`).join('')).join('')}
          </div>
        </div>
        <div>
          <div class="card mb16">
            <div class="card-hd">
              <div><div class="t" id="rTitle">-</div><div class="d" id="rDesc"></div></div>
              <div class="flex gap8">
                <label class="sm muted flex center gap8"><input type="checkbox" id="withTotal" checked /> 显示合计行</label>
                <select class="input" id="scopeSel" style="width:130px">
                  <option value="global">全量数据</option><option value="dept">本部门</option><option value="self">仅本人</option>
                </select>
                <button class="btn sm" id="fieldsBtn">字段设置</button>
                <button class="btn sm" id="sqlBtn">查看 SQL</button>
                <button class="btn sm" id="exportBtn">导出 CSV</button>
              </div>
            </div>
            <div class="card-bd">
              <div class="flex wrap gap8 center mb12" id="filterBar"></div>
              <div class="flex wrap gap8 center">
                <select class="input" id="orderKey" style="width:170px"></select>
                <select class="input" id="orderDir" style="width:100px"><option value="desc">降序</option><option value="asc">升序</option></select>
                <button class="btn sm" id="applyOrder">应用排序</button>
                <select class="input" id="sizeSel" style="width:120px">
                  ${[10, 20, 50, 100, 200].map((n) => `<option value="${n}"${n === 20 ? ' selected' : ''}>每页 ${n} 条</option>`).join('')}
                </select>
                <button class="btn sm primary" id="runBtn">执行查询</button>
              </div>
            </div>
          </div>
          <div class="card"><div class="card-bd np"><div id="result"><div class="empty">请选择左侧报表</div></div></div></div>
        </div>
      </div>`;

    container.querySelectorAll('.list-item').forEach((el) => {
      el.onclick = () => selectReport(Number(el.dataset.id));
    });
    const newBtn = container.querySelector('#newReport');
    if (newBtn) newBtn.onclick = () => createReport(meta, (id) => { location.hash = '#/report-design?id=' + id; });

    function markActive() {
      container.querySelectorAll('.list-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.id) === state.reportId));
    }

    async function selectReport(id) {
      state.reportId = id; state.page = 1; state.filters = []; state.orderKey = ''; state.fieldKeys = null;
      markActive();
      const def = (await API.get('/api/report/' + id)).data;
      const r = list.find((x) => x.id === id);
      container.querySelector('#rTitle').textContent = r.name;
      container.querySelector('#rDesc').textContent = `${r.description || ''} · 数据集 ${def.dataset.name}（${def.dataset.base_table}）`;
      container.querySelector('#orderKey').innerHTML = UI.options(def.columnMeta.filter((c) => c.role === 'dimension').map((c) => [c.key, c.name]), '', '默认排序');
      renderFilters(def.columnMeta);
      await run();
    }

    function renderFilters(cols) {
      const dims = cols.filter((c) => !c.isCustom);
      const bar = container.querySelector('#filterBar');
      const row = (f, i) => `
        <div class="flex gap8 center" style="border:1px solid var(--border);border-radius:8px;padding:5px 8px">
          <select class="input" data-fi="${i}" data-k="fieldKey" style="width:140px">${UI.options(dims.map((c) => [c.key, c.name]), f.fieldKey)}</select>
          <select class="input" data-fi="${i}" data-k="op" style="width:110px">${UI.options(meta.ops, f.op || 'eq')}</select>
          <input class="input" data-fi="${i}" data-k="value" style="width:150px" placeholder="值（支持 $D30 等）" value="${UI.esc(f.value || '')}" />
          <button class="btn-link danger" data-fdel="${i}">×</button>
        </div>`;
      bar.innerHTML = state.filters.map(row).join('') + `<button class="btn sm" id="addFilter">+ 过滤条件</button>`;
      bar.querySelector('#addFilter').onclick = () => { state.filters.push({ fieldKey: dims[0] && dims[0].key, op: 'eq', value: '' }); renderFilters(cols); };
      bar.querySelectorAll('[data-k]').forEach((el) => {
        el.onchange = () => { state.filters[Number(el.dataset.fi)][el.dataset.k] = el.value; };
      });
      bar.querySelectorAll('[data-fdel]').forEach((el) => {
        el.onclick = () => { state.filters.splice(Number(el.dataset.fdel), 1); renderFilters(cols); };
      });
    }

    async function run() {
      if (!state.reportId) return;
      const box = container.querySelector('#result');
      box.innerHTML = '<div class="empty">查询中…</div>';
      const body = {
        reportId: state.reportId, page: state.page, size: state.size,
        filters: state.filters.filter((f) => f.fieldKey && f.op),
        withTotal: state.withTotal, scope: state.scope,
        fieldKeys: state.fieldKeys || undefined
      };
      if (state.orderKey) body.orderBy = [{ key: state.orderKey, dir: state.orderDir }];
      try {
        const r = await API.post('/api/report/run', body);
        state.data = r.data;
        renderResult(box);
      } catch (e) {
        box.innerHTML = `<div class="card-bd"><div class="err">${UI.esc(e.message)}</div></div>`;
      }
    }

    function renderResult(box) {
      const d = state.data;
      const cols = d.columns.map((c) => ({
        key: c.key, name: c.name + (c.agg && c.agg !== 'none' ? `（${aggLabel[c.agg] || c.agg}）` : ''),
        align: c.type === 'number' ? 'right' : 'left', width: c.width,
        render: (row) => fmtCell(c, row[c.key])
      }));
      let html = UI.table(cols, d.rows);
      if (d.total && d.withTotal !== false) {
        const totalRow = '<tr class="total">' + d.columns.map((c, i) => `<td class="${c.type === 'number' ? 'num' : ''}">${i === 0 ? '总计' : fmtCell(c, d.total[c.key])}</td>`).join('') + '</tr>';
        html = html.replace('</tbody>', totalRow + '</tbody>');
      }
      box.innerHTML = `<div class="flex between center wrap" style="padding:10px 16px;border-bottom:1px solid var(--border)">
          <div class="sm muted">${d.rows.length} 行 / 共 ${d.totalRows} 行 · 数据范围 ${d.scope === 'global' ? '全量' : d.scope === 'dept' ? '本部门' : '仅本人'}${d.grouped ? ' · 已分组' : ''}</div>
          <div class="sm mono muted">数据集 ${UI.esc(d.dataset.name)}</div>
        </div>` + html;
      box.appendChild(UI.pager(d.totalRows, state.page, state.size, (p) => { state.page = p; run(); }));
    }

    container.querySelector('#runBtn').onclick = () => { state.page = 1; run(); };
    container.querySelector('#withTotal').onchange = (e) => { state.withTotal = e.target.checked; run(); };
    container.querySelector('#scopeSel').onchange = (e) => { state.scope = e.target.value; run(); };
    container.querySelector('#sizeSel').onchange = (e) => { state.size = Number(e.target.value); state.page = 1; run(); };
    container.querySelector('#applyOrder').onclick = () => {
      state.orderKey = container.querySelector('#orderKey').value;
      state.orderDir = container.querySelector('#orderDir').value;
      run();
    };
    container.querySelector('#sqlBtn').onclick = () => {
      if (!state.data) return UI.toast('请先执行查询', 'err');
      UI.modal({ title: '本次查询使用的 SQL（白名单表达式构建）', size: 'wide', body: `<div class="code-box">${UI.esc(state.data.sql || '')}</div>` });
    };
    container.querySelector('#exportBtn').onclick = () => {
      window.open(`/api/report/${state.reportId}/export?scope=${state.scope}`, '_blank');
    };
    container.querySelector('#fieldsBtn').onclick = async () => {
      const def = (await API.get('/api/report/' + state.reportId)).data;
      const box = document.createElement('div');
      box.innerHTML = def.fields.map((f) => `
        <label class="flex center gap8" style="padding:4px 0"><input type="checkbox" data-fk="${f.field_key}" ${f.is_show !== false ? 'checked' : ''} />
        <span>${UI.esc(f.field_name)}</span> <span class="tag">${f.field_role === 'measure' ? (aggLabel[f.agg_fn] || '度量') : '维度'}</span>
        <span class="sm muted mono">${UI.esc(f.field_key)}</span></label>`).join('');
      UI.modal({
        title: '设置显示字段', body: box,
        buttons: [{ text: '取消' }, {
          text: '应用', type: 'primary', onClick: (close) => {
            const keys = [...box.querySelectorAll('input:checked')].map((el) => el.dataset.fk);
            state.fieldKeys = keys.length ? keys : null;
            close(); run();
          }
        }]
      });
    };

    markActive();
    await selectReport(state.reportId);
  }

  async function createReport(meta, done) {
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="field"><label>报表名称<span class="req">*</span></label><input class="input" id="rn" /></div>
      <div class="field"><label>数据集<span class="req">*</span></label><select class="input" id="rd">${UI.options(meta.datasets.map((d) => [d.id, `${d.name}（${d.base_table}）`]), '', '请选择')}</select></div>
      <div class="field"><label>分类</label><select class="input" id="rc">${UI.options(meta.categories, '自定义')}</select></div>
      <div class="field"><label>说明</label><input class="input" id="rs" /></div>`;
    UI.modal({
      title: '新建报表', body,
      buttons: [{ text: '取消' }, {
        text: '创建', type: 'primary', onClick: async (close, mask) => {
          const name = mask.querySelector('#rn').value.trim();
          const datasetId = Number(mask.querySelector('#rd').value);
          if (!name || !datasetId) return UI.toast('请填写名称并选择数据集', 'err');
          try {
            const r = await API.post('/api/report', { name, datasetId, category: mask.querySelector('#rc').value, description: mask.querySelector('#rs').value });
            close(); UI.toast('报表已创建，请设计字段', 'ok'); done(r.data.id);
          } catch (e) { UI.toast(e.message, 'err'); }
        }
      }]
    });
  }

  // ================================================================ 报表设计
  async function designer(container, ctx, presetId) {
    const list = (await API.get('/api/report/list')).data;
    const meta = (await API.get('/api/report/meta')).data;
    const state = { id: presetId ? Number(presetId) : (list[0] && list[0].id), def: null, fields: [], filters: [] };

    container.innerHTML = `
      <div class="split">
        <div class="card" style="align-self:start">
          <div class="card-hd"><div><div class="t">报表列表</div><div class="d">选择后编辑字段与过滤</div></div>
            <button class="btn sm primary" id="newReport">新建</button></div>
          <div class="card-bd" style="max-height:70vh;overflow:auto">
            ${list.map((r) => `<div class="list-item" data-id="${r.id}"><div class="flex between center"><b>${UI.esc(r.name)}</b><span class="tag">${UI.esc(r.category || '')}</span></div>
              <div class="sm muted mono">${UI.esc(r.code)}</div></div>`).join('')}
          </div>
        </div>
        <div id="designArea"><div class="empty">请选择报表</div></div>
      </div>`;

    container.querySelectorAll('.list-item').forEach((el) => {
      el.onclick = () => loadDef(Number(el.dataset.id));
    });
    container.querySelector('#newReport').onclick = () => createReport(meta, (id) => loadDef(id));

    async function loadDef(id) {
      state.id = id;
      container.querySelectorAll('.list-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.id) === id));
      const def = (await API.get('/api/report/' + id)).data;
      state.def = def;
      state.fields = def.fields.map((f) => ({
        fieldKey: f.field_key, fieldName: f.field_name, fieldType: f.field_type, fieldRole: f.field_role,
        datasetFieldKey: f.dataset_field_key, aggFn: f.agg_fn, customExpr: f.custom_expr || '',
        isGroupBy: !!f.is_group_by, isShow: f.is_show !== false, isCustom: !!f.is_custom,
        sortDir: f.sort_dir || 'none', fmt: f.fmt || ''
      }));
      state.filters = def.filters.map((f) => ({ fieldKey: f.field_key, op: f.op, value: f.value, value2: f.value2 }));
      render();
    }

    function datasetFields() {
      const ds = meta.datasets.find((d) => d.id === state.def.report.dataset_id);
      return ds ? ds.fields : [];
    }

    function render() {
      const r = state.def.report;
      const dsFields = datasetFields();
      const area = container.querySelector('#designArea');
      area.innerHTML = `
        <div class="card mb16">
          <div class="card-hd">
            <div><div class="t">${UI.esc(r.name)}</div><div class="d mono">${UI.esc(r.code)} · 数据集 ${UI.esc((meta.datasets.find((d) => d.id === r.dataset_id) || {}).name || '')}</div></div>
            <div class="flex gap8">
              <button class="btn sm" id="dupBtn">复制</button>
              <button class="btn sm danger" id="delBtn">删除</button>
              <button class="btn sm" id="previewBtn">保存并预览</button>
              <button class="btn sm primary" id="saveBtn">保存</button>
            </div>
          </div>
          <div class="card-bd">
            <div class="grid cols-2">
              <div class="field"><label>报表名称</label><input class="input" id="fName" value="${UI.esc(r.name)}" /></div>
              <div class="field"><label>分类</label><input class="input" id="fCat" value="${UI.esc(r.category || '')}" /></div>
            </div>
            <div class="field"><label>说明</label><input class="input" id="fDesc" value="${UI.esc(r.description || '')}" /></div>
          </div>
        </div>

        <div class="card mb16">
          <div class="card-hd"><div><div class="t">字段设计</div><div class="d">维度决定分组，度量决定统计方式；自定义字段支持四则运算公式</div></div>
            <button class="btn sm" id="addField">+ 添加字段</button></div>
          <div class="card-bd np">
            <div class="tbl-wrap"><table class="tbl">
              <thead><tr><th>显示名</th><th>字段标识</th><th>数据来源</th><th>角色</th><th>统计方式</th><th>分组</th><th>排序</th><th>格式</th><th>自定义公式</th><th>操作</th></tr></thead>
              <tbody>${state.fields.map((f, i) => fieldRow(f, i, dsFields)).join('')}</tbody>
            </table></div>
          </div>
        </div>

        <div class="card mb16">
          <div class="card-hd"><div><div class="t">固定过滤条件</div><div class="d">报表自带的过滤（日期支持 $D30 / $MONTH_START 等相对变量）</div></div>
            <button class="btn sm" id="addFilter">+ 添加条件</button></div>
          <div class="card-bd" id="filterArea">${state.filters.map((f, i) => filterRow(f, i)).join('') || '<div class="empty">暂无固定过滤条件</div>'}</div>
        </div>

        <div class="card"><div class="card-bd"><div class="sm muted">
          可用字段：${state.fields.filter((f) => !f.isCustom).map((f) => `<span class="tag">${UI.esc(f.fieldKey)}</span>`).join('')}
          <br/>自定义公式示例：<span class="mono">(amount - cost) / nullif(amount, 0)</span>、<span class="mono">converted_cnt / nullif(lead_cnt, 0)</span>
        </div></div></div>`;

      bind();
    }

    function fieldRow(f, i, dsFields) {
      const isCustom = f.isCustom;
      return `<tr>
        <td><input class="input" style="width:120px" data-i="${i}" data-k="fieldName" value="${UI.esc(f.fieldName)}" /></td>
        <td><input class="input mono" style="width:110px" data-i="${i}" data-k="fieldKey" value="${UI.esc(f.fieldKey)}" /></td>
        <td>${isCustom ? '<span class="tag">自定义公式</span>' : `<select class="input" style="width:170px" data-i="${i}" data-k="datasetFieldKey">${UI.options(dsFields.map((x) => [x.field_key, `${x.field_name}（${x.field_key}）`]), f.datasetFieldKey)}</select>`}</td>
        <td><select class="input" style="width:92px" data-i="${i}" data-k="fieldRole">${UI.options([['dimension', '维度'], ['measure', '度量']], f.fieldRole)}</select></td>
        <td><select class="input" style="width:110px" data-i="${i}" data-k="aggFn">${UI.options(Object.entries(aggLabel).map(([v, t]) => [v, t]), f.aggFn)}</select></td>
        <td style="text-align:center"><input type="checkbox" data-i="${i}" data-k="isGroupBy" ${f.isGroupBy ? 'checked' : ''} /></td>
        <td><select class="input" style="width:88px" data-i="${i}" data-k="sortDir">${UI.options([['none', '默认'], ['asc', '升序'], ['desc', '降序']], f.sortDir)}</select></td>
        <td><select class="input" style="width:92px" data-i="${i}" data-k="fmt">${UI.options([[ '', '默认'], ['number', '整数'], ['currency', '金额'], ['percent', '百分比']], f.fmt || '')}</select></td>
        <td><input class="input mono" style="width:180px" data-i="${i}" data-k="customExpr" value="${UI.esc(f.customExpr)}" ${isCustom ? '' : 'disabled'} placeholder="仅自定义字段" /></td>
        <td><button class="btn-link" data-toggle="${i}">${isCustom ? '转普通' : '转自定义'}</button><button class="btn-link danger" data-del="${i}">删除</button></td>
      </tr>`;
    }

    function filterRow(f, i) {
      const dims = state.fields.filter((x) => !x.isCustom);
      return `<div class="flex gap8 center mb8">
        <select class="input" style="width:180px" data-fi="${i}" data-fk="fieldKey">${UI.options(dims.map((x) => [x.fieldKey, x.fieldName]), f.fieldKey)}</select>
        <select class="input" style="width:130px" data-fi="${i}" data-fk="op">${UI.options(meta.ops, f.op)}</select>
        <input class="input" style="width:180px" data-fi="${i}" data-fk="value" value="${UI.esc(f.value == null ? '' : f.value)}" placeholder="值" />
        <input class="input" style="width:150px" data-fi="${i}" data-fk="value2" value="${UI.esc(f.value2 == null ? '' : f.value2)}" placeholder="区间结束值" />
        <button class="btn-link danger" data-fdel="${i}">删除</button>
      </div>`;
    }

    function syncInputs() {
      container.querySelectorAll('[data-k]').forEach((el) => {
        const f = state.fields[Number(el.dataset.i)];
        if (!f) return;
        const k = el.dataset.k;
        f[k] = el.type === 'checkbox' ? el.checked : el.value;
      });
      container.querySelectorAll('[data-fk]').forEach((el) => {
        const f = state.filters[Number(el.dataset.fi)];
        if (!f) return;
        f[el.dataset.fk] = el.value;
      });
    }

    function commit() { syncInputs(); }

    function bind() {
      container.querySelectorAll('[data-k]').forEach((el) => {
        const handler = () => {
          const idx = Number(el.dataset.i);
          const k = el.dataset.k;
          const f = state.fields[idx];
          f[k] = el.type === 'checkbox' ? el.checked : el.value;
          if (k === 'datasetFieldKey') {
            const df = datasetFields().find((x) => x.field_key === el.value);
            if (df) { f.fieldType = df.field_type; f.fieldRole = df.field_role === 'measure' ? 'measure' : 'dimension'; }
            render();
          }
          if (k === 'fieldRole' || k === 'aggFn') { /* 允许即时改动，保存时生效 */ }
        };
        el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', handler);
      });
      container.querySelectorAll('[data-toggle]').forEach((el) => {
        el.onclick = () => {
          const i = Number(el.dataset.toggle);
          state.fields[i].isCustom = !state.fields[i].isCustom;
          render();
        };
      });
      container.querySelectorAll('[data-del]').forEach((el) => {
        el.onclick = () => { state.fields.splice(Number(el.dataset.del), 1); render(); };
      });
      container.querySelector('#addField').onclick = () => {
        const df = datasetFields()[0];
        state.fields.push({
          fieldKey: 'field_' + (state.fields.length + 1), fieldName: '新字段', fieldType: df ? df.field_type : 'string',
          fieldRole: 'dimension', datasetFieldKey: df ? df.field_key : null, aggFn: 'none', customExpr: '',
          isGroupBy: false, isShow: true, isCustom: false, sortDir: 'none', fmt: ''
        });
        render();
      };
      container.querySelectorAll('[data-fdel]').forEach((el) => {
        el.onclick = () => { syncInputs(); state.filters.splice(Number(el.dataset.fdel), 1); render(); };
      });
      container.querySelector('#addFilter').onclick = () => {
        syncInputs();
        state.filters.push({ fieldKey: state.fields[0] && state.fields[0].fieldKey, op: 'eq', value: '' });
        render();
      };
      container.querySelector('#saveBtn').onclick = () => save(false);
      container.querySelector('#previewBtn').onclick = () => save(true);
      container.querySelector('#dupBtn').onclick = async () => {
        try { const r = await API.post(`/api/report/${state.id}/duplicate`); UI.toast('已复制', 'ok'); loadDef(r.data.id); } catch (e) { UI.toast(e.message, 'err'); }
      };
      container.querySelector('#delBtn').onclick = () => UI.confirmBox('删除报表', '删除后不可恢复，且引用该报表的指标/图表会失效，确定删除？', async () => {
        try { await API.del(`/api/report/${state.id}`); UI.toast('已删除', 'ok'); location.hash = '#/report-design'; location.reload(); } catch (e) { UI.toast(e.message, 'err'); }
      });
    }

    async function save(preview) {
      commit();
      const payload = {
        name: container.querySelector('#fName').value.trim(),
        category: container.querySelector('#fCat').value.trim(),
        description: container.querySelector('#fDesc').value.trim(),
        fields: state.fields.filter((f) => f.fieldKey && f.fieldName),
        filters: state.filters.filter((f) => f.fieldKey && f.op)
      };
      try {
        await API.put('/api/report/' + state.id, payload);
        UI.toast('报表已保存', 'ok');
        if (preview) {
          const def = (await API.get('/api/report/' + state.id)).data;
          const r = await API.post('/api/report/run', { reportId: state.id, size: 10, withTotal: true });
          const d = r.data;
          UI.modal({
            title: `预览：${payload.name}（前 10 行 / 共 ${d.totalRows} 行）`, size: 'xwide',
            body: UI.table(d.columns.map((c) => ({
              key: c.key, name: c.name, align: c.type === 'number' ? 'right' : 'left',
              render: (row) => fmtCell(c, row[c.key])
            })), d.rows) + (d.total ? `<div class="hint mt12">合计行：${d.columns.map((c) => `${c.name}=${fmtCell(c, d.total[c.key])}`).join(' · ')}</div>` : '')
          });
        }
        await loadDef(state.id);
      } catch (e) { UI.toast(e.message, 'err'); }
    }

    await loadDef(state.id);
  }

  window.VIEWS = window.VIEWS || {};
  window.VIEWS['/report'] = { title: '报表中心', render: (c, ctx) => runner(c, ctx, ctx.query.get('id')) };
  window.VIEWS['/report-design'] = { title: '报表设计', render: (c, ctx) => designer(c, ctx, ctx.query.get('id')) };
})();
