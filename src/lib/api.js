// api.js —— 前端 API 封装：同源相对路径（支持子路径部署）、统一错误、任务轮询、知识库上传、SSE 问答
// 浏览器永远拿不到任何密钥；运行模式与工作区标识通过请求头告知服务端。

const MODE_KEY = 'ruying_mode_v1';
const WS_KEY = 'ruying_workspace_v1';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 隐私模式 */ } },
};

export function getMode() { return store.get(MODE_KEY) === 'real' ? 'real' : 'mock'; }
export function setMode(mode) { store.set(MODE_KEY, mode === 'real' ? 'real' : 'mock'); }

let wsCache = null;
export function workspaceId() {
  if (wsCache) return wsCache;
  let id = store.get(WS_KEY);
  if (!id || !/^[a-z0-9-]{8,64}$/i.test(id)) {
    id = globalThis.crypto?.randomUUID?.() || `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    store.set(WS_KEY, id);
  }
  wsCache = id;
  return id;
}

/** 面向用户的错误：message 说发生了什么，hint 说下一步，action 决定界面给哪个按钮 */
export class ApiError extends Error {
  constructor({ message, hint = '', action = 'retry', code = '', status = 0, taskId = null }) {
    super(message);
    this.hint = hint; this.action = action; this.code = code; this.status = status; this.taskId = taskId;
  }
}
const networkError = () => new ApiError({ message: '网络连接中断，请求没有送达服务器。', hint: '检查网络连接后重试。', action: 'retry', code: 'NETWORK' });
const timeoutError = () => new ApiError({ message: '服务器响应超时。', hint: '可能是网络较慢或服务繁忙，请稍后重试。', action: 'later', code: 'TIMEOUT' });

export function toApiError(e) {
  if (e instanceof ApiError) return e;
  if (e?.name === 'TimeoutError' || e?.message === 'timeout') return timeoutError();
  if (e?.name === 'AbortError') return e;
  return networkError();
}

/** AbortSignal.any 的兼容实现（旧版 Safari 没有） */
function anySignal(signals) {
  if (AbortSignal.any) return AbortSignal.any(signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) { c.abort(s.reason); break; }
    s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
const timeoutSignal = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : (() => { const c = new AbortController(); setTimeout(() => c.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms); return c.signal; })());

const headers = (json = true) => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  'X-Requested-With': 'ruying', // 服务端据此拒绝跨站伪造的写请求
  'X-Ruying-Mode': getMode(),
  'X-Workspace-Id': workspaceId(),
});

async function request(path, { method = 'GET', body, signal, timeoutMs = 30000 } = {}) {
  let r;
  try {
    const t = timeoutSignal(timeoutMs);
    r = await fetch(`api/${path}`, {
      method,
      headers: headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signal ? anySignal([signal, t]) : t,
    });
  } catch (e) { throw toApiError(e); }
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON */ }
  if (!j) throw new ApiError({ message: '服务暂时不可用。', hint: '请稍后刷新页面重试。', action: 'later', status: r.status, code: `HTTP_${r.status}` });
  if (j.code !== 0) throw new ApiError({ message: j.message || '请求没有成功。', hint: j.hint || '', action: j.action || 'retry', code: j.code, status: r.status });
  return j.data;
}

const qs = (o = {}) => { const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')); const t = p.toString(); return t ? `?${t}` : ''; };
const send = (method) => (path, body) => request(path, { method, body: body ?? {} });
const post = send('POST'); const patch = send('PATCH');
const del = (path) => request(path, { method: 'DELETE' });

export const api = {
  health: () => request('health'),
  config: () => request('config'),
  switchMode: (mode) => post('mode', { mode }),
  token: () => request('token'),
  fetchToken: (force) => post('token', { force: !!force }),
  tts: (text, purpose) => request('tts', { method: 'POST', body: { text, purpose }, timeoutMs: 90000 }),
  avatar: (payload) => post('avatar', payload),
  runCapability: (id, params) => request('capability/run', { method: 'POST', body: { id, params }, timeoutMs: 90000 }),
  kbList: () => request('kb'),
  kbDelete: (id) => del(`kb?id=${encodeURIComponent(id)}`),

  // 账号
  me: () => request('me'),
  login: (username, password) => post('auth/login', { username, password }),
  logout: () => post('auth/logout'),
  changePassword: (oldPassword, newPassword) => post('auth/password', { oldPassword, newPassword }),

  // 超级管理员
  admin: {
    overview: () => request('admin/overview'),
    modules: () => request('admin/modules'),
    tenants: () => request('admin/tenants'),
    tenant: (id) => request(`admin/tenants/${id}`),
    createTenant: (body) => post('admin/tenants', body),
    updateTenant: (id, body) => patch(`admin/tenants/${id}`, body),
    deleteTenant: (id) => del(`admin/tenants/${id}`),
    createUser: (tenantId, body) => post(`admin/tenants/${tenantId}/users`, body),
    updateUser: (id, body) => patch(`admin/users/${id}`, body),
    resetPassword: (id) => post(`admin/users/${id}/reset-password`),
    deleteUser: (id) => del(`admin/users/${id}`),
    vendors: () => request('admin/vendors'),
    createVendor: (body) => post('admin/vendors', body),
    updateVendor: (id, body) => patch(`admin/vendors/${id}`, body),
    deleteVendor: (id) => del(`admin/vendors/${id}`),
    vendorToken: (id, force) => request(`admin/vendors/${id}/token`, { method: 'POST', body: { force: !!force }, timeoutMs: 30000 }),
    logs: (f) => request(`admin/logs${qs(f)}`),
    logsCsvUrl: (f) => `api/admin/logs.csv${qs({ ...f, page: undefined })}`,
    purchase: (vendorId, body) => post(`admin/vendors/${vendorId}/purchase`, body),
    vendorLedger: (vendorId) => request(`admin/vendors/${vendorId}/ledger`),
    quota: (tenantId, body) => post(`admin/tenants/${tenantId}/quota`, body),
    createKey: (tenantId, body) => post(`admin/tenants/${tenantId}/keys`, body),
    revokeKey: (id) => del(`admin/keys/${id}`),
  },

  // 客户管理员
  org: {
    overview: () => request('org/overview'),
    users: () => request('org/users'),
    createUser: (body) => post('org/users', body),
    updateUser: (id, body) => patch(`org/users/${id}`, body),
    resetPassword: (id) => post(`org/users/${id}/reset-password`),
    deleteUser: (id) => del(`org/users/${id}`),
    logs: (f) => request(`org/logs${qs(f)}`),
    logsCsvUrl: (f) => `api/org/logs.csv${qs({ ...f, page: undefined })}`,
    keys: () => request('org/keys'),
    createKey: (body) => post('org/keys', body),
    revokeKey: (id) => del(`org/keys/${id}`),
    ledger: () => request('org/ledger'),
  },
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

/**
 * 轮询任务直到完成。
 * · 状态 1（未开始）持续超过 queueNoticeMs 时通过 onProgress({queued:true}) 提示「平台排队中」
 * · 网络抖动：连续失败 3 次才放弃
 * · 超过 maxWaitMs 抛出 action='resume' 的错误，界面提供「继续等待」
 */
export async function pollTask(taskId, { endpoint = 'task', mode = getMode(), onProgress, signal, startedAt = Date.now() } = {}) {
  const real = mode === 'real';
  const interval = real ? 3000 : 400;
  const queueNoticeMs = real ? 45000 : 8000;
  const maxWaitMs = real ? 15 * 60000 : 60000;
  let misses = 0;
  for (;;) {
    let t;
    try {
      t = await request(endpoint, { method: 'POST', body: { id: taskId }, signal, timeoutMs: 20000 });
      misses = 0;
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      const err = toApiError(e);
      if (['NETWORK', 'TIMEOUT'].includes(err.code) && ++misses < 3) { await sleep(interval * 2, signal); continue; }
      throw err;
    }
    const elapsed = Date.now() - startedAt;
    onProgress?.({ status: t.status, statusText: t.statusText, elapsed, queued: t.status === 1 && elapsed > queueNoticeMs });
    if (t.status === 5 && t.result) return { ...t.result, mode: t.result.mode || t.mode };
    if (t.status === 9) throw new ApiError({ message: '生成失败。', hint: t.failReason ? `平台说明：${t.failReason}。请调整后重新生成。` : '平台没有给出原因，请重新生成；多次失败请联系对接人。', action: 'retry' });
    if (elapsed > maxWaitMs) {
      throw new ApiError({
        message: t.status === 1 ? '任务一直在平台排队，还没有开始生成。' : '任务生成时间比预期长。',
        hint: `平台侧队列可能较长（任务编号 ${taskId}）。可以继续等待，也可以稍后重新生成。`,
        action: 'resume', taskId,
      });
    }
    await sleep(interval, signal);
  }
}

/** 上传一个文本文件到知识库（带上传进度） */
export function uploadKb(file, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    file.text().then((content) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'api/kb/upload');
      const h = headers(true);
      for (const [k, v] of Object.entries(h)) xhr.setRequestHeader(k, v);
      xhr.timeout = 60000;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => {
        let j = null; try { j = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (j?.code === 0) resolve(j.data);
        else reject(new ApiError({ message: j?.message || '上传没有成功。', hint: j?.hint || '请稍后重试。', action: j?.action || 'retry', code: j?.code, status: xhr.status }));
      };
      xhr.onerror = () => reject(networkError());
      xhr.ontimeout = () => reject(timeoutError());
      xhr.send(JSON.stringify({ name: file.name, content }));
    }, () => reject(new ApiError({ message: '读取文件失败。', hint: '请确认文件没有被占用或损坏后重试。', action: 'fix' })));
  });
}

/** 知识库问答（SSE）。回调：onMeta / onDelta(累计文本) / onError */
export async function chatStream(text, { onMeta, onDelta, signal } = {}) {
  let r;
  try {
    r = await fetch('api/chat', { method: 'POST', headers: headers(true), body: JSON.stringify({ text }), signal });
  } catch (e) { throw toApiError(e); }
  const type = r.headers.get('content-type') || '';
  if (!type.includes('event-stream')) {
    let j = null; try { j = await r.json(); } catch { /* ignore */ }
    throw new ApiError({ message: j?.message || '问答服务暂时不可用。', hint: j?.hint || '请稍后重试。', action: j?.action || 'retry', code: j?.code });
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', answer = '', streamError = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const blocks = buf.split(/\r?\n\r?\n/); buf = blocks.pop();
      for (const block of blocks) {
        const lines = block.split(/\r?\n/);
        const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
        const data = lines.find((l) => l.startsWith('data:'))?.slice(5).trim();
        if (!ev || !data) continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (ev === 'meta') onMeta?.(j);
        else if (ev === 'message' && j.delta) { answer += j.delta; onDelta?.(answer); }
        else if (ev === 'error') streamError = new ApiError(j);
      }
    }
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError({ message: '回答中途断开了。', hint: '网络不稳定，已显示的内容保留，可以重新提问。', action: 'retry' });
  }
  if (streamError) throw Object.assign(streamError, { partial: answer });
  return answer;
}
