// works.js —— 我的作品：保存在本机浏览器（localStorage），7 天有效，最多 30 条
const KEY = 'ruying_works_v2';
const TTL = 7 * 86400000;
const MAX = 30;

let memory = null; // localStorage 不可用（隐私模式）时退回内存
const read = () => {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return memory || []; }
};
const write = (list) => {
  memory = list;
  try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch { return false; }
};

export function daysLeft(expiresAt, now = Date.now()) { return Math.max(0, Math.ceil((expiresAt - now) / 86400000)); }

export function listWorks(now = Date.now()) {
  const all = read();
  const alive = all.filter((w) => now < w.expiresAt);
  if (alive.length !== all.length) write(alive); // 顺手清掉过期的
  return alive.sort((a, b) => b.at - a.at).map((w) => ({ ...w, days: daysLeft(w.expiresAt, now), createdAt: new Date(w.at).toLocaleString('zh-CN', { hour12: false }) }));
}

/**
 * kind: 'video' | 'audio' | 'image'（有 url）或 'text'（有 text，JSON/文本结果）
 * 返回 { work, persisted }：persisted=false 表示浏览器禁止存储，只在本次打开期间有效
 */
export function addWork({ kind, type, title, url = '', text = '', duration = null, mode = 'mock' }, now = Date.now()) {
  const work = { id: `w_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`, kind, type, title, url, text, duration, mode, at: now, expiresAt: now + TTL };
  const persisted = write([work, ...read()].slice(0, MAX));
  return { work, persisted };
}
export function getWork(id) { return read().find((w) => w.id === id) || null; }
export function removeWork(id) { write(read().filter((w) => w.id !== id)); }
export function clearWorks() { write([]); }
