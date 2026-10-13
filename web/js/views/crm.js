/* CRM 录入：客户 / 线索 / 线索池 / 商机 / 合同 / 订单（表驱动 CRUD + 数据范围） */
(function () {
  let OPT = null;
  const cache = {};

  async function options() {
    if (!OPT) OPT = (await API.get('/api/crm/options')).data;
    return OPT;
  }
  async function picklist(kind) {
    cache[kind] = (await API.get('/api/crm/picklist/' + kind)).data;
    return cache[kind];
  }
  const optName = (kind, id) => {
    const list = cache[kind] || [];
    const it = list.find((x) => String(x.id) === String(id));
    return it ? (it.name || it.real_name) : (id || '-');
  };
  const badge = (cls, text) => `<span class="badge ${cls}">${UI.esc(text)}</span>`;
  const statusBadge = (map, v) => {
    const cls = /生效|成交|已完成|已转客户|赢单/.test((map[v] || '')) ? 'green'
      : /作废|流失|无效|退款|已拒绝/.test((map[v] || '')) ? 'red'
        : /待|审批|跟进|新/.test((map[v] || '')) ? 'orange' : 'gray';
    return badge(cls, map[v] || v || '-');
  };
  const mapOf = (list) => { const m = {}; (list || []).forEach((x) => { m[x[0]] = x[1]; }); return m; };

  // 商机阶段进度条（纷享销客风格：阶段链 + 当前赢率）
  const OPP_STAGES = ['初步接洽', '需求确认', '方案报价', '商务谈判', '赢单', '输单'];
  function stageBar(stage) {
    const cur = OPP_STAGES.indexOf(stage);
    if (cur < 0) return badge('gray', stage || '-');
    const done = /输单/.test(stage);
    return `<div class="stage-bar"><div class="cells ${done ? 'bad' : ''}">${OPP_STAGES.slice(0, 5).map((s, i) => `<i class="${done ? 'cur' : i < cur ? 'on' : i === cur ? 'cur' : ''}"></i>`).join('')}</div><div class="stage-name">${UI.esc(stage)}</div></div>`;
  }

  // ---------------------------------------------------------------- 实体配置
  const ENTITIES = {
    customer: {
      label: '客户', perm: 'customer',
      columns: [
        { key: 'cust_no', name: '客户编号', width: 110 },
        { key: 'name', name: '客户名称' },
        { key: 'industry', name: '行业' }, { key: 'region', name: '区域' },
        { key: 'level', name: '等级', width: 60 },
        { key: 'status', name: '状态', render: (r) => statusBadge(mapOf(OPT.customerStatus), r.status) },
        { key: 'source', name: '来源' },
        { key: 'credit_limit', name: '授信额度', align: 'right', fmt: 'money' },
        { key: 'owner_name', name: '归属销售' },
        { key: 'created_at', name: '创建时间', fmt: 'dt', width: 150 }
      ],
      filters: [['industry', '行业', 'industry'], ['region', '区域', 'region'], ['level', '等级', 'level'], ['source', '来源', 'source'], ['status', '状态', 'customerStatus']],
      form: [
        ['name', '客户名称', 'text', true],
        ['industry', '所属行业', 'select', false, 'industry'],
        ['region', '所属区域', 'select', false, 'region'],
        ['level', '客户等级', 'select', false, 'level'],
        ['source', '客户来源', 'select', false, 'source'],
        ['status', '客户状态', 'select', false, 'customerStatus'],
        ['credit_limit', '授信额度', 'number'],
        ['phone', '联系电话', 'text'],
        ['email', '邮箱', 'text'],
        ['address', '地址', 'text'],
        ['remark', '备注', 'textarea']
      ],
      stats: [['total', '客户总数', 'num'], ['active', '成交客户', 'num'], ['top', 'A 类客户', 'num'], ['amount', '授信总额', 'money']],
      rowActions: [['360', '客户360'], ['follow', '写跟进'], ['release', '退回公海']]
    },
    lead: {
      label: '线索', perm: 'lead',
      columns: [
        { key: 'lead_no', name: '线索编号', width: 110 },
        { key: 'name', name: '联系人' }, { key: 'company', name: '公司名称' },
        { key: 'source', name: '来源' }, { key: 'region', name: '区域' },
        { key: 'stage', name: '阶段', render: (r) => statusBadge(mapOf(OPT.leadStage), r.stage) },
        { key: 'intent_level', name: '意向', width: 60 },
        { key: 'est_amount', name: '预估金额', align: 'right', fmt: 'money' },
        { key: 'pool_name', name: '线索池', render: (r) => UI.esc(r.pool_name || '-') },
        { key: 'owner_name', name: '归属', render: (r) => r.in_pool ? badge('orange', '待领取') : UI.esc(r.owner_name || '-') },
        { key: 'created_at', name: '创建时间', fmt: 'dt', width: 150 }
      ],
      filters: [['source', '来源', 'source'], ['stage', '阶段', 'leadStage'], ['intent_level', '意向', 'intentLevel'], ['region', '区域', 'region'], ['industry', '行业', 'industry']],
      form: [
        ['name', '联系人', 'text', true],
        ['company', '公司名称', 'text'],
        ['phone', '联系电话', 'text'],
        ['wechat', '微信', 'text'],
        ['industry', '所属行业', 'select', false, 'industry'],
        ['region', '所属区域', 'select', false, 'region'],
        ['source', '线索来源', 'select', false, 'source'],
        ['stage', '线索阶段', 'select', false, 'leadStage'],
        ['intent_level', '意向级别', 'select', false, 'intentLevel'],
        ['est_amount', '预估金额', 'number'],
        ['pool_id', '所属线索池', 'select', false, 'pool']
      ],
      stats: [['total', '线索总数', 'num'], ['in_pool', '池中待领取', 'num'], ['converted', '已转化', 'num'], ['amount', '预估金额合计', 'money']],
      rowActions: [['claim', '领取'], ['assign', '分配'], ['convert', '转客户'], ['follow', '写跟进']]
    },
    leadPool: {
      label: '线索池', perm: 'lead',
      columns: [
        { key: 'code', name: '池编码', width: 140 }, { key: 'name', name: '线索池名称' },
        { key: 'description', name: '说明' },
        { key: 'lead_count', name: '池中线索', align: 'right' },
        { key: 'new_count', name: '待跟进', align: 'right' },
        { key: 'capacity', name: '容量', align: 'right' },
        { key: 'owner_name', name: '负责人' }
      ],
      filters: [],
      form: [['name', '线索池名称', 'text', true], ['description', '说明', 'text'], ['capacity', '容量', 'number']],
      stats: [],
      rowActions: []
    },
    opportunity: {
      label: '商机', perm: 'opp',
      columns: [
        { key: 'opp_no', name: '商机编号', width: 110 }, { key: 'name', name: '商机名称' },
        { key: 'customer_name', name: '客户' },
        { key: 'stage', name: '阶段', render: (r) => stageBar(r.stage) },
        { key: 'est_amount', name: '预计金额', align: 'right', fmt: 'money' },
        { key: 'win_rate', name: '赢单率', align: 'right', render: (r) => (r.win_rate || 0) + '%' },
        { key: 'expect_date', name: '预计成交', fmt: 'date' },
        { key: 'owner_name', name: '归属销售' }
      ],
      filters: [['stage', '阶段', 'oppStage']],
      form: [
        ['name', '商机名称', 'text', true],
        ['customer_id', '客户', 'select', false, 'customer'],
        ['stage', '阶段', 'select', false, 'oppStage'],
        ['est_amount', '预计金额', 'number'],
        ['win_rate', '赢单率(%)', 'number'],
        ['expect_date', '预计成交日期', 'date'],
        ['owner_id', '归属销售', 'select', false, 'owner']
      ],
      stats: [['total', '商机总数', 'num'], ['won', '已赢单', 'num'], ['amount', '预计金额合计', 'money'], ['win_rate', '平均赢单率', 'rate']],
      rowActions: [['advance', '推进阶段'], ['follow', '写跟进']]
    },
    contract: {
      label: '合同', perm: 'contract',
      columns: [
        { key: 'contract_no', name: '合同编号', width: 130 }, { key: 'name', name: '合同名称' },
        { key: 'customer_name', name: '客户' }, { key: 'region', name: '区域' },
        { key: 'amount', name: '合同金额', align: 'right', fmt: 'money' },
        { key: 'cost', name: '成本', align: 'right', fmt: 'money' },
        { key: 'sign_date', name: '签约日期', fmt: 'date' },
        { key: 'status', name: '状态', render: (r) => statusBadge(mapOf(OPT.contractStatus), r.status) },
        { key: 'pay_type', name: '付款方式' }, { key: 'owner_name', name: '签约人' }
      ],
      filters: [['status', '状态', 'contractStatus'], ['pay_type', '付款方式', 'payType']],
      form: [
        ['name', '合同名称', 'text', true],
        ['customer_id', '客户', 'select', false, 'customer'],
        ['amount', '合同金额', 'number', true],
        ['cost', '合同成本', 'number'],
        ['tax_rate', '税率(如 0.06)', 'number'],
        ['sign_date', '签约日期', 'date', true],
        ['start_date', '生效日期', 'date'],
        ['end_date', '到期日期', 'date'],
        ['status', '合同状态', 'select', false, 'contractStatus'],
        ['pay_type', '付款方式', 'select', false, 'payType'],
        ['owner_id', '签约人', 'select', false, 'owner']
      ],
      stats: [['total', '合同总数', 'num'], ['active', '生效中', 'num'], ['amount', '合同总额', 'money'], ['profit', '毛利合计', 'money']],
      rowActions: []
    },
    order: {
      label: '订单', perm: 'order',
      columns: [
        { key: 'order_no', name: '订单编号', width: 130 }, { key: 'customer_name', name: '客户' },
        { key: 'product', name: '产品线' }, { key: 'quantity', name: '数量', align: 'right' },
        { key: 'amount', name: '订单金额', align: 'right', fmt: 'money' },
        { key: 'status', name: '状态', render: (r) => statusBadge(mapOf(OPT.orderStatus), r.status) },
        { key: 'paid_amount', name: '累计回款', align: 'right', fmt: 'money', render: (r) => UI.money(r.paid_amount) },
        { key: 'order_date', name: '下单日期', fmt: 'date' },
        { key: 'pay_date', name: '付款日期', fmt: 'date' },
        { key: 'owner_name', name: '归属销售' }
      ],
      filters: [['status', '状态', 'orderStatus'], ['product', '产品线', 'product']],
      form: [
        ['order_no', '订单编号（留空自动生成）', 'text'],
        ['customer_id', '客户', 'select', false, 'customer'],
        ['contract_id', '关联合同', 'select', false, 'contract'],
        ['product', '产品线', 'select', false, 'product'],
        ['quantity', '数量', 'number'],
        ['amount', '订单金额', 'number', true],
        ['cost', '订单成本', 'number'],
        ['discount', '折扣(如 0.05)', 'number'],
        ['status', '订单状态', 'select', false, 'orderStatus'],
        ['order_date', '下单日期', 'date', true],
        ['pay_date', '付款日期', 'date']
      ],
      stats: [['total', '订单总数', 'num'], ['pending', '待付款', 'num'], ['amount', '订单总额', 'money'], ['quantity', '产品数量', 'num']],
      rowActions: [['payment', '登记回款']]
    }
  };

  const PATH2ENT = { '/customer': 'customer', '/lead': 'lead', '/leadpool': 'leadPool', '/opportunity': 'opportunity', '/contract': 'contract', '/order': 'order' };

  // ---------------------------------------------------------------- 表单
  function buildForm(conf, row, opt) {
    const wrap = document.createElement('div');
    wrap.className = 'grid cols-2';
    conf.form.forEach(([key, label, type, req, src]) => {
      const v = row && row[key] !== null && row[key] !== undefined ? row[key] : '';
      let inner;
      if (type === 'select') {
        let list;
        if (src === 'customer' || src === 'contract' || src === 'pool' || src === 'owner') {
          list = (cache[src] || []).map((x) => [x.id, src === 'owner' ? `${x.name}（${x.dept || ''}）` : (x.name + (x.cust_no ? ' / ' + x.cust_no : ''))]);
        } else {
          list = opt[src] || [];
        }
        inner = `<select class="input" name="${key}">${UI.options(list, v, '请选择')}</select>`;
      } else if (type === 'textarea') {
        inner = `<textarea class="input" name="${key}">${UI.esc(v)}</textarea>`;
      } else if (type === 'date') {
        inner = `<input class="input" type="date" name="${key}" value="${UI.esc(String(v).slice(0, 10))}" />`;
      } else {
        inner = `<input class="input" type="${type === 'number' ? 'number' : 'text'}" ${type === 'number' ? 'min="0" step="any"' : ''} name="${key}" value="${UI.esc(v)}" ${req ? 'required' : ''} />`;
      }
      wrap.innerHTML += `<div class="field"><label>${UI.esc(label)}${req ? '<span class="req">*</span>' : ''}</label>${inner}</div>`;
    });
    return wrap;
  }

  function collect(formEl) {
    const body = {};
    formEl.querySelectorAll('input,select,textarea').forEach((el) => {
      const k = el.name;
      if (!k) return;
      body[k] = el.value === '' ? null : el.value;
    });
    return body;
  }

  // ---------------------------------------------------------------- 页面
  async function page(container, ctx, entKey) {
    const conf = ENTITIES[entKey];
    const entity = entKey;
    const opt = await options();
    const sources = [...new Set(conf.form.map((f) => f[4]).filter((s) => ['customer', 'contract', 'pool', 'owner'].includes(s)))];
    if (entKey === 'lead') sources.push('owner');
    await Promise.all(sources.map(picklist));

    const state = { page: 1, size: 20, keyword: '', filters: {}, sortBy: '', sortDir: 'desc', mode: 'list' };
    const descriptions = { customer: '围绕每一位客户，连接联系人、商机与跟进记录。', lead: '从发现需求到建立关系，让每一条线索都有下一步。', leadPool: '集中管理线索，及时领取并持续跟进。', opportunity: '看清成交路径，把每一次跟进推进到下一阶段。', contract: '集中查看签约、履约与合同金额。', order: '订单与回款同步管理，掌握每一笔收入。' };

    container.innerHTML = `
      <div class="page-intro"><div><span class="eyebrow">SALES WORKSPACE / 销售工作台</span><h1>${UI.esc(conf.label)}${entKey === 'order' ? '与回款' : '管理'}</h1><p>${descriptions[entKey]}</p></div><span class="intro-mark" aria-hidden="true">${{customer:'◎',lead:'✦',leadPool:'◈',opportunity:'↗',contract:'▤',order:'◷'}[entKey]}</span></div>
      <div class="card mb16">
        <div class="card-bd">
          <div class="flex wrap gap8 center">
            <input class="input" id="kw" placeholder="搜索 ${UI.esc(conf.label)}..." style="max-width:260px" />
            ${conf.filters.map(([f, label, src]) => `<select class="input" data-f="${f}" style="max-width:150px"><option value="">${UI.esc(label)}（全部）</option>${UI.options(opt[src] || [])}</select>`).join('')}
            <button class="btn primary" id="searchBtn">查询</button>
            <button class="btn" id="resetBtn">重置</button>
            <div style="flex:1"></div>
            ${ctx.can(conf.perm + ':add') ? `<button class="btn primary" id="addBtn">+ 新增${UI.esc(conf.label)}</button>` : ''}
          </div>
        </div>
      </div>
      <div class="stat-strip mb16" id="stats"></div>
      <div class="card">
        <div class="card-hd"><div><div class="t">${UI.esc(conf.label)}列表</div><div class="d" id="listTip"></div></div>${entKey === 'opportunity' ? '<div class="view-toggle"><button class="btn sm active" data-mode="list">列表</button><button class="btn sm" data-mode="board">阶段看板</button></div>' : ''}</div>
        <div class="card-bd np"><div id="tbl"></div></div>
      </div>`;

    const params = () => {
      const p = { page: state.page, size: state.size };
      if (state.keyword) p.keyword = state.keyword;
      Object.entries(state.filters).forEach(([k, v]) => { if (v) p['f.' + k] = v; });
      if (state.sortBy) { p.sortBy = state.sortBy; p.sortDir = state.sortDir; }
      return p;
    };

    async function load() {
      const board = state.mode === 'board' ? (await API.get('/api/crm/opportunity-board', {keyword:state.keyword,stage:state.filters.stage})).data : null;
      const d = board ? {rows:board.lanes.flatMap(l=>l.rows || []),total:board.total} : (await API.get('/api/crm/' + entity, params())).data;
      const cols = [...conf.columns];
      const extra = [];
      if (ctx.can(conf.perm + ':edit')) extra.push('edit');
      if (ctx.can(conf.perm + ':delete')) extra.push('del');
      const rowActs = (conf.rowActions || []).slice();
      if (extra.length || rowActs.length) {
        cols.push({
          key: '_act', name: '操作', width: 200,
          render: (row) => [
            ...rowActs.filter(([a]) => {
              if (a === 'claim') return row.in_pool && ctx.can('lead:claim');
              if (a === 'assign') return ctx.can('lead:assign');
              if (a === 'convert') return !row.in_pool && !row.customer_id && ctx.can('lead:edit');
              if (a === 'advance') return ctx.can('opp:edit') && !['赢单', '输单'].includes(row.stage);
              if (a === 'payment') return (ctx.can('payment:add') || ctx.can('order:edit')) && row.status !== 'refund' && Number(row.paid_amount) < Number(row.amount);
              if (a === 'follow') return ctx.can('follow:add') && !(entity === 'lead' && row.in_pool);
              if (a === 'release') return ctx.can('customer-pool:release') && row.owner_id && row.status === 'potential';
              return true;
            }).map(([a, t]) => `<button class="btn-link" data-a="${a}" data-id="${row.id}">${t}</button>`),
            ...(extra.includes('edit') && !(entity === 'lead' && row.in_pool && ctx.me.role !== 'admin') ? [`<button class="btn-link" data-a="edit" data-id="${row.id}">编辑</button>`] : []),
            ...(extra.includes('del') ? [`<button class="btn-link danger" data-a="del" data-id="${row.id}">删除</button>`] : [])
          ].join('')
        });
      }
      container.querySelector('#tbl').innerHTML = state.mode === 'board' ? `<div class="kanban">${OPP_STAGES.map((stage, i) => {
        const rows = d.rows.filter((row) => row.stage === stage);
        const lane = board.lanes.find(l=>l.stage===stage) || {count:0,amount:0,overdue:0};
        return `<section class="kanban-column tone-${i}"><div class="kanban-heading"><b>${stage}</b><span>${lane.count}</span></div><div class="kanban-total">阶段总金额 ¥${UI.money(lane.amount)}${lane.overdue ? ' · 逾期 '+lane.overdue+' 个' : ''}</div>${rows.length ? rows.map((row) => `<article class="deal-card"><span class="sm muted">${UI.esc(row.opp_no)}</span><h3>${UI.esc(row.name)}</h3><p>${UI.esc(row.customer_name || '未关联客户')}</p><strong>¥${UI.money(row.est_amount)}</strong><div class="deal-meta"><span>${UI.esc(row.owner_name || '未分配')}</span><span>赢率 ${Number(row.win_rate) || 0}%</span></div><div class="sm muted mb8">预计成交 ${UI.date(row.expect_date)}</div>${ctx.can('opp:edit') && i < 4 ? `<button class="btn sm" data-a="advance" data-id="${row.id}">推进阶段 ↗</button>` : ''}${ctx.can('follow:add') ? `<button class="btn-link" data-a="follow" data-id="${row.id}">写跟进</button>` : ''}</article>`).join('') : '<div class="board-empty">该阶段暂无商机</div>'}</section>`;
      }).join('')}</div>` : UI.table(cols, d.rows);
      container.querySelector('#listTip').textContent = `共 ${d.total} 条${state.mode === 'board' ? ' · 按全部筛选结果汇总，每阶段优先展示最早预计成交的 10 条' : ''} · 数据范围：${ctx.me.dataScope === 'all' ? '全部数据' : ctx.me.dataScope === 'dept' ? '本部门（' + ctx.me.dept + '）' : '仅本人'}`;
      const pg = UI.pager(d.total, state.page, state.size, (p) => { state.page = p; load(); });
      const old = container.querySelector('.pager');
      if (old) old.remove();
      if(state.mode === 'list') container.querySelector('#tbl').appendChild(pg);
      bindRowActions(d.rows);
    }

    async function loadStats() {
      if (!conf.stats.length) { container.querySelector('#stats').innerHTML = ''; return; }
      const r = await API.get(`/api/crm/${entity}/summary/stats`);
      const d = r.data || {};
      container.querySelector('#stats').innerHTML = conf.stats.map(([k, label, fmt]) => `
        <div class="stat-chip"><div class="l">${UI.esc(label)}</div><div class="v">${fmt === 'money' ? UI.money(d[k]) : UI.num(d[k]) + (fmt === 'rate' ? '%' : '')}</div></div>`).join('');
    }

    function bindRowActions(rows) {
      container.querySelectorAll('#tbl [data-a]').forEach((btn) => {
        btn.onclick = async () => {
          const id = Number(btn.dataset.id);
          const row = rows.find((x) => x.id === id) || { id };
          const act = btn.dataset.a;
          if (act === 'edit') return openForm(row);
          if (act === 'del') return UI.confirmBox('删除确认', `确定删除这条${conf.label}记录吗？此操作不可恢复。`, async () => {
            try { await API.del(`/api/crm/${entity}/${id}`); UI.toast('已删除', 'ok'); load(); loadStats(); } catch (e) { UI.toast(e.message, 'err'); }
          });
          if (act === '360') return show360(id);
          if (act === 'follow') return openFollow(row);
          if (act === 'release') return UI.confirmBox('退回公海', `将「${row.name}」退回公海供其他销售领取？`, () => post(`/api/crm/customer-pool/${id}/release`, {}, '已退回公海'));
          if (act === 'advance') return UI.confirmBox('推进商机', `将把「${row.name || ''}」推进到下一阶段并自动评估赢率，确定继续？`, async () => {
            try { const r = await API.post(`/api/crm/opp/${id}/advance`); UI.toast(r.message, 'ok'); load(); loadStats(); } catch (e) { UI.toast(e.message, 'err'); }
          });
          if (act === 'payment') return openPayment(row);
          if (act === 'claim') return post(`/api/crm/lead/${id}/claim`, {}, '领取成功');
          if (act === 'convert') return UI.confirmBox('线索转客户', '将根据线索信息自动创建客户档案，确定继续？', () => post(`/api/crm/lead/${id}/convert`, {}, '转化成功'));
          if (act === 'assign') {
            const owners = cache.owner || [];
            return UI.modal({
              title: '分配线索给销售',
              body: `<div class="field"><label>目标销售</label><select class="input" id="assignOwner">${UI.options(owners.map((o) => [o.id, `${o.name}（${o.dept || ''}）`]), '', '请选择')}</select></div>`,
              buttons: [{ text: '取消' }, {
                text: '确定分配', type: 'primary', onClick: (close, mask) => {
                  const ownerId = Number(mask.querySelector('#assignOwner').value);
                  if (!ownerId) return UI.toast('请选择销售', 'err');
                  close(); post(`/api/crm/lead/${id}/assign`, { ownerId }, '分配成功');
                }
              }]
            });
          }
        };
      });
      // 表头排序
      container.querySelectorAll('#tbl th').forEach((th, i) => {
        const col = [...conf.columns][i];
        if (!col || !ENTITIES[entity].columns.find((c) => c.key === col.key)) return;
      });
    }

    async function post(url, body, tip) {
      try { const r = await API.post(url, body); UI.toast(r.message || tip, 'ok'); load(); loadStats(); }
      catch (e) { UI.toast(e.message, 'err'); }
    }

    function openForm(row) {
      const defaults = { customer: { status: 'potential', level: 'B' }, lead: { stage: 'new', intent_level: '中' }, opportunity: { stage: '初步接洽', win_rate: 15, owner_id: ctx.me.id }, contract: { status: 'draft', owner_id: ctx.me.id }, order: { status: 'pending', quantity: 1 } };
      const form = buildForm(conf, row || defaults[entity] || {}, opt);
      UI.modal({
        title: row && row.id ? `编辑${conf.label}` : `新增${conf.label}`,
        size: 'wide',
        body: form,
        buttons: [
          { text: '取消' },
          {
            text: '保存', type: 'primary', onClick: async (close) => {
              const body = collect(form);
              const invalid = [...form.querySelectorAll('input, select, textarea')].find((el) => !el.checkValidity());
              if (invalid) { invalid.reportValidity(); return; }
              const reqMissing = conf.form.some(([k, l, t, req]) => req && (body[k] === null || body[k] === ''));
              if (reqMissing) return UI.toast('请填写必填项（带 * 的字段）', 'err');
              try {
                if (row && row.id) await API.put(`/api/crm/${entity}/${row.id}`, body);
                else await API.post(`/api/crm/${entity}`, body);
                close(); UI.toast('保存成功', 'ok'); load(); loadStats();
              } catch (e) { UI.toast(e.message, 'err'); }
            }
          }
        ]
      });
    }

    function openFollow(row) {
      UI.modal({ title: `记录跟进 · ${row.name || row.company || ''}`, body: `<div class="grid cols-2"><div class="field"><label>跟进方式</label><select name="way" class="input">${UI.options(opt.followWay, '电话')}</select></div><div class="field"><label>跟进结果</label><select name="result" class="input">${UI.options(opt.followResult, '需跟进')}</select></div></div><div class="field"><label>跟进内容 <span class="req">*</span></label><textarea class="input" name="content" maxlength="500" placeholder="记录客户需求、沟通结果和下一步行动"></textarea></div><div class="field"><label>下次跟进时间</label><input type="datetime-local" name="next_time" class="input" /></div>`, buttons: [{ text: '取消' }, { text: '保存跟进', type: 'primary', onClick: async (close, mask) => {
        const body = collect(mask); body.biz_type = entity; body.biz_id = row.id;
        if (!String(body.content || '').trim()) return UI.toast('请填写跟进内容', 'err');
        await API.post('/api/crm/followUp', body); close(); UI.toast('跟进已记录', 'ok');
      } }] });
    }

    async function openPayment(row) {
      const today = new Date().toISOString().slice(0, 10);
      const paymentDialog = UI.modal({
        title: `登记回款 · ${row.order_no}`,
        body: `
          <div class="sm muted mb12">订单金额 ${UI.money(row.amount)} · 客户 ${UI.esc(row.customer_name || '-')} · 已回款 ${UI.money(row.paid_amount || 0)}</div>
          <div class="grid cols-2">
            <div class="field"><label>回款金额</label><input class="input" id="payAmount" type="number" min="0.01" value="" required /></div>
            <div class="field"><label>回款日期</label><input class="input" id="payDate" type="date" value="${today}" required /></div>
            <div class="field"><label>收款方式</label><select class="input" id="payMethod">${UI.options([['对公转账', '对公转账'], ['银行转账', '银行转账'], ['支票', '支票'], ['现金', '现金']], '对公转账')}</select></div>
            <div class="field"><label>备注</label><input class="input" id="payRemark" /></div>
          </div>
          <div class="field"><label>回款记录</label>
            <div id="payList" class="sm muted">加载中…</div>
          </div>`,
        buttons: [{ text: '取消' }, {
          text: '保存回款', type: 'primary', onClick: async (close, mask) => {
            const amount = Number(mask.querySelector('#payAmount').value);
            const payDate = mask.querySelector('#payDate').value;
            const method = mask.querySelector('#payMethod').value;
            const remark = mask.querySelector('#payRemark').value;
            if (!amount || amount <= 0) return UI.toast('请填写有效的回款金额', 'err');
            if (!payDate) return UI.toast('请选择回款日期', 'err');
            try {
              const r = await API.post('/api/crm/payment', { orderId: row.id, amount, payDate, method, remark });
              close(); UI.toast(r.message, 'ok'); load(); loadStats();
            } catch (e) { UI.toast(e.message, 'err'); }
          }
        }]
      });
      try {
        const r = await API.get(`/api/crm/payment?orderId=${row.id}`);
        const list = paymentDialog.body.querySelector('#payList');
        if (!paymentDialog.el.isConnected) return;
        if (!r.data.rows.length) list.innerHTML = '<div class="empty">暂无回款记录</div>';
        else list.innerHTML = r.data.rows.map((x) => `
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
            <span>${UI.date(x.pay_date)} · ${UI.esc(x.method || '-')}</span><b>${UI.money(x.amount)}</b>
          </div>`).join('');
      } catch (e) { if (paymentDialog.el.isConnected) paymentDialog.body.querySelector('#payList').textContent = '回款记录加载失败：' + e.message; }
    }

    async function show360(id) {
      const r = await API.get(`/api/crm/customer/${id}/360`);
      const d = r.data;
      const c = d.customer;
      const tbl = (cols, rows) => rows.length ? UI.table(cols, rows) : '<div class="empty">暂无记录</div>';
      UI.modal({
        title: `客户 360 · ${c.name}（${c.cust_no}）`,
        size: 'xwide',
        body: `
          <div class="stat-strip mb16">
            <div class="stat-chip"><div class="l">累计签约金额</div><div class="v">${UI.money(d.summary.contractAmount)}</div></div>
            <div class="stat-chip"><div class="l">合同数</div><div class="v">${d.summary.contractCnt}</div></div>
            <div class="stat-chip"><div class="l">订单金额</div><div class="v">${UI.money(d.summary.orderAmount)}</div></div>
            <div class="stat-chip"><div class="l">订单数</div><div class="v">${d.summary.orderCnt}</div></div>
            <div class="stat-chip"><div class="l">行业 / 区域</div><div class="v" style="font-size:14px">${UI.esc(c.industry || '-')} / ${UI.esc(c.region || '-')}</div></div>
          </div>
          <div class="mb12"><b>基本信息</b><div class="sm muted mt8">归属销售：${UI.esc(c.owner_name || '-')} · 等级：${UI.esc(c.level || '-')} · 来源：${UI.esc(c.source || '-')} · 电话：${UI.esc(c.phone || '-')} · 创建：${UI.dt(c.created_at)}</div></div>
          <div class="mt16"><b>联系人（${d.contacts.length}）</b></div>
          ${tbl([{ key: 'name', name: '姓名' }, { key: 'position', name: '职位' }, { key: 'phone', name: '电话' }, { key: 'is_primary', name: '主联系人', render: (x) => x.is_primary ? '是' : '否' }], d.contacts)}
          <div class="mt16"><b>合同（${d.contracts.length}）</b></div>
          ${tbl([{ key: 'contract_no', name: '合同编号' }, { key: 'name', name: '合同名称' }, { key: 'amount', name: '金额', align: 'right', fmt: 'money' }, { key: 'sign_date', name: '签约日期', fmt: 'date' }, { key: 'status', name: '状态' }], d.contracts)}
          <div class="mt16"><b>订单（${d.orders.length}）</b></div>
          ${tbl([{ key: 'order_no', name: '订单编号' }, { key: 'product', name: '产品线' }, { key: 'amount', name: '金额', align: 'right', fmt: 'money' }, { key: 'order_date', name: '下单日期', fmt: 'date' }, { key: 'status', name: '状态' }], d.orders)}
          <div class="mt16"><b>商机（${d.opportunities.length}）</b></div>
          ${tbl([{ key: 'opp_no', name: '商机编号' }, { key: 'name', name: '商机名称' }, { key: 'est_amount', name: '预计金额', align: 'right', fmt: 'money' }, { key: 'stage', name: '阶段' }], d.opportunities)}
          <div class="mt16"><b>客户跟进时间轴（最近 ${(d.follows || []).length} 条）</b></div><div class="timeline">${(d.follows || []).length ? d.follows.map((f) => `<article class="timeline-item"><div><span class="badge purple">${UI.esc(f.way || '跟进')}</span> <b>${UI.esc(f.owner_name || '-')}</b><span class="sm muted"> · ${UI.dt(f.created_at)}</span></div><p>${UI.esc(f.content)}</p><div class="sm muted">${UI.esc(f.result || '')}${f.next_time ? ' · 下次跟进 ' + UI.dt(f.next_time) : ''}</div></article>`).join('') : '<div class="empty">暂无跟进记录，可从客户列表点击「写跟进」。</div>'}</div>`
      });
    }

    container.querySelector('#kw').value = '';
    container.querySelector('#kw').onkeydown = (e) => { if (e.key === 'Enter') { state.keyword = e.target.value.trim(); state.page = 1; load(); } };
    container.querySelector('#searchBtn').onclick = () => { state.keyword = container.querySelector('#kw').value.trim(); state.page = 1; load(); };
    container.querySelector('#resetBtn').onclick = () => {
      container.querySelector('#kw').value = ''; state.keyword = ''; state.filters = {}; state.page = 1;
      container.querySelectorAll('[data-f]').forEach((el) => { el.value = ''; });
      load();
    };
    container.querySelectorAll('[data-f]').forEach((el) => {
      el.onchange = () => { state.filters[el.dataset.f] = el.value; state.page = 1; load(); };
    });
    const addBtn = container.querySelector('#addBtn');
    if (addBtn) addBtn.onclick = () => openForm(null);
    container.querySelectorAll('[data-mode]').forEach((btn) => { btn.onclick = () => { state.mode = btn.dataset.mode; container.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn)); load().catch((e) => UI.toast(e.message, 'err')); }; });

    await load();
    await loadStats();
  }

  // ---------------------------------------------------------------- 客户公海（参考纷享销客：潜在无归属客户，可领取 / 退回）
  async function poolPage(container, ctx) {
    const opt = await options();
    const state = { page: 1, size: 20, keyword: '', filters: {} };
    const statusCls = (v) => mapOf(opt.customerStatus);

    container.innerHTML = `
      <div class="card mb16"><div class="card-bd">
        <div class="flex wrap gap8 center">
          <input class="input" id="kw" placeholder="搜索公海客户..." style="max-width:260px" />
          <select class="input" data-f="industry" style="max-width:140px"><option value="">行业（全部）</option>${UI.options(opt.industry || [])}</select>
          <select class="input" data-f="region" style="max-width:140px"><option value="">区域（全部）</option>${UI.options(opt.region || [])}</select>
          <button class="btn primary" id="searchBtn">查询</button><button class="btn" id="resetBtn">重置</button>
          <div style="flex:1"></div>
          <span class="badge badge green" id="poolTip">-</span>
        </div>
      </div></div>
      <div class="stat-strip mb16" id="stats"></div>
      <div class="card"><div class="card-hd"><div class="t">公海客户</div><div class="d">潜在客户且无归属，可领取后归入名下跟进；不跟进可退回公海。</div></div>
        <div class="card-bd np"><div id="tbl"></div></div></div>`;

    async function load() {
      const p = { page: state.page, size: state.size };
      if (state.keyword) p.keyword = state.keyword;
      Object.entries(state.filters).forEach(([k, v]) => { if (v) p['f.' + k] = v; });
      const r = await API.get('/api/crm/customer-pool', p);
      const d = r.data;
      const m = mapOf(opt.customerStatus);
      container.querySelector('#stats').innerHTML = `
        <div class="stat-chip"><div class="l">公海客户</div><div class="v">${UI.num(d.stat.total)}</div></div>
        <div class="stat-chip"><div class="l">已领取（有归属）</div><div class="v">${UI.num(d.stat.claimed)}</div></div>
        <div class="stat-chip"><div class="l">公海授信合计</div><div class="v">${UI.money(d.stat.pool_credit)}</div></div>`;
      container.querySelector('#poolTip').textContent = `共 ${d.total} 位公海客户`;
      const cols = [
        { key: 'cust_no', name: '客户编号', width: 110 },
        { key: 'name', name: '客户名称' },
        { key: 'industry', name: '行业' }, { key: 'region', name: '区域' },
        { key: 'level', name: '等级', width: 60 },
        { key: 'source', name: '来源' },
        { key: 'credit_limit', name: '授信额度', align: 'right', fmt: 'money' },
        { key: 'status', name: '状态', render: (x) => statusBadge(m, x.status) }
      ];
      const canClaim = ctx.can('customer:edit') || ctx.can('customer-pool:claim');
      if (canClaim) cols.push({ key: '_act', name: '操作', width: 110, render: () => `<button class="btn-link" data-a="claim">领取</button>` });
      container.querySelector('#tbl').innerHTML = UI.table(cols, d.rows, { onSort: () => {} });
      // 按行序绑定客户 id
      const btns = container.querySelectorAll('#tbl [data-a="claim"]');
      d.rows.forEach((row, i) => {
        if (btns[i]) {
          btns[i].onclick = () => UI.confirmBox('领取客户', `领取「${row.name}」（${row.cust_no}）后归入你名下，保留潜在客户状态，确定？`, async () => {
            try { const r = await API.post(`/api/crm/customer-pool/${row.id}/claim`); UI.toast(r.message, 'ok'); load(); } catch (e) { UI.toast(e.message, 'err'); }
          });
        }
      });
      const pg = UI.pager(d.total, state.page, state.size, (pgn) => { state.page = pgn; load(); });
      const old = container.querySelector('.pager'); if (old) old.remove();
      container.querySelector('#tbl').appendChild(pg);
    }

    container.querySelector('#kw').onkeydown = (e) => { if (e.key === 'Enter') { state.keyword = e.target.value.trim(); state.page = 1; load(); } };
    container.querySelector('#searchBtn').onclick = () => { state.keyword = container.querySelector('#kw').value.trim(); state.page = 1; load(); };
    container.querySelector('#resetBtn').onclick = () => { container.querySelector('#kw').value = ''; state.keyword = ''; state.filters = {}; state.page = 1; container.querySelectorAll('[data-f]').forEach((el) => { el.value = ''; }); load(); };
    container.querySelectorAll('[data-f]').forEach((el) => { el.onchange = () => { state.filters[el.dataset.f] = el.value; state.page = 1; load(); }; });
    await load();
  }

  window.VIEWS = window.VIEWS || {};
  Object.entries(PATH2ENT).forEach(([path, ent]) => {
    window.VIEWS[path] = {
      title: { customer: '客户档案', lead: '线索管理', leadPool: '线索池', opportunity: '商机管理', contract: '合同管理', order: '订单与回款' }[ent],
      render(container, ctx) { return page(container, ctx, ent); }
    };
  });
  window.VIEWS['/crm/pool'] = { title: '客户公海', render(container, ctx) { return poolPage(container, ctx); } };
})();
