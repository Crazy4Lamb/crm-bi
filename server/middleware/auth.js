'use strict';
const jwt = require('jsonwebtoken');
const cfg = require('../config');
const { one } = require('../db');
const dbContext = require('../db/context');

function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username, role: user.role_code }, cfg.jwtSecret, { expiresIn: cfg.jwtExpires });
}

async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
  if (!token) return res.status(401).json({ code: 401, message: '未登录或登录已过期' });
  try {
    const p = jwt.verify(token, cfg.jwtSecret);
    const u = await one('select id, username, real_name, role_code, dept, data_scope, status from sys_user where id = $1', [p.uid]);
    if (!u || u.status !== '1') return res.status(401).json({ code: 401, message: '用户不存在或已停用' });
    req.user = { id: u.id, username: u.username, realName: u.real_name, role: u.role_code, dept: u.dept, dataScope: u.data_scope };
    dbContext.run(req.user, next);
  } catch (e) {
    return res.status(401).json({ code: 401, message: '登录状态无效，请重新登录' });
  }
}

/** 统一异常封装 */
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  const msg = String(e && e.message || e);
  const status = /不存在|未授权|无权限/.test(msg) ? 400 : 500;
  res.status(status).json({ code: status, message: msg });
});

/** 让 Express 4 也能捕获 async 路由抛出的异常（交给全局错误处理） */
function asyncGuard(router) {
  router.stack.forEach((layer) => {
    if (layer.route && layer.route.stack) {
      layer.route.stack.forEach((s) => {
        const fn = s.handle;
        s.handle = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
      });
    }
  });
  return router;
}

module.exports = { signToken, auth, wrap, asyncGuard };
