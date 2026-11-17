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
  tts: (text, purpose, opts = {}) => request('tts', { method: 'POST', body: { text, purpose, ...opts }, timeoutMs: 90000 }),
  /** 发音人列表：GET /api/voice/list，返回 { voices: [{ qid, voiceName, materialName, gender }] } */
  voiceList: () => request('voice/list'),
  /** 公共形象列表：GET /api/avatar/list，返回 { avatars: [{ id, name, thumbnailUrl, pkgUrl, faceFeatureId, gender, avatarType }] } */
  avatarList: () => request('avatar/list'),
  avatar: (payload) => post('avatar', payload),
  /** 单次查询任务状态（不轮询），供任务历史同步使用；返回 { status, result, mode, ... } */
  task: (id) => request('task', { method: 'POST', body: { id }, timeoutMs: 20000 }),
  /** 任务中心：GET /api/tasks，返回 { tasks, total }；params：status（1/2/5/9）、capability、q */
  taskList: (params = {}) => request(`tasks${qs(params)}`),
  /** 历史任务导入：POST /api/tasks/import，返回 { imported } */
  taskImport: (ids) => post('tasks/import', { ids }),

  // 直播内测（控制台 /company/live/liveTest 的 5 步）：创建 / 开播 / 心跳 / 接管 / 替换前景背景 / 关播
  liveTest: {
    create: (body) => request('live/test/create', { method: 'POST', body, timeoutMs: 90000 }),
    start: (sessionId) => post('live/test/start', { sessionId }),
    heartbeat: (sessionId) => post('live/test/heartbeat', { sessionId }),
    command: (body) => post('live/test/command', body),
    replace: (body) => post('live/test/replace', body),
    close: (sessionId) => post('live/test/close', { sessionId }),
    takeoverWs: (sessionId) => request(`live/takeover-ws?sessionId=${encodeURIComponent(sessionId)}`),
  },

  // 视频互动直播测试（控制台 /company/live/multiVideoInteractiveTest 的 5 步）
  multiTest: {
    create: (body) => request('live/multi/create', { method: 'POST', body, timeoutMs: 90000 }),
    start: (sessionId) => post('live/multi/start', { sessionId }),
    heartbeat: (sessionId) => post('live/multi/heartbeat', { sessionId }),
    queueAdd: (body) => post('live/multi/queue', body),
    queueList: (sessionId) => request(`live/multi/queue?sessionId=${encodeURIComponent(sessionId)}`),
    playback: (sessionId) => request(`live/multi/playback?sessionId=${encodeURIComponent(sessionId)}`),
    playMaterials: (sessionId, materialIds) => request('live/multi/play-materials', { method: 'PUT', body: { sessionId, materialIds } }),
    playSwitch: (sessionId, materialId) => post('live/multi/play-materials/switch', { sessionId, materialId }),
    status: (sessionId) => request(`live/multi/status?sessionId=${encodeURIComponent(sessionId)}`),
    close: (sessionId) => post('live/multi/close', { sessionId }),
  },

  // 过渡视频：按任务查状态 / 批量删除（平台只提供按任务查，没有按素材 ID 查的接口）
  transition: {
    status: (taskIds) => post('live/transition/status', { taskIds }),
    remove: (taskIds) => post('live/transition/delete', { taskIds }),
  },

  // 预热素材：按 fileIds 批量查询 / 批量删除（没有全量列表接口，想查必须先有 fileId）
  warming: {
    status: (fileIds) => post('live/warming/status', { fileIds }),
    remove: (fileIds) => post('live/warming/delete', { fileIds }),
  },

  // 账单：9 页签 + 日期范围；CSV 用 fetch + blob 下载（GET 也要带运行模式头，锚点直链带不上）
  bill: {
    list: (params = {}) => request(`bill${qs(params)}`),
    tabs: () => [
      { id: 'avatar', label: '人物形象模型生成' }, { id: 'video', label: '视频合成' },
      { id: 'live', label: '互动直播' }, { id: 'multi', label: '视频互动直播' },
      { id: 'tts', label: '声音合成' }, { id: 'asr', label: 'ASR合成' },
      { id: 'voice-model', label: '个人音色模型生成' }, { id: 'image-avatar', label: '图片数字人' },
      { id: 'image-edit', label: '图片编辑' },
    ],
    csv: async (params = {}) => {
      const r = await fetch(`api/bill.csv${qs(params)}`, { method: 'GET', headers: headers(false) });
      if (!r.ok) throw new ApiError({ message: '账单导出失败。', hint: '请稍后重试。', action: 'retry', status: r.status });
      return r.blob();
    },
  },

  // 互动直播脚本库（本站存储）与直播会话列表（tasks 表，只列本站创建过的）
  liveScripts: {
    list: () => request('live-scripts'),
    get: (id) => request(`live-scripts/${encodeURIComponent(id)}`),
    create: (body) => post('live-scripts', body),
    rename: async (id, name) => (await patch(`live-scripts/${encodeURIComponent(id)}`, { name })).script,
    remove: (id) => del(`live-scripts/${encodeURIComponent(id)}`),
  },
  liveSessions: () => request('live-sessions'),
  runCapability: (id, params) => request('capability/run', { method: 'POST', body: { id, params }, timeoutMs: 90000 }),
  kbList: () => request('kb'),
  kbDelete: (id) => del(`kb?id=${encodeURIComponent(id)}`),

  // 作品（登录后保存在服务端；访客的作品只在本机浏览器，见 works.js）
  works: {
    list: async () => (await request('works')).works,
    add: (work) => post('works', work),
    rename: async (id, title) => (await patch(`works/${id}`, { title })).work,
    remove: (id) => del(`works/${id}`),
    clear: () => del('works'),
    submit: async (id) => (await post(`works/${id}/submit`)).work,
    withdraw: async (id) => (await post(`works/${id}/withdraw`)).work,
  },

  // 批改（教师 / 学校管理员）
  teach: {
    works: (f) => request(`teach/works${qs(f)}`),
    review: async (id, body) => (await post(`teach/works/${id}/review`, body)).work,
    csvUrl: (f) => `api/teach/works.csv${qs(f)}`,
  },

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
    importUsers: (tenantId, body) => request(`admin/tenants/${tenantId}/users/import`, { method: 'POST', body, timeoutMs: 60000 }),
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
    importUsers: (body) => request('org/users/import', { method: 'POST', body, timeoutMs: 60000 }),
    classes: () => request('org/classes'),
    createClass: (body) => post('org/classes', body),
    updateClass: (id, body) => patch(`org/classes/${id}`, body),
    deleteClass: (id) => del(`org/classes/${id}`),
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

/** 轮询等待退避：真实环境 3000 起步 ×1.5，上限 10000；演示模式固定 400ms 不动 */
export function nextPollWait(wait, real) {
  return real ? Math.min(10000, Math.round(wait * 1.5)) : 400;
}

/** 阶段式进度估算（课程 ch3 task.js estimateProgress 原文；平台没有百分比，只有状态 0/1/2/3/5/9）：
 * 完成 100%，已取消/异常 0%，未开始/排队中 10%，生成中按已等待时间逼近 90% */
export function estimateProgress(status, elapsedMs, expectMs = 60000) {
  if (status === 5) return 100;
  if (status === 3 || status === 9) return 0;
  if (status === 0 || status === 1) return 10;
  return Math.min(90, 10 + Math.round((80 * elapsedMs) / expectMs));
}

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
  let wait = real ? 3000 : 400; // 真实环境从 3 秒起指数退避（×1.5，上限 10 秒）；演示模式固定 400ms 不动
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
      if (['NETWORK', 'TIMEOUT'].includes(err.code) && ++misses < 3) { await sleep(wait * 2, signal); continue; }
      throw err;
    }
    const elapsed = Date.now() - startedAt;
    onProgress?.({ status: t.status, statusText: t.statusText, elapsed, queued: t.status === 1 && elapsed > queueNoticeMs });
    if (t.status === 5 && t.result) return { ...t.result, mode: t.result.mode || t.mode };
    if (t.status === 9) throw new ApiError({ message: '生成失败。', hint: t.failReason ? `平台说明：${t.failReason}。请调整后重新生成。` : '平台没有给出原因，请重新生成；多次失败请联系对接人。', action: 'retry' });
    if (t.status === 3) throw new ApiError({ message: '任务已取消。', hint: '这个任务已在平台取消，不会再继续生成；可以重新提交一次。', action: 'fix' });
    if (elapsed > maxWaitMs) {
      throw new ApiError({
        message: t.status === 1 ? '任务一直在平台排队，还没有开始生成。' : '任务生成时间比预期长。',
        hint: `平台侧队列可能较长（任务编号 ${taskId}）。可以继续等待，也可以稍后重新生成。`,
        action: 'resume', taskId,
      });
    }
    await sleep(wait, signal);
    wait = nextPollWait(wait, real);
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

/** 上传一个素材文件（图片/音频/视频）到本站（带上传进度）；返回 { url, name, size, kind }，url 为相对路径 */
export function uploadMedia(file, { kind, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'api/media/upload');
    const h = headers(false);
    h['X-File-Name'] = encodeURIComponent(file.name);
    h['X-File-Kind'] = kind;
    h['Content-Type'] = file.type || 'application/octet-stream';
    for (const [k, v] of Object.entries(h)) xhr.setRequestHeader(k, v);
    xhr.timeout = 300000; // 视频上传放宽到 5 分钟
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let j = null; try { j = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (j?.code === 0) resolve(j.data);
      else reject(new ApiError({ message: j?.message || '上传没有成功。', hint: j?.hint || '请稍后重试。', action: j?.action || 'retry', code: j?.code, status: xhr.status }));
    };
    xhr.onerror = () => reject(networkError());
    xhr.ontimeout = () => reject(timeoutError());
    xhr.send(file);
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
