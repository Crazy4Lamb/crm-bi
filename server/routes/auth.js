'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { q, one, many } = require('../db');
const cfg = require('../config');
const acl = require('../services/acl');
const { auth, wrap } = require('../middleware/auth');

const router = express.Router();

async function menuTree(roleCode) {
  const p = await acl.perms(roleCode);
  const all = await many('select * from sys_menu order by sort_no, code');
  const allowed = new Set(p.menu);
  const roots = all.filter((m) => !m.parent_code && allowed.has(m.code));
  return roots.map((r) => ({
    code: r.code, name: r.name, path: r.path, icon: r.icon,
    children: all.filter((m) => m.parent_code === r.code && allowed.has(m.code))
      .map((c) => ({ code: c.code, name: c.name, path: c.path, icon: c.icon }))
  }));
}

async function profileOf(user) {
  const p = await acl.perms(user.role_code);
  const role = await one('select * from sys_role where code = $1', [user.role_code]);
  return {
    user: {
      id: user.id, username: user.username, realName: user.real_name, role: user.role_code, roleName: role ? role.name : user.role_code,
      dept: user.dept, dataScope: user.data_scope, lastLoginAt: user.last_login_at
    },
    perms: p,
    menus: await menuTree(user.role_code)
  };
}

// 登录
router.post('/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ code: 400, message: '请输入用户名和密码' });
  const user = await one('select * from sys_user where username = $1', [String(username).trim()]);
  if (!user) return res.status(400).json({ code: 400, message: '用户名或密码错误' });
  if (user.status !== '1') return res.status(403).json({ code: 403, message: '账号已停用，请联系管理员' });
  if (!bcrypt.compareSync(String(password), user.password)) return res.status(400).json({ code: 400, message: '用户名或密码错误' });
  const token = jwt.sign({ uid: user.id, username: user.username, role: user.role_code }, cfg.jwtSecret, { expiresIn: cfg.jwtExpires });
  const last = user.last_login_at;
  await q('update sys_user set last_login_at = now() where id = $1', [user.id]);
  await q('insert into sys_oper_log (user_id, username, action, res_type, res_key, detail) values ($1,$2,$3,$4,$5,$6)',
    [user.id, user.username, 'login', 'auth', user.role_code, '登录成功']);
  const profile = await profileOf({ ...user, last_login_at: last });
  res.json({ code: 0, message: 'ok', data: { token, ...profile } });
}));

// 当前用户
router.get('/me', auth, wrap(async (req, res) => {
  const u = await one('select * from sys_user where id = $1', [req.user.id]);
  if (!u) return res.status(401).json({ code: 401, message: '用户不存在' });
  res.json({ code: 0, data: await profileOf(u) });
}));

// 演示账号（登录页展示）
router.get('/demo-accounts', wrap(async (req, res) => {
  const rows = await many(`select u.username, u.real_name, u.role_code, r.name as role_name, u.dept, u.data_scope
    from sys_user u join sys_role r on r.code = u.role_code where u.status = '1' order by r.sort_no, u.id`);
  res.json({ code: 0, data: rows.map((r) => ({ ...r, password: r.username === 'admin' ? 'admin123' : '123456' })) });
}));

router.post('/logout', auth, wrap(async (req, res) => {
  try {
    await q('insert into sys_oper_log (user_id, username, action, res_type, res_key) values ($1,$2,$3,$4,$5)',
      [req.user.id, req.user.username, 'logout', 'auth', req.user.role]);
  } catch (e) { /* ignore */ }
  res.json({ code: 0, message: '已退出登录' });
}));

// 菜单
router.get('/menus', auth, wrap(async (req, res) => res.json({ code: 0, data: await menuTree(req.user.role) })));

module.exports = { router, profileOf, menuTree };
