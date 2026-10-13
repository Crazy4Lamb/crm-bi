'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
module.exports = {
  run: (user, fn) => storage.run(user, fn),
  current: () => storage.getStore() || { id: 0, dataScope: 'all', dept: '', role: 'system' }
};

