'use strict';
/**
 * 前端页面巡检：用无头 Chrome 逐个访问全部路由，捕获 JS 异常并截图。
 * 用法：node scripts/uicheck.js [baseUrl] [outDir]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const OUT = process.argv[3] || path.join(__dirname, '..', 'data', 'screenshots');
const CHROME = process.env.CHROME_PATH ||
  ['C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));

const PAGES = [
  ['/dashboard', '驾驶舱'],
  ['/customer', '客户档案'],
  ['/lead', '线索管理'],
  ['/leadpool', '线索池'],
  ['/opportunity', '商机管理'],
  ['/contract', '合同管理'],
  ['/order', '订单管理'],
  ['/report', '报表中心'],
  ['/report-design', '报表设计'],
  ['/chart', '统计图中心'],
  ['/widget-design', '统计图设计'],
  ['/metric-design', '指标设计'],
  ['/task', '任务管理'],
  ['/user', '用户与角色'],
  ['/perm', '权限矩阵']
].filter(([r]) => !process.env.ONLY || process.env.ONLY.split(',').includes(r.replace(/^\//, '')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(username, password) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error('登录失败：' + j.message);
  return j.data.token;
}

async function main() {
  if (!CHROME) { console.error('未找到 Chrome/Edge，可用 CHROME_PATH 指定'); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uicheck-'));
  const port = 9222 + Math.floor(Math.random() * 300);
  const AS = process.env.AS_USER || 'admin';
  const token = await login(AS, AS === 'admin' ? 'admin123' : '123456');

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-device-scale-factor=1',
    `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--window-size=1680,1200', 'about:blank'
  ], { stdio: 'ignore' });

  const cleanup = () => { try { chrome.kill(); } catch (e) { /* noop */ } };
  process.on('exit', cleanup);

  // 等待调试端口
  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch (e) { /* retry */ }
    await sleep(300);
  }
  if (!target) { console.error('无法连接 Chrome 调试端口'); cleanup(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });

  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  };
  const send = (method, params) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const sendAsync = (method, params) => send(method, params);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1200, deviceScaleFactor: 1, mobile: false });

  // 先到登录页设置 token（同源），保证后续页面免登录
  await send('Page.navigate', { url: BASE + '/login.html' });
  await sleep(1200);
  await send('Runtime.evaluate', { expression: `localStorage.setItem('crmbi_token', ${JSON.stringify(token)})` });

  const results = [];
  let n = 0;
  for (const [route, name] of PAGES) {
    n++;
    events.length = 0;
    const url = `${BASE}/index.html?r=${n}#${route}`;
    await send('Page.navigate', { url });
    await sleep(5500);   // 等待骨架屏 → 数据 → ECharts 渲染

    const probe = await send('Runtime.evaluate', {
      expression: `(() => {
        const c = document.getElementById('content');
        const t = document.getElementById('pageTitle');
        return JSON.stringify({
          title: t ? t.textContent : '',
          text: c ? c.innerText.replace(/\\s+/g, ' ').slice(0, 160) : '',
          charts: document.querySelectorAll('canvas').length,
          modal: document.querySelectorAll('.mask').length,
          warn: c ? (c.querySelectorAll('.err,.warn').length) : 0,
          boxes: [...document.querySelectorAll('.err')].slice(0, 2).map((b) => b.innerText.trim().slice(0, 90))
        });
      })()`,
      returnByValue: true
    });
    const info = JSON.parse(probe.result.result.value || '{}');

    const errors = events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description) || e.params.exceptionDetails.text)
      .concat(events
        .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
        .map((e) => (e.params.args || []).map((a) => a.value || a.description || '').join(' ')));

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${AS}-${String(n).padStart(2, '0')}-${route.replace(/\//g, '')}.png`);
    fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));

    const bad = /页面加载失败|页面开发中|没有.*权限/.test(info.text || '');
    results.push({ route, name, ok: !errors.length && !bad, errors, info, file });
    console.log(`${errors.length || bad ? '✗' : '✓'} ${name.padEnd(8, '　')} ${route.padEnd(16)} 画布 ${String(info.charts).padStart(2)} · 错误 ${errors.length}${bad ? ' · ' + info.text.slice(0, 70) : ''}`);
    if (info.boxes && info.boxes.length) info.boxes.forEach((b) => console.log('     ⚠ ' + b));
    if (errors.length) errors.slice(0, 3).forEach((e) => console.log('     ↳ ' + String(e).split('\n')[0].slice(0, 160)));
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(72));
  console.log(`页面巡检：通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
  console.log('截图目录：' + OUT);
  console.log('='.repeat(72));
  ws.close();
  cleanup();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
