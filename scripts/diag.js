/* 诊断脚本：逐组件打印取数失败原因（含 SQL） */
const BASE = 'http://127.0.0.1:8787';
async function call(path, opt = {}, token) {
  const res = await fetch(new URL(path, BASE), {
    method: opt.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
(async () => {
  const login = await call('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  const token = login.data.data.token;
  const lib = await call('/api/dashboard/widget-library', {}, token);
  const bad = [];
  for (const w of lib.data.data) {
    const r = await call('/api/dashboard/widget/' + w.code, {}, token);
    if (r.status !== 200 || !r.data.data.ok) bad.push({ code: w.code, type: w.widgetType, err: (r.data.data && r.data.data.error) || r.data.message });
  }
  if (!bad.length) console.log('全部 ' + lib.data.data.length + ' 个组件取数正常');
  bad.forEach((b) => console.log('\n### ' + b.code + ' [' + b.type + ']\n' + b.err));
  await call('/api/auth/logout', { method: 'POST' }, token);
})();
