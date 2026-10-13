/* 任务管理：定时任务（T+1 指标计算）配置、立即执行、执行日志、调度器状态 */
(function () {
  const state = { meta: null, tasks: [], logs: [], logTaskId: '' };

  const STATUS_TAG = {
    success: '<span class="badge green">成功</span>',
    failed: '<span class="badge red">失败</span>',
    running: '<span class="badge orange">执行中</span>'
  };
  const tagOf = (s) => STATUS_TAG[s] || '<span class="badge gray">未执行</span>';

  async function render(container, ctx) {
    const editable = ctx.can('task:edit');
    const canRun = ctx.can('task:run');
    state.meta = (await API.get('/api/task/meta')).data;
    state.tasks = (await API.get('/api/task/list')).data;
    const sched = (await API.get('/api/task/scheduler/status')).data;

    const on = sched.enabled;
    const enabledCount = state.tasks.filter((t) => t.status === '1').length;
    const totalRuns = state.tasks.reduce((s, t) => s + Number(t.run_count || 0), 0);
    const totalFails = state.tasks.reduce((s, t) => s + Number(t.fail_count || 0), 0);
    const nextRuns = state.tasks.map((t) => t.next_run_at).filter(Boolean).sort();
    const nextSoon = nextRuns[0] || '—';

    container.innerHTML = `
      <div class="grid cols-4 mb16">
        <div class="kpi"><div class="l"><span>调度器</span><span class="badge ${on ? 'green' : 'red'}">${on ? '运行中' : '已停用'}</span></div>
          <div class="v" style="font-size:20px">${on ? '自动调度' : '仅手工'}</div><div class="f"><span>时区 ${UI.esc(sched.timezone || '')}</span></div></div>
        <div class="kpi"><div class="l"><span>任务数</span></div><div class="v" style="font-size:20px">${state.tasks.length}</div>
          <div class="f"><span>启用 ${enabledCount} 个</span></div></div>
        <div class="kpi"><div class="l"><span>累计执行</span></div><div class="v" style="font-size:20px">${UI.num(totalRuns)}</div>
          <div class="f"><span class="${totalFails ? 'down' : ''}">失败 ${UI.num(totalFails)} 次</span></div></div>
        <div class="kpi"><div class="l"><span>最近一次计划执行</span></div><div class="v" style="font-size:16px">${UI.esc(nextSoon)}</div>
          <div class="f"><span>按 Cron 表达式推算</span></div></div>
      </div>

      <div class="card mb16">
        <div class="card-hd">
          <div><div class="t">定时任务</div><div class="d">T+1 指标计算任务，到达计划时间由调度器自动执行；也可随时手工执行</div></div>
          <div class="flex gap8">
            <button class="btn sm" id="refreshBtn">刷新</button>
            ${editable ? '<button class="btn sm primary" id="newBtn">+ 新建任务</button>' : ''}
          </div>
        </div>
        <div class="card-bd" id="taskTable"></div>
      </div>

      <div class="card">
        <div class="card-hd">
          <div><div class="t">执行日志</div><div class="d">最近执行的运行结果与写入条数</div></div>
          <div class="flex gap8 center">
            <select class="input" id="logTask" style="width:180px">${UI.options([['', '全部任务']].concat(state.tasks.map((t) => [t.id, t.name])), state.logTaskId)}</select>
            <select class="input" id="logLimit" style="width:110px">${UI.options([['50', '最近 50 条'], ['100', '最近 100 条'], ['300', '最近 300 条']], '100')}</select>
          </div>
        </div>
        <div class="card-bd" id="logTable"><div class="empty">加载中…</div></div>
      </div>`;

    container.querySelector('#refreshBtn').onclick = () => render(container, ctx);
    const nb = container.querySelector('#newBtn');
    if (nb) nb.onclick = () => form(null, reload);
    container.querySelector('#logTask').onchange = (e) => { state.logTaskId = e.target.value; loadLogs(limit(container)); };
    container.querySelector('#logLimit').onchange = () => loadLogs(limit(container));
    const limit = (c) => c.querySelector('#logLimit').value;

    function reload() { render(container, ctx); }

    function drawTasks() {
      const box = container.querySelector('#taskTable');
      box.innerHTML = UI.table([
        {
          key: 'name', name: '任务', render: (t) => `<div><b>${UI.esc(t.name)}</b></div>
            <div class="sm mono muted">${UI.esc(t.code)}</div>`
        },
        { key: 'task_type', name: '类型', render: (t) => typeLabel(t.task_type) },
        {
          key: 'cron_expr', name: '调度计划', render: (t) => `<div>${UI.esc(t.cron_desc || t.cron_expr)}</div>
            <div class="sm mono muted">${UI.esc(t.cron_expr)}</div>`
        },
        { key: 'date_offset', name: '数据日', align: 'right', render: (t) => 'T-' + Number(t.date_offset || 1) },
        { key: 'target', name: '指标范围', render: (t) => targetLabel(t.target) },
        { key: 'status', name: '状态', render: (t) => (t.status === '1' ? '<span class="badge green">启用</span>' : '<span class="badge gray">停用</span>') },
        {
          key: 'last_run_at', name: '最近执行', render: (t) => (t.last_run_at ? `<div>${UI.esc(UI.dt(t.last_run_at))}</div><div>${tagOf(t.last_status)}</div>` : tagOf(null))
        },
        { key: 'next_run_at', name: '下次执行', render: (t) => (t.next_run_at ? UI.esc(t.next_run_at) : '<span class="muted">—</span>') },
        {
          key: 'run_count', name: '成功/失败', align: 'right',
          render: (t) => `<span class="badge green">${Number(t.run_count || 0) - Number(t.fail_count || 0)}</span> <span class="badge ${Number(t.fail_count) ? 'red' : 'gray'}">${Number(t.fail_count || 0)}</span>`
        },
        {
          key: 'ops', name: '操作', width: 220,
          render: (t) => `<div class="flex gap8">
            ${canRun ? `<button class="btn sm" data-run="${t.id}">立即执行</button>` : ''}
            <button class="btn sm" data-logs="${t.id}">日志</button>
            ${editable ? `<button class="btn sm" data-edit="${t.id}">编辑</button>` : ''}
            ${editable ? `<button class="btn-link danger" data-del="${t.id}">删除</button>` : ''}
          </div>`
        }
      ], state.tasks, {});

      box.querySelectorAll('[data-run]').forEach((el) => {
        el.onclick = async () => {
          el.disabled = true; el.textContent = '执行中…';
          try {
            const r = await API.post('/api/task/' + el.dataset.run + '/run');
            UI.toast(r.message || '执行完成', r.data && r.data.ok ? 'ok' : 'err');
            state.tasks = (await API.get('/api/task/list')).data;
            drawTasks();
            loadLogs(limit(container));
          } catch (e) { UI.toast(e.message, 'err'); el.disabled = false; el.textContent = '立即执行'; }
        };
      });
      box.querySelectorAll('[data-logs]').forEach((el) => {
        el.onclick = () => {
          state.logTaskId = el.dataset.logs;
          container.querySelector('#logTask').value = state.logTaskId;
          loadLogs(limit(container));
          container.querySelector('#logTable').scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
      });
      box.querySelectorAll('[data-edit]').forEach((el) => {
        el.onclick = () => form(state.tasks.find((t) => t.id === Number(el.dataset.edit)), reload);
      });
      box.querySelectorAll('[data-del]').forEach((el) => {
        el.onclick = () => {
          const t = state.tasks.find((x) => x.id === Number(el.dataset.del));
          UI.confirmBox('删除任务', `确定删除任务「${t.name}」？已产生的执行日志会保留。`, async () => {
            try { await API.del('/api/task/' + t.id); UI.toast('已删除', 'ok'); reload(); } catch (e) { UI.toast(e.message, 'err'); }
          });
        };
      });
    }

    const typeLabel = (v) => {
      const t = (state.meta.taskTypes || []).find((x) => (Array.isArray(x) ? x[0] : x.value) === v);
      return UI.esc(t ? (Array.isArray(t) ? t[1] : t.label) : v);
    };
    const targetLabel = (target) => {
      const t = target || {};
      if (t.metricIds && t.metricIds.length) return `<span class="badge">指定 ${t.metricIds.length} 个指标</span>`;
      return '<span class="badge gray">全部启用指标</span>';
    };

    async function loadLogs(lim) {
      const box = container.querySelector('#logTable');
      box.innerHTML = '<div class="empty">加载中…</div>';
      try {
        const r = (await API.get('/api/task/logs', { limit: lim || 100, taskId: state.logTaskId || '' })).data;
        const taskName = (code) => {
          const t = state.tasks.find((x) => x.code === code);
          return t ? t.name : code;
        };
        box.innerHTML = UI.table([
          { key: 'id', name: 'ID', width: 64 },
          { key: 'task_code', name: '任务', render: (l) => `<div>${UI.esc(taskName(l.task_code))}</div><div class="sm mono muted">${UI.esc(l.task_code)}</div>` },
          { key: 'stat_date', name: '数据日' },
          { key: 'start_time', name: '开始时间', width: 170 },
          {
            key: 'duration', name: '耗时', align: 'right',
            render: (l) => {
              if (!l.start_time || !l.end_time) return '-';
              const ms = new Date(l.end_time) - new Date(l.start_time);
              return ms >= 1000 ? (ms / 1000).toFixed(2) + 's' : ms + 'ms';
            }
          },
          { key: 'status', name: '状态', render: (l) => tagOf(l.status) },
          { key: 'trigger_by', name: '触发方式', render: (l) => `<span class="tag">${UI.esc(l.trigger_by || '')}</span>` },
          { key: 'rows_affected', name: '写入', align: 'right', fmt: 'num' },
          { key: 'message', name: '说明', render: (l) => `<div class="sm muted" style="max-width:420px;white-space:normal">${UI.esc(l.message || '')}</div>` }
        ], r, {});
      } catch (e) { box.innerHTML = '<div class="err">' + UI.esc(e.message) + '</div>'; }
    }

    // ---- 新建 / 编辑表单 ----
    function form(task, onDone) {
      const m = state.meta;
      const isNew = !task;
      const cfg = isNew
        ? { name: '', code: '', taskType: 'metric_calc', cronExpr: '0 30 1 * * *', dateOffset: 1, target: { all: true }, status: '1', description: '' }
        : {
          name: task.name, code: task.code, taskType: task.task_type, cronExpr: task.cron_expr,
          dateOffset: task.date_offset == null ? 1 : task.date_offset,
          target: task.target || { all: true }, status: task.status, description: task.description || ''
        };
      const picked = new Set((cfg.target.metricIds || []).map(Number));

      UI.modal({
        title: isNew ? '新建任务' : '编辑任务 · ' + task.name,
        size: 'wide',
        body: `
          <div class="grid cols-3">
            <div class="field"><label>任务名称 *</label><input class="input" id="fName" value="${UI.esc(cfg.name)}" /></div>
            <div class="field"><label>任务编码${isNew ? '（留空自动生成）' : '（不可修改）'}</label><input class="input mono" id="fCode" value="${UI.esc(cfg.code)}" ${isNew ? '' : 'disabled'} /></div>
            <div class="field"><label>任务类型</label><select class="input" id="fType">${UI.options(m.taskTypes, cfg.taskType)}</select></div>
          </div>
          <div class="grid cols-3">
            <div class="field"><label>Cron 表达式（6 段：秒 分 时 日 月 周）</label><input class="input mono" id="fCron" value="${UI.esc(cfg.cronExpr)}" /></div>
            <div class="field"><label>T+N 回算天数</label><input class="input" type="number" min="1" id="fOffset" value="${cfg.dateOffset}" /></div>
            <div class="field"><label>状态</label><select class="input" id="fStatus">${UI.options([['1', '启用'], ['0', '停用']], cfg.status)}</select></div>
          </div>
          <div class="field"><label>常用 Cron 模板</label>
            <div class="flex wrap gap8">${(m.cronExamples || []).map(([v, t]) => `<button type="button" class="btn sm" data-cron="${UI.esc(v)}" data-desc="${UI.esc(t)}"><span class="mono">${UI.esc(v)}</span> · ${UI.esc(t)}</button>`).join('')}</div>
          </div>
          <div class="field"><label>指标范围</label>
            <div class="flex gap16 center mb8">
              <label class="flex center gap8"><input type="radio" name="tgt" value="all" ${cfg.target.metricIds && cfg.target.metricIds.length ? '' : 'checked'} /> 全部启用指标（${(m.metrics || []).length} 个）</label>
              <label class="flex center gap8"><input type="radio" name="tgt" value="pick" ${cfg.target.metricIds && cfg.target.metricIds.length ? 'checked' : ''} /> 指定指标</label>
            </div>
            <div class="tbl-wrap" id="pickBox" style="max-height:240px;overflow:auto;display:${cfg.target.metricIds && cfg.target.metricIds.length ? 'block' : 'none'}">
              <table class="tbl"><thead><tr><th style="width:60px"></th><th>指标</th><th>分组</th><th>统计方式</th><th>日期口径</th></tr></thead>
              <tbody>${(m.metrics || []).map((x) => `<tr>
                <td><input type="checkbox" data-mid="${x.id}" ${picked.has(Number(x.id)) ? 'checked' : ''} /></td>
                <td><div>${UI.esc(x.name)}</div><div class="sm mono muted">${UI.esc(x.code)}</div></td>
                <td>${UI.esc(x.metric_group || '-')}</td><td>${UI.esc(x.agg_fn)}</td><td>${UI.esc(x.date_mode)}</td></tr>`).join('')}</tbody></table>
            </div>
          </div>
          <div class="field"><label>说明</label><input class="input" id="fDesc" value="${UI.esc(cfg.description)}" /></div>
          <div class="hint">任务默认按 <b>T+N</b> 计算：调度触发时计算「今天 - N 天」的数据日（默认 T-1）。执行结果可在执行日志中查看。</div>`,
        buttons: [
          { text: '取消' },
          {
            text: '保存', type: 'primary',
            onClick: async (close, mask) => {
              const q = (s) => mask.querySelector(s);
              const name = q('#fName').value.trim();
              const cronExpr = q('#fCron').value.trim();
              if (!name) return UI.toast('请填写任务名称', 'err');
              if (!cronExpr) return UI.toast('请填写 Cron 表达式', 'err');
              const useAll = q('input[name="tgt"]:checked').value === 'all';
              const target = useAll ? { all: true } : { metricIds: [...mask.querySelectorAll('[data-mid]:checked')].map((el) => Number(el.dataset.mid)) };
              if (!useAll && !target.metricIds.length) return UI.toast('请至少选择一个指标', 'err');
              const body = {
                name, taskType: q('#fType').value, cronExpr,
                dateOffset: Number(q('#fOffset').value || 1), target,
                status: q('#fStatus').value, description: q('#fDesc').value.trim()
              };
              if (isNew) body.code = q('#fCode').value.trim();
              try {
                if (isNew) { const r = await API.post('/api/task', body); UI.toast(r.message || '已创建', 'ok'); }
                else { await API.put('/api/task/' + task.id, body); UI.toast('已保存', 'ok'); }
                close(); onDone();
              } catch (e) { UI.toast(e.message, 'err'); }
            }
          }
        ],
        onOpen: (bd) => {
          bd.querySelectorAll('[data-cron]').forEach((el) => {
            el.onclick = () => { bd.querySelector('#fCron').value = el.dataset.cron; UI.toast('已填入：' + el.dataset.desc); };
          });
          bd.querySelectorAll('input[name="tgt"]').forEach((el) => {
            el.onchange = () => {
              const pick = bd.querySelector('input[name="tgt"]:checked').value === 'pick';
              bd.querySelector('#pickBox').style.display = pick ? 'block' : 'none';
            };
          });
        }
      });
    }

    drawTasks();
    await loadLogs('100');
  }

  window.VIEWS = window.VIEWS || {};
  window.VIEWS['/task'] = { title: '任务管理', render };
})();
