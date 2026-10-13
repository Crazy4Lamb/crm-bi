/* 应用外壳：登录态、按角色的菜单、hash 路由 */
window.APP = (function () {
  const state = { me: null, perms: { action: [], menu: [], card: [], chart: [], dashboard: [] }, menus: [], charts: {} };
  let activeView = null;
  let routeVersion = 0;

  // 多巴胺导航点配色：按菜单 icon 映射到多彩色
  const DOP = {
    gauge: '#ff6a1a', pool: '#00c2a8', user: '#ff4d8d', funnel: '#b452ff',
    inbox: '#ffd60a', target: '#2ea6ff', file: '#ff5c5c', cart: '#ff9f45'
  };
  const DOP_POOL = ['#ff6a1a', '#ff4d8d', '#00c2a8', '#b452ff', '#2ea6ff', '#ff9f45'];

  const MENU_OF_PATH = {
    '/dashboard': 'dashboard',
    '/customer': 'crm_customer',
    '/crm/pool': 'crm_pool',
    '/lead': 'crm_lead',
    '/leadpool': 'crm_lead_pool',
    '/opportunity': 'crm_opportunity',
    '/contract': 'crm_contract',
    '/order': 'crm_order',
    '/report': 'rpt_report',
    '/report-design': 'rpt_report_design',
    '/chart': 'bi_chart',
    '/widget-design': 'bi_widget_design',
    '/metric-design': 'bi_metric_design',
    '/task': 'bi_task',
    '/user': 'sys_user',
    '/perm': 'sys_perm'
  };
  const TITLES = {
    '/dashboard': '驾驶舱', '/customer': '客户档案', '/crm/pool': '客户公海', '/lead': '线索管理', '/leadpool': '线索池',
    '/opportunity': '商机管理', '/contract': '合同管理', '/order': '订单与回款',
    '/report': '报表中心', '/report-design': '报表设计', '/chart': '统计图中心',
    '/widget-design': '统计图设计', '/metric-design': '指标设计', '/task': '任务管理',
    '/user': '用户与角色', '/perm': '权限矩阵'
  };

  const can = (action) => !!(state.me && (state.me.role === 'admin' || (state.perms.action || []).includes(action)));
  const allowedPaths = () => {
    const set = new Set(Object.keys(MENU_OF_PATH).filter((p) => (state.perms.menu || []).includes(MENU_OF_PATH[p])));
    return set;
  };

  function renderNav() {
    const nav = document.getElementById('nav');
    const allowed = allowedPaths();
    nav.innerHTML = state.menus.map((g) => {
      const kids = (g.children || []).filter((c) => {
        const path = Object.keys(MENU_OF_PATH).find((p) => MENU_OF_PATH[p] === c.code);
        return path && allowed.has(path);
      });
      if (g.path && !kids.length) {
        return `<a class="nav-item" href="#${g.path}" data-path="${g.path}" style="--dop-c:${DOP[g.icon] || '#ffb27a'}"><span class="dot"></span>${UI.esc(g.name)}</a>`;
      }
      if (!kids.length) return '';
      return `<div class="nav-group">${UI.esc(g.name)}</div>` + kids.map((c, i) =>
        `<a class="nav-item" href="#${c.path}" data-path="${c.path}" style="--dop-c:${DOP[c.icon] || DOP_POOL[i % DOP_POOL.length]}"><span class="dot"></span>${UI.esc(c.name)}</a>`).join('');
    }).join('');
    nav.querySelectorAll('.nav-item').forEach((el) => {
      el.onclick = () => { location.hash = '#' + el.dataset.path; document.querySelector('.layout').classList.remove('nav-open'); document.getElementById('menuToggle').setAttribute('aria-expanded', 'false'); };
    });
  }

  function markActive(path) {
    document.querySelectorAll('.nav-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.path === path);
    });
    document.getElementById('pageTitle').textContent = TITLES[path] || 'CRM BI';
  }

  async function renderTop() {
    const me = state.me;
    const scopeMap = { all: '全部数据', dept: '本部门数据', self: '仅本人数据' };
    document.getElementById('whoami').innerHTML = `<b>${UI.esc(me.realName)}</b> <span class="muted sm">${UI.esc(me.roleName)} · ${UI.esc(me.dept || '-')}</span>`;
    document.getElementById('avatar').textContent = (me.realName || '?').slice(0, 1);
    const sb = document.getElementById('scopeBadge');
    sb.textContent = '数据范围：' + (scopeMap[me.dataScope] || me.dataScope);
    sb.className = 'badge ' + (me.dataScope === 'all' ? '' : me.dataScope === 'dept' ? 'badge orange' : 'badge gray');
    document.getElementById('dataDate').textContent = '';
    const health = (await API.get('/api/health')).data;
    state.database = health.mode;
    state.timezone = health.timezone;
    document.getElementById('dbBadge').textContent = health.mode === 'pg' ? '● PostgreSQL' : 'PGlite 演示';
  }

  async function route() {
    const version = ++routeVersion;
    if (activeView && activeView.dispose) activeView.dispose();
    activeView = null;
    const raw = (location.hash || '#/dashboard').slice(1);
    const path = raw.split('?')[0] || '/dashboard';
    const query = new URLSearchParams(raw.split('?')[1] || '');
    const allowed = allowedPaths();
    const host = document.getElementById('content');
    host.scrollTop = 0;
    const content = document.createElement('div');
    content.dataset.viewState = 'loading';
    host.replaceChildren(content);
    markActive(path);
    if (!allowed.has(path)) {
      content.innerHTML = `<div class="card"><div class="card-bd"><div class="warn">当前角色（${UI.esc(state.me.roleName)}）没有「${UI.esc(TITLES[path] || path)}」的访问权限。<br/>请在左下角或顶部切换到有权限的账号，或让系统管理员在「权限矩阵」中授权。</div></div></div>`;
      return;
    }
    const view = window.VIEWS && window.VIEWS[path];
    if (!view) {
      content.innerHTML = `<div class="card"><div class="card-bd"><div class="empty">页面开发中：${UI.esc(path)}</div></div></div>`;
      return;
    }
    content.innerHTML = '<div class="skeleton" style="height:220px"></div>';
    activeView = view;
    try {
      document.getElementById('pageTitle').textContent = view.title || TITLES[path] || path;
      await view.render(content, { me: state.me, perms: state.perms, can, query, navigate: (p) => { location.hash = '#' + p; } });
      if (version === routeVersion) content.dataset.viewState = 'ready';
    } catch (e) {
      if (version !== routeVersion) return;
      content.dataset.viewState = 'error';
      content.innerHTML = `<div class="card"><div class="card-bd"><div class="err">页面加载失败：${UI.esc(e.message)}</div></div></div>`;
    }
  }

  async function boot() {
    if (!API.getToken()) { location.href = '/login.html'; return; }
    try {
      const r = await API.get('/api/auth/me');
      state.me = r.data.user;
      state.perms = r.data.perms;
      state.menus = r.data.menus;
    } catch (e) { return; }
    renderNav();
    await renderTop();
    document.getElementById('menuToggle').onclick = () => {
      const opened = document.querySelector('.layout').classList.toggle('nav-open');
      document.getElementById('menuToggle').setAttribute('aria-expanded', String(opened));
    };
    document.getElementById('logoutBtn').onclick = async () => {
      try { await API.post('/api/auth/logout'); } catch (e) { /* ignore */ }
      API.setToken(null);
      location.href = '/login.html';
    };
    window.addEventListener('hashchange', route);
    route();
  }

  return {
    boot, can, canVisit: (path) => allowedPaths().has(path),
    get me() { return state.me; },
    get perms() { return state.perms; },
    get database() { return state.database; },
    get timezone() { return state.timezone; },
    onDataDate(v) { const el = document.getElementById('dataDate'); if (el) el.textContent = '指标数据日（T+1）：' + v; }
  };
})();
