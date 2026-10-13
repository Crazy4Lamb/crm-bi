/* 系统管理：用户与角色（/user）、权限矩阵（/perm） */
(function () {
  const SCOPE = { all: '全部数据', dept: '本部门数据', self: '仅本人数据' };
  const RES_LABEL = { menu: '菜单', action: '功能操作', dashboard: '驾驶舱', card: 'KPI 卡片', chart: '统计图', report: '报表' };
  const RES_ORDER = ['menu', 'action', 'dashboard', 'card', 'chart', 'report'];

  async function guard403(container) {
    container.innerHTML = '<div class="card"><div class="card-bd"><div class="warn">仅系统管理员可访问该模块。请使用 admin 账号登录。</div></div></div>';
  }

  // ============================================== 用户与角色
  async function users(container, ctx) {
    if (ctx.me.role !== 'admin') return guard403(container);
    const roles = (await API.get('/api/sys/roles')).data;
    const list = (await API.get('/api/sys/users')).data;
    const stats = (await API.get('/api/sys/stats')).data;
    const pg = stats.db.mode === 'pg' ? (await API.get('/api/sys/postgres')).data : null;
    const state = { tab: 'user', roleFilter: '' };

    container.innerHTML = `
      <div class="tabs">
        <div class="tab active" data-tab="user">用户管理（${list.length}）</div>
        <div class="tab" data-tab="role">角色（${roles.length}）</div>
        <div class="tab" data-tab="db">数据库与数据量</div>
      </div>
      <div id="tabBody"></div>`;

    container.querySelectorAll('[data-tab]').forEach((el) => {
      el.onclick = () => {
        state.tab = el.dataset.tab;
        container.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === el));
        draw();
      };
    });

    function draw() {
      const body = container.querySelector('#tabBody');
      if (state.tab === 'user') return drawUsers(body);
      if (state.tab === 'role') return drawRoles(body);
      return drawDb(body);
    }

    function drawUsers(body) {
      body.innerHTML = `
        <div class="card">
          <div class="card-hd">
            <div><div class="t">系统用户</div><div class="d">账号、角色与数据范围决定其登录后可见的菜单、卡片与报表</div></div>
            <div class="flex gap8 center">
              <select class="input" id="roleFilter" style="width:150px">${UI.options([['', '全部角色']].concat(roles.map((r) => [r.code, r.name])), state.roleFilter)}</select>
              <button class="btn sm primary" id="newUser">+ 新建用户</button>
            </div>
          </div>
          <div class="card-bd" id="userTable"></div>
        </div>`;
      body.querySelector('#roleFilter').onchange = (e) => { state.roleFilter = e.target.value; drawUsers(body); };
      body.querySelector('#newUser').onclick = () => userForm(null, () => refresh());

      const rows = list.filter((u) => !state.roleFilter || u.role_code === state.roleFilter);
      body.querySelector('#userTable').innerHTML = UI.table([
        { key: 'id', name: 'ID', width: 56 },
        { key: 'username', name: '账号', render: (u) => `<span class="mono">${UI.esc(u.username)}</span>` },
        { key: 'real_name', name: '姓名' },
        { key: 'role_name', name: '角色', render: (u) => `<div>${UI.esc(u.role_name || u.role_code)}</div><div class="sm mono muted">${UI.esc(u.role_code)}</div>` },
        { key: 'dept', name: '部门/大区' },
        { key: 'data_scope', name: '数据范围', render: (u) => `<span class="badge ${u.data_scope === 'all' ? '' : u.data_scope === 'dept' ? 'orange' : 'gray'}">${UI.esc(SCOPE[u.data_scope] || u.data_scope)}</span>` },
        { key: 'phone', name: '手机' },
        { key: 'status', name: '状态', render: (u) => (u.status === '1' ? '<span class="badge green">启用</span>' : '<span class="badge gray">停用</span>') },
        { key: 'last_login_at', name: '最近登录', fmt: 'dt' },
        {
          key: 'ops', name: '操作', width: 160,
          render: (u) => `<div class="flex gap8"><button class="btn sm" data-edit="${u.id}">编辑</button><button class="btn-link danger" data-del="${u.id}">删除</button></div>`
        }
      ], rows, {});
      body.querySelectorAll('[data-edit]').forEach((el) => {
        el.onclick = () => userForm(list.find((u) => u.id === Number(el.dataset.edit)), () => refresh());
      });
      body.querySelectorAll('[data-del]').forEach((el) => {
        el.onclick = () => {
          const u = list.find((x) => x.id === Number(el.dataset.del));
          UI.confirmBox('删除用户', `确定删除用户「${u.real_name}（${u.username}）」？`, async () => {
            try { await API.del('/api/sys/users/' + u.id); UI.toast('已删除', 'ok'); refresh(); } catch (e) { UI.toast(e.message, 'err'); }
          });
        };
      });
    }

    function drawRoles(body) {
      body.innerHTML = `<div class="card">
        <div class="card-hd"><div><div class="t">角色</div><div class="d">角色决定默认数据范围与「权限矩阵」中的资源授权</div></div></div>
        <div class="card-bd">${UI.table([
        { key: 'code', name: '角色编码', render: (r) => `<span class="mono">${UI.esc(r.code)}</span>` },
        { key: 'name', name: '角色名称' },
        { key: 'description', name: '说明' },
        { key: 'userCount', name: '用户数', align: 'right' },
        { key: 'sort_no', name: '排序', align: 'right' },
        {
          key: 'ops', name: '操作', width: 150,
          render: (r) => `<button class="btn sm" data-perm="${UI.esc(r.code)}">配置权限</button>`
        }
      ], roles, {})}</div>
      </div>`;
      body.querySelectorAll('[data-perm]').forEach((el) => {
        el.onclick = () => { location.hash = '#/perm?role=' + el.dataset.perm; };
      });
    }

    function drawDb(body) {
      const c = stats.counts || {};
      const groups = [
        ['CRM 业务数据', ['crm_customer', 'crm_contact', 'crm_lead_pool', 'crm_lead', 'crm_opportunity', 'crm_contract', 'crm_order', 'crm_follow_up']],
        ['报表与 BI 元数据', ['rpt_dataset', 'rpt_report', 'bi_metric', 'bi_metric_value', 'bi_widget', 'bi_dashboard']],
        ['任务与系统', ['bi_task', 'bi_task_log', 'sys_user']]
      ];
      body.innerHTML = `
        <div class="card mb16"><div class="card-hd"><div><div class="t">数据库连接</div><div class="d">当前后端使用的数据库实例</div></div></div>
          <div class="card-bd">
            <div class="kv"><span>后端运行时</span><b class="mono">${pg && pg.backend ? `${UI.esc(pg.backend.framework)} / Java ${UI.esc(pg.backend.java)}` : UI.esc(stats.backend || '-')}</b></div>
            <div class="kv"><span>数据访问</span><b class="mono">${pg && pg.backend ? UI.esc(pg.backend.dataAccess) : 'Spring JDBC + HikariCP'}</b></div>
            <div class="kv"><span>数据库模式</span><b class="mono">${pg ? '真实 PostgreSQL 18 服务 / 行级安全' : '数据库未连接'}</b></div>
            <div class="kv"><span>连接信息</span><b class="mono">${UI.esc(stats.db.label)}</b></div>
            <div class="kv"><span>版本</span><b class="mono sm">${UI.esc(stats.db.version)}</b></div>
            <div class="kv"><span>数据库当前日期</span><b class="mono">${UI.esc(String(stats.today).slice(0, 10))}</b></div>
          </div></div>
        ${pg ? `<div class="stat-strip mb16"><div class="stat-chip"><div class="l">连接池 / 上限</div><div class="v">${pg.pool.total} / ${pg.pool.max}</div><div class="sm muted">空闲 ${pg.pool.idle} · 等待 ${pg.pool.waiting}</div></div><div class="stat-chip"><div class="l">数据库索引</div><div class="v">${pg.indexes.length}</div><div class="sm muted">含 GIN 搜索、JSONB 与复合索引</div></div><div class="stat-chip"><div class="l">行级安全策略</div><div class="v">${pg.policies.length}</div><div class="sm muted">运行账号 ${UI.esc(pg.database.user)} · ${pg.database.superuser || pg.database.bypass_rls ? '特权账号' : '普通账号，无 RLS 绕过权'}</div></div><div class="stat-chip"><div class="l">变更审计记录</div><div class="v">${UI.num(pg.audit.records)}</div><div class="sm muted">由数据库触发器自动记录</div></div></div><div class="card mb16"><div class="card-hd"><div><div class="t">PostgreSQL 经营分析快照</div><div class="d">物化视图按销售与部门汇总，趋势查询使用窗口函数</div></div><button id="refreshPg" class="btn primary sm">刷新经营快照</button></div><div class="card-bd"><div class="kv"><span>快照状态</span><b>${pg.snapshot.stale ? '业务数据已有变更，等待刷新' : '已同步'}</b></div><div class="kv"><span>刷新时间</span><b>${UI.dt(pg.snapshot.refreshed_at)}</b></div><div class="kv"><span>数据版本 / 快照版本</span><b>${pg.snapshot.source_version} / ${pg.snapshot.refreshed_version}</b></div><div class="kv"><span>数据库大小</span><b>${UI.num(Number(pg.database.bytes)/1024/1024,2)} MB</b></div><div class="kv"><span>已应用迁移</span><b>${pg.migrations.map(m=>UI.esc(m.version)).join(' · ')}</b></div><details class="mt16"><summary>查看样例搜索的真实查询计划</summary><div class="sm muted mt8">小数据量时顺序扫描可能是优化器的合理选择。耗时为本次运行结果。</div><pre class="code-box">${UI.esc(JSON.stringify(pg.searchPlan,null,2))}</pre></details></div></div>` : ''}
        ${groups.map(([title, tbs]) => `<div class="card mb16"><div class="card-hd"><div><div class="t">${title}</div></div></div>
          <div class="card-bd"><div class="grid cols-4">${tbs.map((tb) => `
            <div class="kpi" style="padding:12px"><div class="l"><span class="sm mono">${tb}</span></div>
            <div class="v" style="font-size:20px">${UI.num(c[tb] || 0)}</div></div>`).join('')}</div></div></div>`).join('')}`;
      const refreshPg = body.querySelector('#refreshPg');
      if (refreshPg) refreshPg.onclick = async () => { refreshPg.disabled=true; try { const r=await API.post('/api/sys/postgres/refresh'); UI.toast(r.message,'ok'); const result=(await API.get('/api/sys/postgres')).data; Object.assign(pg,result); drawDb(body); } catch(e) { UI.toast(e.message,'err'); refreshPg.disabled=false; } };
    }

    function userForm(u, onDone) {
      const isNew = !u;
      const cfg = isNew
        ? { username: '', real_name: '', role_code: 'sales_rep', dept: '', phone: '', email: '', data_scope: 'self', status: '1' }
        : u;
      UI.modal({
        title: isNew ? '新建用户' : '编辑用户 · ' + u.real_name,
        size: 'wide',
        body: `
          <div class="grid cols-3">
            <div class="field"><label>登录账号 *</label><input class="input mono" id="uName" value="${UI.esc(cfg.username)}" ${isNew ? '' : 'disabled'} /></div>
            <div class="field"><label>姓名 *</label><input class="input" id="uReal" value="${UI.esc(cfg.real_name)}" /></div>
            <div class="field"><label>角色 *</label><select class="input" id="uRole">${UI.options(roles.map((r) => [r.code, r.name]), cfg.role_code)}</select></div>
          </div>
          <div class="grid cols-3">
            <div class="field"><label>部门 / 大区</label><input class="input" id="uDept" value="${UI.esc(cfg.dept || '')}" /></div>
            <div class="field"><label>手机</label><input class="input" id="uPhone" value="${UI.esc(cfg.phone || '')}" /></div>
            <div class="field"><label>邮箱</label><input class="input" id="uEmail" value="${UI.esc(cfg.email || '')}" /></div>
          </div>
          <div class="grid cols-3">
            <div class="field"><label>数据范围</label><select class="input" id="uScope">${UI.options(metaScopes(), cfg.data_scope)}</select></div>
            <div class="field"><label>状态</label><select class="input" id="uStatus">${UI.options([['1', '启用'], ['0', '停用']], cfg.status)}</select></div>
            <div class="field"><label>${isNew ? '初始密码（默认 123456）' : '重置密码（留空不变）'}</label><input class="input" id="uPwd" placeholder="${isNew ? '123456' : '留空则不修改'}" /></div>
          </div>
          <div class="hint">数据范围：<b>全部数据</b> 可见全量；<b>本部门数据</b> 按部门的负责人/归属过滤；<b>仅本人数据</b> 只能看到自己名下的客户、合同与订单。销售代表建议使用「仅本人」。</div>`,
        buttons: [
          { text: '取消' },
          {
            text: '保存', type: 'primary',
            onClick: async (close, mask) => {
              const q = (s) => mask.querySelector(s).value.trim();
              if (!q('#uReal')) return UI.toast('请填写姓名', 'err');
              const body = {
                real_name: q('#uReal'), role_code: q('#uRole'), dept: q('#uDept'),
                phone: q('#uPhone'), email: q('#uEmail'), data_scope: q('#uScope'), status: q('#uStatus')
              };
              if (q('#uPwd')) body.password = q('#uPwd');
              try {
                if (isNew) {
                  if (!q('#uName')) return UI.toast('请填写登录账号', 'err');
                  body.username = q('#uName');
                  const r = await API.post('/api/sys/users', body);
                  UI.toast(r.message || '已创建', 'ok');
                } else {
                  await API.put('/api/sys/users/' + u.id, body);
                  UI.toast('已保存', 'ok');
                }
                close(); onDone();
              } catch (e) { UI.toast(e.message, 'err'); }
            }
          }
        ]
      });
    }
    const metaScopes = () => Object.entries(SCOPE).map(([v, t]) => [v, t]);

    const refresh = () => render(container, ctx);
    draw();
  }

  // ============================================== 权限矩阵
  async function perms(container, ctx) {
    if (ctx.me.role !== 'admin') return guard403(container);
    const data = (await API.get('/api/sys/acl')).data;
    const roles = data.roles;
    const res = data.resources;
    const matrix = data.matrix || {};
    let role = ctx.query.get('role') || (roles[0] && roles[0].code) || '';
    if (!matrix[role]) role = roles[0] ? roles[0].code : '';

    function has(type, key) { return ((matrix[role] && matrix[role][type]) || []).includes(String(key)); }

    function draw() {
      const groups = RES_ORDER
        .map((t) => ({ type: t, items: res[t] || [] }))
        .filter((g) => g.items.length);

      container.innerHTML = `
        <div class="card mb16"><div class="card-bd">
          <div class="flex wrap gap12 center">
            <div class="field" style="margin:0;min-width:220px"><label>当前编辑角色</label>
              <select class="input" id="roleSel">${UI.options(roles.map((r) => [r.code, `${r.name}（${r.code}）`]), role)}</select></div>
            <div class="hint" style="flex:1;margin:0">勾选即时生效。菜单控制左侧导航可见性，功能操作控制「能否新建/编辑/执行」，卡片与统计图控制驾驶舱可见内容，报表控制报表中心可见列表。</div>
            <button class="btn sm" id="expandAll">展开全部</button>
          </div>
        </div></div>
        <div class="grid cols-2">${groups.map((g) => `
          <div class="card">
            <div class="card-hd">
              <div><div class="t">${RES_LABEL[g.type] || g.type}</div><div class="d">共 ${g.items.length} 项 · 已授权 <b data-cnt="${g.type}">${g.items.filter((i) => has(g.type, i.code)).length}</b></div></div>
              <div class="flex gap8">
                <button class="btn sm" data-all="${g.type}">全选</button>
                <button class="btn sm" data-none="${g.type}">清空</button>
              </div>
            </div>
            <div class="card-bd" style="max-height:340px;overflow:auto" data-group="${g.type}">
              ${g.items.map((i) => `<label class="flex center gap8" style="padding:5px 0">
                <input type="checkbox" data-rt="${g.type}" data-rk="${UI.esc(i.code)}" ${has(g.type, i.code) ? 'checked' : ''} />
                <span>${UI.esc(i.name)}</span><span class="sm mono muted">${UI.esc(i.code)}</span>
              </label>`).join('')}
            </div>
          </div>`).join('')}</div>`;

      container.querySelector('#roleSel').onchange = (e) => { role = e.target.value; draw(); };
      container.querySelector('#expandAll').onclick = () => {
        container.querySelectorAll('.card-bd[data-group]').forEach((el) => { el.style.maxHeight = 'none'; });
      };

      const updateCnt = (type) => {
        const el = container.querySelector(`[data-cnt="${type}"]`);
        if (el) el.textContent = container.querySelectorAll(`[data-rt="${type}"]:checked`).length;
      };

      container.querySelectorAll('[data-rt]').forEach((el) => {
        el.onchange = async () => {
          const type = el.dataset.rt;
          const key = el.dataset.rk;
          el.disabled = true;
          try {
            await API.post('/api/sys/acl', { roleCode: role, resType: type, resKey: key, enabled: el.checked });
            if (!matrix[role]) matrix[role] = {};
            if (!matrix[role][type]) matrix[role][type] = [];
            const arr = matrix[role][type];
            if (el.checked) { if (!arr.includes(key)) arr.push(key); }
            else matrix[role][type] = arr.filter((x) => x !== key);
            updateCnt(type);
            UI.toast((el.checked ? '已授权 ' : '已取消 ') + key, 'ok');
          } catch (e) { el.checked = !el.checked; UI.toast(e.message, 'err'); }
          el.disabled = false;
        };
      });

      container.querySelectorAll('[data-all]').forEach((el) => {
        el.onclick = async () => {
          const type = el.dataset.all;
          for (const box of container.querySelectorAll(`[data-rt="${type}"]`)) {
            if (!box.checked) { box.checked = true; await box.onchange(); }
          }
          updateCnt(type);
        };
      });
      container.querySelectorAll('[data-none]').forEach((el) => {
        el.onclick = async () => {
          const type = el.dataset.none;
          for (const box of container.querySelectorAll(`[data-rt="${type}"]`)) {
            if (box.checked) { box.checked = false; await box.onchange(); }
          }
          updateCnt(type);
        };
      });
    }

    draw();
  }

  window.VIEWS = window.VIEWS || {};
  window.VIEWS['/user'] = { title: '用户与角色', render: users };
  window.VIEWS['/perm'] = { title: '权限矩阵', render: perms };
})();
