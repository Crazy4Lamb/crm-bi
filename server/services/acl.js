'use strict';
/** 角色授权（含缓存）：menu / action / card / chart / dashboard */
const { many } = require('../db');

const cache = new Map();

async function perms(roleCode) {
  if (cache.has(roleCode)) return cache.get(roleCode);
  const rows = await many('select res_type, res_key from sys_acl where role_code = $1', [roleCode]);
  const p = { menu: [], action: [], card: [], chart: [], dashboard: [] };
  rows.forEach((r) => {
    if (!p[r.res_type]) p[r.res_type] = [];
    p[r.res_type].push(r.res_key);
  });
  cache.set(roleCode, p);
  return p;
}

const can = (p, type, key) => Array.isArray(p[type]) && p[type].includes(key);

function clear(roleCode) {
  if (roleCode) cache.delete(roleCode); else cache.clear();
}

module.exports = { perms, can, clear };
