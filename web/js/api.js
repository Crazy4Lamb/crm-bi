/* 轻量 API 客户端：统一带 token、统一错误处理 */
window.API = (function () {
  const KEY = 'crmbi_token';
  const getToken = () => localStorage.getItem(KEY);
  const setToken = (t) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY));

  async function request(path, opt) {
    const o = opt || {};
    const url = new URL(path, location.origin);
    if (o.params) {
      Object.entries(o.params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      });
    }
    const headers = { 'Content-Type': 'application/json' };
    const tk = getToken();
    if (tk) headers.Authorization = 'Bearer ' + tk;
    let res;
    try {
      res = await fetch(url.toString(), {
        method: o.method || 'GET',
        headers,
        body: o.body ? JSON.stringify(o.body) : undefined
      });
    } catch (e) {
      throw new Error('网络请求失败：' + e.message);
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 401) {
      setToken(null);
      if (!/login\.html/.test(location.pathname)) location.href = '/login.html';
      throw new Error((data && data.message) || '登录已过期');
    }
    if (!res.ok || (data && data.code !== 0 && data.code !== undefined)) {
      const err = new Error((data && data.message) || ('请求失败 ' + res.status));
      err.payload = data;
      throw err;
    }
    return data;
  }

  return {
    get: (p, params) => request(p, { params }),
    post: (p, body) => request(p, { method: 'POST', body }),
    put: (p, body) => request(p, { method: 'PUT', body }),
    del: (p) => request(p, { method: 'DELETE' }),
    request, getToken, setToken
  };
})();
