/* 通用 UI 工具：转义、格式化、弹窗、表格、分页 */
window.UI = (function () {
  const esc = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const num = (v, d) => n(v).toLocaleString('zh-CN', { minimumFractionDigits: d || 0, maximumFractionDigits: d === undefined ? 2 : d });
  const money = (v) => {
    const x = n(v);
    if (Math.abs(x) >= 100000000) return (x / 100000000).toFixed(2) + ' 亿';
    if (Math.abs(x) >= 10000) return (x / 10000).toFixed(2) + ' 万';
    return x.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  };
  const moneyFull = (v) => '¥' + n(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  const pct = (v) => (n(v) * 100).toFixed(2) + '%';
  const date = (v) => (v ? String(v).slice(0, 10) : '-');
  const dt = (v) => {
    if(!v) return '-';
    if(/Z$|[+-]\d{2}:\d{2}$/.test(String(v))) {
      const parsed = new Date(v);
      if(Number.isFinite(parsed.getTime())) return new Intl.DateTimeFormat('sv-SE',{timeZone:(window.APP && APP.timezone) || 'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(parsed);
    }
    return String(v).replace('T',' ').slice(0,19);
  };

  function toast(msg, type) {
    let wrap = document.querySelector('.toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
    const t = document.createElement('div');
    t.className = 'toast ' + (type === 'err' ? 'err' : type === 'ok' ? 'ok' : '');
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  function modal(opt) {
    const mask = document.createElement('div');
    mask.className = 'mask';
    mask.innerHTML = `
      <div class="modal ${opt.size || ''}">
        <div class="modal-hd"><div class="t">${esc(opt.title || '')}</div><div class="x">×</div></div>
        <div class="modal-bd"></div>
        <div class="modal-ft"></div>
      </div>`;
    const bd = mask.querySelector('.modal-bd');
    const ft = mask.querySelector('.modal-ft');
    if (typeof opt.body === 'string') bd.innerHTML = opt.body; else if (opt.body) bd.appendChild(opt.body);
    (opt.buttons || []).forEach((b) => {
      const el = document.createElement('button');
      el.className = 'btn ' + (b.type || '');
      el.textContent = b.text;
      el.onclick = async () => {
        if (!b.onClick) { close(); return; }
        el.disabled = true;
        try { await b.onClick(close, mask); }
        catch (e) { toast(e.message, 'err'); }
        finally { el.disabled = false; }
      };
      ft.appendChild(el);
    });
    if (!opt.buttons || !opt.buttons.length) {
      const c = document.createElement('button');
      c.className = 'btn'; c.textContent = '关闭'; c.onclick = () => close();
      ft.appendChild(c);
    }
    function close() { mask.remove(); }
    mask.querySelector('.x').onclick = () => (opt.onClose ? opt.onClose(close) : close());
    mask.onclick = (e) => { if (e.target === mask && opt.maskClose !== false) (opt.onClose ? opt.onClose(close) : close()); };
    document.body.appendChild(mask);
    if (opt.onOpen) opt.onOpen(bd, close, mask);
    return { close, el: mask, body: bd, footer: ft };
  }

  function confirmBox(title, text, onOk) {
    modal({
      title,
      body: `<div>${esc(text)}</div>`,
      buttons: [
        { text: '取消' },
        { text: '确定', type: 'primary', onClick: (close) => { close(); onOk && onOk(); } }
      ]
    });
  }

  /** 表格渲染：columns=[{key,name,width,align,fmt,render}] */
  function table(columns, rows, opt) {
    const o = opt || {};
    const head = columns.map((c) => `<th style="${c.width ? 'width:' + c.width + 'px;' : ''}${c.align === 'right' ? 'text-align:right;' : ''}">${esc(c.name)}</th>`).join('');
    const body = rows.length ? rows.map((r) => '<tr>' + columns.map((c) => {
      let v = r[c.key];
      if (c.render) v = c.render(r);
      else if (c.fmt === 'money') v = money(v);
      else if (c.fmt === 'moneyFull') v = moneyFull(v);
      else if (c.fmt === 'num') v = num(v);
      else if (c.fmt === 'pct') v = pct(v);
      else if (c.fmt === 'date') v = date(v);
      else if (c.fmt === 'dt') v = dt(v);
      else v = esc(v === null || v === undefined ? '-' : v);
      return `<td class="${c.align === 'right' ? 'num' : ''}">${v}</td>`;
    }).join('') + '</tr>').join('') : `<tr><td colspan="${columns.length}"><div class="empty">暂无数据</div></td></tr>`;
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function pager(total, page, size, onChange) {
    const pages = Math.max(1, Math.ceil(total / size));
    const el = document.createElement('div');
    el.className = 'pager';
    el.innerHTML = `<div>共 <b>${total}</b> 条，第 ${page}/${pages} 页</div>`;
    const box = document.createElement('div');
    box.className = 'flex gap8 center';
    const mk = (t, p, dis) => {
      const b = document.createElement('button');
      b.className = 'btn sm'; b.textContent = t; b.disabled = !!dis;
      b.onclick = () => onChange(p);
      return b;
    };
    box.appendChild(mk('上一页', page - 1, page <= 1));
    box.appendChild(mk('下一页', page + 1, page >= pages));
    el.appendChild(box);
    return el;
  }

  function enumMap(enumStr) {
    const m = {};
    String(enumStr || '').split(',').forEach((p) => { const [k, v] = p.split(':'); if (k) m[k.trim()] = (v || k).trim(); });
    return m;
  }
  const fmtByType = (v, type, fmt) => {
    if (v === null || v === undefined) return '-';
    if (fmt === 'currency') return money(v);
    if (fmt === 'percent') return pct(v);
    if (type === 'number') return num(v);
    if (type === 'date') return date(v);
    return esc(v);
  };
  /** 归一化下拉选项：支持 [值, 文本] / {value,label} / {code,name} / 标量 */
  const normOption = (x) => {
    if (Array.isArray(x)) return { v: x[0], t: x[1] === undefined ? x[0] : x[1] };
    if (x && typeof x === 'object') {
      const v = x.value !== undefined ? x.value : (x.code !== undefined ? x.code : x.key);
      const t = x.label !== undefined ? x.label : (x.name !== undefined ? x.name : v);
      return { v, t };
    }
    return { v: x, t: x };
  };
  const options = (list, value, placeholder) => {
    const arr = (list || []).map(normOption);
    return (placeholder ? `<option value="">${esc(placeholder)}</option>` : '') +
      arr.map((o) => `<option value="${esc(o.v)}"${String(o.v) === String(value === undefined ? '' : value) ? ' selected' : ''}>${esc(o.t)}</option>`).join('');
  };

  return { esc, num, money, moneyFull, pct, date, dt, toast, modal, confirmBox, table, pager, enumMap, fmtByType, options };
})();
