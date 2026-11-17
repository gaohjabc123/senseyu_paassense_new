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

/** 文件名：作品名 + 任务 id，去掉不能做文件名的字符（课程 ch3 works.js fileNameOf 原文） */
export function fileNameOf(work, ext = 'mp4') {
  return `${String(work.name).replace(/[/:*?"<>|\s]+/g, '_')}_${work.id}.${ext}`;
}

/** 从链接取扩展名（mp4/mp3/wav/png/jpg/webp），取不到时用 kind 的默认值 */
export function extOfUrl(url, fallback = 'mp4') {
  const m = String(url || '').split('?')[0].match(/\.([a-z0-9]+)$/i);
  const ext = (m?.[1] || '').toLowerCase();
  return ['mp4', 'mp3', 'wav', 'png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : fallback;
}

/** 下载文件名：作品名_任务 id.扩展名；没有任务 id 时只用作品名（同步语音合成没有任务） */
export function downloadName(work, url, fallbackExt = 'mp4') {
  const name = String(work.title || work.name || '作品').replace(/[/:*?"<>|\s]+/g, '_');
  const id = work.taskId || work.id || '';
  return `${name}${id ? `_${id}` : ''}.${extOfUrl(url, fallbackExt)}`;
}

/** 2 天内过期的本机作品（课程 ch3 expiringSoon 原文口径：daysLeft ≤ 2；仅本机作品层，服务端作品链接有效期以如影平台为准） */
export function expiringSoon(now = Date.now(), days = 2) {
  return listWorks(now).filter((w) => w.days <= days);
}

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
export function addWork({ kind, type, title, url = '', text = '', duration = null, mode = 'mock', taskId = '' }, now = Date.now()) {
  // 同一 url 只存一份：任务完成自动保存后，再手动点「保存到作品」不会重复。
  if (url) {
    const existing = read().find((w) => w.url === url && now < w.expiresAt);
    if (existing) return { work: existing, persisted: true, duplicate: true };
  }
  const work = { id: `w_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`, kind, type, title, url, text, duration, mode, taskId: String(taskId || ''), at: now, expiresAt: now + TTL };
  const persisted = write([work, ...read()].slice(0, MAX));
  return { work, persisted };
}
export function getWork(id) { return read().find((w) => w.id === id) || null; }
export function renameWork(id, title) {
  const name = String(title || '').trim().slice(0, 60);
  if (!name) return null;
  const list = read();
  const w = list.find((x) => x.id === id);
  if (!w) return null;
  w.title = name;
  write(list);
  return w;
}
export function removeWork(id) { write(read().filter((w) => w.id !== id)); }
export function clearWorks() { write([]); }
