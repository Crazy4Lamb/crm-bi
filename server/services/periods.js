'use strict';
/** 周期口径工具：把「当日 / 本月累计 / 整月 / 滚动7天 / 滚动30天 / 全部」翻译成日期区间 */
const { today, fmtDate, addDays } = require('./reportEngine');

function parseDate(s) {
  if (s instanceof Date) return new Date(s.getFullYear(), s.getMonth(), s.getDate());
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

/**
 * @param mode day | mtd | month | last7 | last30 | all | yesterday | ytd
 * @param statDate 基准日（默认今天）
 */
function rangeOf(mode, statDate) {
  const base = statDate ? parseDate(statDate) : today();
  const s = fmtDate(base);
  switch (mode) {
    case 'day':
      return { from: s, to: s, mode, label: `${s} 当日` };
    case 'yesterday': {
      const y = fmtDate(addDays(base, -1));
      return { from: y, to: y, mode, label: `${y} 当日` };
    }
    case 'mtd':
      return { from: fmtDate(new Date(base.getFullYear(), base.getMonth(), 1)), to: s, mode, label: `${base.getMonth() + 1} 月累计` };
    case 'month':
      return { from: fmtDate(new Date(base.getFullYear(), base.getMonth(), 1)), to: fmtDate(new Date(base.getFullYear(), base.getMonth() + 1, 0)), mode, label: `${base.getMonth() + 1} 月整月` };
    case 'last7':
      return { from: fmtDate(addDays(base, -6)), to: s, mode, label: '近 7 天' };
    case 'last30':
      return { from: fmtDate(addDays(base, -29)), to: s, mode, label: '近 30 天' };
    case 'last90':
      return { from: fmtDate(addDays(base, -89)), to: s, mode, label: '近 90 天' };
    case 'ytd':
      return { from: fmtDate(new Date(base.getFullYear(), 0, 1)), to: s, mode, label: '本年累计' };
    case 'all':
      return null;
    default:
      return { from: s, to: s, mode: 'day', label: s };
  }
}

/** 求同比/环比区间：day → 前一天；mtd/month → 上一月同期；ytd → 去年同期；滚动窗口 → 上一周期 */
function prevRangeOf(mode, statDate) {
  const base = statDate ? parseDate(statDate) : today();
  const cur = rangeOf(mode, statDate);
  if (!cur) return null;
  const from = parseDate(cur.from);
  const to = parseDate(cur.to);
  const span = Math.round((to - from) / 86400000) + 1;
  const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();

  if (mode === 'month') {
    const f = new Date(from.getFullYear(), from.getMonth() - 1, 1);
    return { from: fmtDate(f), to: fmtDate(new Date(f.getFullYear(), f.getMonth() + 1, 0)), mode, label: '上一月' };
  }
  if (mode === 'mtd') {
    const f = new Date(from.getFullYear(), from.getMonth() - 1, 1);
    const days = Math.min(base.getDate(), lastDay(f.getFullYear(), f.getMonth()));
    return { from: fmtDate(f), to: fmtDate(new Date(f.getFullYear(), f.getMonth(), days)), mode, label: '上一月同期' };
  }
  if (mode === 'ytd') {
    const f = new Date(from.getFullYear() - 1, 0, 1);
    const t = new Date(f.getFullYear(), base.getMonth(), base.getDate());
    return { from: fmtDate(f), to: fmtDate(t), mode, label: '去年同期' };
  }
  if (['last7', 'last30', 'last90'].includes(mode)) {
    return { from: fmtDate(addDays(from, -span)), to: fmtDate(addDays(to, -span)), mode, label: '上一周期' };
  }
  return { from: fmtDate(addDays(from, -1)), to: fmtDate(addDays(to, -1)), mode, label: '前一日' };
}

const growth = (cur, prev) => {
  if (!prev) return null;
  const r = (cur - prev) / Math.abs(prev);
  return Number.isFinite(r) ? r : null;
};

module.exports = { rangeOf, prevRangeOf, growth, parseDate };
