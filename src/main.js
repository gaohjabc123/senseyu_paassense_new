// main.js —— 如影 AI 能力开放平台 前端入口
// 渲染策略：顶栏、页脚（含双 logo）只在启动时渲染一次；之后状态变化只更新内容区与覆盖层，
// 环境开关只改文字和样式，logo 图片元素永远不会被重建。事件统一委托在 document 上，只绑定一次。
import './style.css';
import { PRODUCT, DEFAULT_VIEW, SITE_VIEWS, navById, SHORTCUT_MODULE } from './lib/product.js';
import { TOUR_STEPS, nextTourStep, shouldShowTour, markTourDone } from './lib/guide.js';
import { validateText, estimateSeconds, stageLabel } from './lib/wizard.js';
import { api, ApiError, getMode, setMode, pollTask, uploadKb, chatStream, toApiError } from './lib/api.js';
import { listWorks, addWork, removeWork, clearWorks, getWork } from './lib/works.js';
import { capById } from './lib/capabilities.js';
import { words } from './lib/html.js';
import * as V from './lib/views.js';
import { experienceView } from './lib/experience.js';
import { initialAdminState, parseAdminHash, renderAdminRoute, ADMIN_ROUTES, credentialDialog, createAdminController } from './lib/admin.js';

const SAMPLE_TEXT = '新款智能手表今天上市，支持全天心率监测、睡眠分析与运动记录，轻巧续航七天，欢迎到店体验。';
const MAX_UPLOAD_BYTES = 1024 * 1024;

const state = {
  view: DEFAULT_VIEW,
  mode: getMode(),
  navCollapsed: (() => { try { return localStorage.getItem('ruying-nav-collapsed') === '1'; } catch { return false; } })(),
  config: null, configError: null,
  modeSwitching: false, modeError: null,
  capFilter: 'all',
  createTab: 'video',
  video: { text: '新款智能手表今天上市，支持全天心率监测与运动记录，欢迎了解。', phase: 'idle', stage: '', queued: false, startedAt: 0, taskId: null, error: null, inputError: '', result: null, abort: null },
  voice: { text: '大家好，欢迎使用如影 AI 能力开放平台。', busy: false, error: null, inputError: '', result: null },
  kb: { loaded: false, loading: false, loadError: null, docs: [], uploads: [], dragging: false, deleting: null },
  chat: { messages: [], input: '', streaming: false, abort: null, lastQuestion: '' },
  exp: { capId: null, params: {}, running: false, stage: '', queued: false, startedAt: 0, taskId: null, error: null, result: null, abort: null },
  token: { loading: false, data: null, error: null },
  works: listWorks(),
  dialog: null,
  tour: -1,
  me: null, route: { view: DEFAULT_VIEW },
  auth: { username: '', password: '', busy: false, error: null },
  pw: { old: '', next: '', again: '', busy: false, error: null },
  adm: initialAdminState(),
};
const freshKb = () => ({ loaded: false, loading: false, loadError: null, docs: [], uploads: [], dragging: false, deleting: null });

/* ================= 外壳：只渲染一次 ================= */
const app = document.getElementById('app');
app.innerHTML = `<a class="skip-link" href="#main" data-skip>跳到主要内容</a>
  ${V.topbarHtml()}
  <div id="view-root" class="view-root"></div>
  ${V.footerHtml()}
  <div id="overlay-root"></div>`;
const viewRoot = document.getElementById('view-root');
const overlayRoot = document.getElementById('overlay-root');
const envSwitch = document.getElementById('env-switch');
const envLabel = document.getElementById('env-switch-label');

function updateTopbar() {
  envSwitch.classList.toggle('is-real', state.mode === 'real');
  envSwitch.classList.toggle('is-demo', state.mode !== 'real');
  envLabel.textContent = !state.config && !state.configError ? '读取环境…' : state.mode === 'real' ? '真实环境' : '演示环境';
  envSwitch.setAttribute('aria-label', `当前${envLabel.textContent}，点击切换运行环境`);
  const key = JSON.stringify([state.me?.user?.id, state.me?.user?.displayName, state.me?.tenant?.name]);
  if (key !== userSlotKey) { userSlotKey = key; userSlot.innerHTML = V.userSlotHtml(state.me); }
}

/* ================= 渲染：只更新内容区 ================= */
const CONSOLE_TITLE = { overview: '工作台总览', create: '创作中心', tasks: '我的作品', catalog: '能力目录', settings: '环境与配置', experience: '能力体验' };
const isSiteLayout = (v) => SITE_VIEWS.includes(v) || v === 'login';
const isWorkspace = (v) => ['overview', 'create', 'tasks', 'catalog', 'settings', 'experience'].includes(v);
const userSlot = document.getElementById('user-slot');
let userSlotKey = null;

function pageHtml() {
  const s = state;
  if (ADMIN_ROUTES[s.view]) return renderAdminRoute(s);
  if (s.view === 'experience') {
    const cap = capById(s.exp.capId);
    if (cap && s.me && !V.canUse(s, cap.id)) return `<div class="console">${V.errorBlock({ message: `你的企业未开通「${cap.name}」。`, hint: '如需使用，请联系你的企业管理员或商予科技开通。', action: 'contact' })}</div>`;
    return cap ? experienceView(s, cap) : `<div class="console">${V.errorBlock({ message: '没有找到这项能力。', hint: '请回到能力目录重新选择。', action: 'config' })}</div>`;
  }
  const page = {
    home: V.homeView, capabilities: V.capabilitiesView, scenarios: V.scenariosView, integration: V.integrationView,
    overview: V.overviewView, create: V.createView, tasks: V.tasksView, catalog: V.catalogView, settings: V.settingsView,
  }[s.view] || V.homeView;
  return page(s);
}

function render() {
  updateTopbar();
  const active = document.activeElement;
  const focusId = active && active !== document.body && viewRoot.contains(active) ? active.id : '';
  const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  const chatBox = document.getElementById('chat-box');
  const chatAtBottom = !chatBox || chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 40;

  const isSite = isSiteLayout(state.view);
  const accessNote = isWorkspace(state.view) ? V.accessBanner(state) : '';
  const banner = state.configError ? `<div class="page-banner">${V.errorBlock(state.configError, { retry: 'reload-config' })}</div>` : accessNote ? `<div class="page-banner">${accessNote}</div>` : '';
  viewRoot.className = `view-root ${isSite ? 'view-root--site' : 'view-root--console'}`;
  viewRoot.innerHTML = isSite
    ? `<main id="main" tabindex="-1" class="site-main">${banner}${pageHtml()}</main>`
    : `<div class="console-shell${state.navCollapsed ? ' nav-collapsed' : ''}">${V.sidenav(state)}<main id="main" tabindex="-1" class="console-main">${banner}${V.consoleBar(state, CONSOLE_TITLE[state.view] || ADMIN_ROUTES[state.view]?.title || '工作台')}${pageHtml()}</main></div>`;

  overlayRoot.innerHTML = state.dialog?.type === 'cred' ? credentialDialog(state.dialog)
    : state.dialog?.type === 'mode' ? V.modeDialog(state)
    : state.dialog?.type === 'work' ? V.workDialog(state.dialog.work)
      : state.tour >= 0 ? V.tourCard(state.tour) : '';

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el && !el.disabled) { el.focus({ preventScroll: true }); if (sel && el.setSelectionRange) { try { el.setSelectionRange(sel[0], sel[1]); } catch { /* ignore */ } } }
  }
  const nb = document.getElementById('chat-box');
  if (nb && chatAtBottom) nb.scrollTop = nb.scrollHeight;
  if (state.dialog) overlayRoot.querySelector('[data-autofocus]')?.focus();
  if (state.tour >= 0) highlightTour();
}

/** 只在用户正在看对应页面时才重渲染（避免后台轮询打断正在播放的音视频或正在输入的内容） */
function renderIf(view, tab) {
  if (state.view === view && (!tab || state.createTab === tab)) render();
}

/* ================= 提示 ================= */
function toast(msg) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}
function updateWorksBadge() {
  state.works = listWorks();
  const link = viewRoot.querySelector('.sidenav [data-view="tasks"]');
  if (!link) return;
  let em = link.querySelector('em');
  if (!em) { em = document.createElement('em'); link.appendChild(em); }
  em.textContent = String(state.works.length);
  em.setAttribute('aria-label', `${state.works.length} 个作品`);
}
function saved(persisted, btn) {
  updateWorksBadge();
  toast(persisted ? '已保存到「我的作品」，7 天内可在本机找回' : '浏览器禁止本地存储，作品只在本次打开期间有效');
  if (btn) { btn.textContent = '已保存'; btn.disabled = true; }
}

/* ================= 路由（hash） ================= */
function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (h.startsWith('experience/')) return { view: 'experience', capId: h.slice(11) };
  const adm = parseAdminHash(h);
  if (adm) return adm;
  if (navById(h)) return { view: h };
  return { view: DEFAULT_VIEW };
}
function go(view) {
  const target = `#${view}`;
  if (location.hash === target) applyRoute(); else location.hash = target;
}
function applyRoute() {
  const r = parseHash();
  // 首次登录 / 密码被重置：先改密码
  if (state.me?.user?.mustChangePassword && !isSiteLayout(r.view) && r.view !== 'account') { go('account'); return; }
  state.route = r;
  const changed = r.view !== state.view || (r.view === 'experience' && r.capId !== state.exp.capId);
  state.view = r.view;
  if (state.dialog?.type !== 'cred') state.dialog = null;
  if (ADMIN_ROUTES[r.view]) admin.enter(r);
  if (r.view === 'experience' && r.capId !== state.exp.capId) {
    state.exp.abort?.abort();
    state.exp = { capId: r.capId, params: {}, running: false, stage: '', queued: false, startedAt: 0, taskId: null, error: null, result: null, abort: null };
  }
  if (r.view === 'tasks' || r.view === 'overview') state.works = listWorks();
  if (r.view === 'create' && state.me) {
    const allowed = ['video', 'voice', 'chat'].filter((k) => V.canUse(state, SHORTCUT_MODULE[k]));
    if (allowed.length && !allowed.includes(state.createTab)) state.createTab = allowed[0];
  }
  if ((r.view === 'overview' && V.canUse(state, SHORTCUT_MODULE.chat)) || (r.view === 'create' && state.createTab === 'chat')) loadKb();
  if (r.view === 'settings' && state.mode === 'real') loadToken();
  if (r.view === 'create' && state.createTab === 'video' && state.tour < 0 && shouldShowTour(localStorage)) state.tour = 0;
  if (r.view !== 'create') state.tour = -1;
  render();
  if (changed) { window.scrollTo(0, 0); document.getElementById('main')?.focus({ preventScroll: true }); }
}

/* ================= 数据加载 ================= */
async function loadConfig() {
  state.configError = null;
  try {
    state.config = await api.config();
  } catch (e) {
    const err = toApiError(e);
    if (err.code === 'REAL_NOT_CONFIGURED' && state.mode === 'real') {
      setMode('mock'); state.mode = 'mock';
      toast('真实环境暂不可用，已切回演示环境');
      return loadConfig();
    }
    state.configError = err.code === 'NETWORK' || err.code?.startsWith?.('HTTP_')
      ? new ApiError({ message: '无法连接到服务端。', hint: '页面内容可以浏览，但体验功能暂不可用。请检查网络后重试。', action: 'retry' })
      : err;
  }
  render();
}

/** 登录状态变化：更新顶栏、重置工作区（知识库按企业共享）、校正运行模式 */
async function refreshMe(me) {
  const prevUser = state.me?.user?.id ?? null;
  if (me === undefined) { try { me = await api.me(); } catch { me = state.me; } }
  state.me = me ?? { user: null, tenant: null, access: { kind: 'guest', allowed: true, modules: [], canReal: false }, publicDemo: true };
  if (me === null) { try { state.me = await api.me(); } catch { /* 保持访客 */ } }
  if ((state.me.user?.id ?? null) !== prevUser) {
    state.kb = freshKb(); state.chat.messages = []; state.adm = initialAdminState(); state.token = { loading: false, data: null, error: null };
  }
  if (state.mode === 'real' && !state.me.access?.canReal) { setMode('mock'); state.mode = 'mock'; }
  await loadConfig();
}

async function loadKb(force = false) {
  const k = state.kb;
  if (k.loading || (k.loaded && !force)) return;
  k.loading = true; k.loadError = null;
  try { const d = await api.kbList(); k.docs = d.docs; k.loaded = true; } catch (e) { k.loadError = toApiError(e); }
  k.loading = false;
  renderIf('create', 'chat'); renderIf('overview');
}

async function loadToken(force = null) {
  const t = state.token;
  t.loading = true; t.error = null; renderIf('settings');
  try { t.data = force === null ? await api.token() : await api.fetchToken(force); } catch (e) { t.error = toApiError(e); }
  t.loading = false; renderIf('settings');
}

/* ================= 视频口播 ================= */
function startTicker() {
  if (startTicker.id) return;
  startTicker.id = setInterval(() => {
    let any = false;
    for (const [key, st] of [['video', state.video], ['exp', state.exp]]) {
      const running = key === 'video' ? st.phase !== 'idle' && st.phase !== 'done' : st.running;
      if (!running || !st.startedAt) continue;
      any = true;
      const el = viewRoot.querySelector(`[data-elapsed="${key}"]`);
      if (el) { const s = Math.floor((Date.now() - st.startedAt) / 1000); el.textContent = `已等待 ${s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`}`; }
    }
    if (!any) { clearInterval(startTicker.id); startTicker.id = null; }
  }, 1000);
}

async function runVideo() {
  const v = state.video;
  if (v.phase === 'tts' || v.phase === 'submit' || v.phase === 'poll') return;
  const check = validateText(v.text, 4, 200);
  if (!check.ok) { v.inputError = check.message; return render(); }
  Object.assign(v, { phase: 'tts', inputError: '', error: null, result: null, queued: false, taskId: null, startedAt: Date.now(), stage: '' });
  render(); startTicker();
  try {
    const tts = await api.tts(v.text, 'video');
    v.phase = 'submit'; renderIf('create', 'video');
    const created = await api.avatar({ text: v.text, audioUrl: tts.audio_url, duration: Math.max(1, Math.round((tts.duration_ms || estimateSeconds(v.text) * 1000) / 1000)) });
    v.taskId = created.taskId;
    await pollVideo();
  } catch (e) {
    v.phase = 'idle'; v.error = toApiError(e); renderIf('create', 'video');
  }
}

async function pollVideo() {
  const v = state.video;
  v.phase = 'poll'; v.error = null; v.stage = stageLabel(1, false);
  const ctrl = new AbortController(); v.abort = ctrl;
  renderIf('create', 'video'); startTicker();
  try {
    const result = await pollTask(v.taskId, {
      endpoint: 'task', mode: state.mode, signal: ctrl.signal, startedAt: v.startedAt,
      onProgress: ({ status, queued }) => {
        const stage = stageLabel(status, queued);
        if (stage !== v.stage || queued !== v.queued) { v.stage = stage; v.queued = queued; renderIf('create', 'video'); }
      },
    });
    Object.assign(v, { phase: 'done', result, abort: null });
    renderIf('create', 'video');
    toast('视频生成完成');
  } catch (e) {
    v.abort = null; v.phase = 'idle';
    if (e?.name === 'AbortError') { v.error = new ApiError({ message: '已停止等待。', hint: `任务仍在平台继续处理（编号 ${v.taskId}），需要时可以继续等待结果。`, action: 'resume' }); }
    else v.error = toApiError(e);
    renderIf('create', 'video');
  }
}

function resumeVideo() {
  if (!state.video.taskId) return runVideo();
  state.video.startedAt = Date.now();
  pollVideo();
}

/* ================= 语音 ================= */
async function runVoice() {
  const v = state.voice;
  if (v.busy) return;
  const check = validateText(v.text, 4, 200);
  if (!check.ok) { v.inputError = check.message; return render(); }
  Object.assign(v, { busy: true, inputError: '', error: null, result: null });
  render();
  try { v.result = await api.tts(v.text, 'voice'); } catch (e) { v.error = toApiError(e); }
  v.busy = false; renderIf('create', 'voice');
}

/* ================= 知识库 ================= */
async function uploadFiles(fileList) {
  const k = state.kb;
  const files = [...fileList];
  if (!files.length) return;
  k.uploads = k.uploads.filter((u) => u.state === 'uploading');
  const items = files.map((f) => ({ name: f.name, file: f, state: 'uploading', progress: 0, message: '' }));
  for (const it of items) {
    if (!/\.(txt|md|markdown)$/i.test(it.name)) Object.assign(it, { state: 'error', message: '暂只支持 .txt / .md 文件' });
    else if (it.file.size > MAX_UPLOAD_BYTES) Object.assign(it, { state: 'error', message: '文件超过 1MB，请拆分后上传' });
    else if (it.file.size === 0) Object.assign(it, { state: 'error', message: '文件是空的' });
  }
  k.uploads.push(...items);
  render();
  for (const it of items.filter((x) => x.state === 'uploading')) {
    try {
      const d = await uploadKb(it.file, { onProgress: (p) => { it.progress = p; renderIf('create', 'chat'); } });
      it.state = 'done'; k.docs = d.docs; k.loaded = true;
    } catch (e) {
      it.state = 'error'; it.message = toApiError(e).message;
    }
    renderIf('create', 'chat');
  }
  const ok = items.filter((x) => x.state === 'done').length;
  if (ok) toast(`已上传 ${ok} 份资料`);
}

async function deleteDoc(id) {
  const doc = state.kb.docs.find((d) => d.id === id);
  if (!doc || !window.confirm(`确认从知识库删除《${doc.name}》？删除后问答将不再引用它。`)) return;
  state.kb.deleting = id; render();
  try { const d = await api.kbDelete(id); state.kb.docs = d.docs; toast('已删除'); } catch (e) { toast(toApiError(e).message); }
  state.kb.deleting = null; renderIf('create', 'chat');
}

async function sendChat(question) {
  const c = state.chat;
  const q = String(question ?? c.input).trim();
  if (!q || c.streaming) return;
  if (state.kb.loaded && !state.kb.docs.length) return toast('请先上传资料');
  c.input = ''; c.lastQuestion = q;
  c.messages.push({ role: 'user', text: q });
  const m = { role: 'assistant', text: '', pending: true, sources: [], notice: '', error: null };
  c.messages.push(m);
  c.streaming = true;
  const ctrl = new AbortController(); c.abort = ctrl;
  render();
  try {
    await chatStream(q, {
      signal: ctrl.signal,
      onMeta: (meta) => { m.sources = meta.sources || []; m.notice = meta.notice || ''; renderIf('create', 'chat'); },
      onDelta: (text) => { m.text = text; renderIf('create', 'chat'); },
    });
  } catch (e) {
    if (e?.name === 'AbortError') m.text += m.text ? '（已停止）' : '已停止回答。';
    else { m.error = toApiError(e); if (e.partial) m.text = e.partial; }
  }
  m.pending = false; c.streaming = false; c.abort = null;
  renderIf('create', 'chat');
  document.getElementById('chat-input')?.focus();
}

/* ================= 通用能力体验 ================= */
function collectExpParams() {
  const cap = capById(state.exp.capId);
  const params = {};
  for (const f of cap?.experience?.fields || []) params[f.key] = state.exp.params[f.key] ?? f.default ?? '';
  return params;
}

async function runExperience() {
  const e = state.exp;
  const cap = capById(e.capId);
  if (!cap || e.running) return;
  Object.assign(e, { running: true, stage: '已提交', queued: false, error: null, result: null, taskId: null, startedAt: Date.now() });
  render(); startTicker();
  try {
    const r = await api.runCapability(cap.id, collectExpParams());
    if (r.sync) { e.result = r.result; }
    else { e.taskId = r.taskId; e.result = await pollExperience(); }
    e.running = false;
    if (state.view === 'experience') { render(); document.getElementById('exp-result-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  } catch (err) {
    e.running = false;
    e.error = err?.name === 'AbortError'
      ? new ApiError({ message: '已停止等待。', hint: `任务仍在继续处理（编号 ${e.taskId}），需要时可以继续等待结果。`, action: 'resume' })
      : toApiError(err);
    renderIf('experience');
  }
}

async function pollExperience() {
  const e = state.exp;
  const ctrl = new AbortController(); e.abort = ctrl;
  try {
    return await pollTask(e.taskId, {
      endpoint: 'capability/task', mode: state.mode, signal: ctrl.signal, startedAt: e.startedAt,
      onProgress: ({ status, queued }) => {
        const stage = stageLabel(status, queued);
        if (stage !== e.stage || queued !== e.queued) { e.stage = stage; e.queued = queued; renderIf('experience'); }
      },
    });
  } finally { e.abort = null; }
}

async function resumeExperience() {
  const e = state.exp;
  if (!e.taskId) return runExperience();
  Object.assign(e, { running: true, error: null, startedAt: Date.now() });
  render(); startTicker();
  try { e.result = await pollExperience(); } catch (err) { e.error = err?.name === 'AbortError' ? null : toApiError(err); }
  e.running = false; renderIf('experience');
}

function saveExperience(btn) {
  const r = state.exp.result;
  const cap = capById(state.exp.capId);
  if (!r || !cap) return;
  const out = r.output;
  const kind = ['video', 'audio', 'image'].includes(out) ? out : 'text';
  const { persisted } = addWork({
    kind, type: cap.name, title: r.title || cap.name, mode: r.mode,
    url: r.videoUrl || r.audioUrl || r.imageUrl || '',
    text: kind === 'text' ? (r.jsonText || r.text || '') : '',
    duration: r.duration || (r.durationMs ? r.durationMs / 1000 : null),
  });
  saved(persisted, btn);
}

function copyExperience() {
  const r = state.exp.result;
  const t = r?.jsonText || r?.text || '';
  if (!navigator.clipboard?.writeText) return toast('当前浏览器不支持自动复制，请手动选择文本复制');
  navigator.clipboard.writeText(t).then(() => toast('已复制'), () => toast('复制失败，请手动选择文本复制'));
}

/* ================= 环境切换 ================= */
async function confirmMode() {
  const next = state.mode === 'real' ? 'mock' : 'real';
  state.dialog = null; state.modeSwitching = true; state.modeError = null;
  render();
  try {
    state.config = await api.switchMode(next);
    setMode(next); state.mode = next;
    state.token = { loading: false, data: null, error: null };
    toast(next === 'real' ? '已切换到真实环境' : '已切换到演示环境');
    if (state.view === 'settings' && next === 'real') loadToken();
  } catch (e) {
    state.modeError = toApiError(e);
  }
  state.modeSwitching = false;
  render();
}

/* ================= 新手引导 ================= */
function highlightTour() {
  document.querySelectorAll('.tour-target').forEach((el) => el.classList.remove('tour-target'));
  let i = state.tour;
  while (i >= 0 && !document.querySelector(TOUR_STEPS[i].selector)) i = nextTourStep(i);
  if (i !== state.tour) { state.tour = i; if (i < 0) markTourDone(localStorage); return render(); }
  const el = document.querySelector(TOUR_STEPS[i].selector);
  el?.classList.add('tour-target');
}

/* ================= 后台控制器 ================= */
const admin = createAdminController({ state, render, toast, go, refreshMe });

/* ================= 事件：统一委托，只绑定一次 ================= */
const actions = {
  ...admin.actions,
  'open-mode': () => { state.dialog = { type: 'mode' }; render(); },
  'close-dialog': () => { state.dialog = null; render(); },
  'confirm-mode': confirmMode,
  'reload-config': loadConfig,
  'fill-sample': () => { state.video.text = SAMPLE_TEXT; state.video.inputError = ''; render(); },
  'run-video': runVideo,
  'stop-video': () => state.video.abort?.abort(),
  'resume-video': resumeVideo,
  'save-video': (btn) => {
    const r = state.video.result; if (!r) return;
    saved(addWork({ kind: 'video', type: '视频口播', title: state.video.text.slice(0, 20), url: r.videoUrl, duration: r.duration, mode: r.mode }).persisted, btn);
  },
  'run-voice': runVoice,
  'save-voice': (btn) => {
    const r = state.voice.result; if (!r) return;
    saved(addWork({ kind: 'audio', type: '语音合成', title: state.voice.text.slice(0, 20), url: r.audio_url, duration: r.duration_ms / 1000, mode: r.mode }).persisted, btn);
  },
  'kb-reload': () => loadKb(true),
  'chat-send': () => sendChat(),
  'chat-stop': () => state.chat.abort?.abort(),
  'chat-retry': () => sendChat(state.chat.lastQuestion),
  'works-clear': () => {
    if (!window.confirm('确认清空全部作品记录？只会清除本机记录，不影响平台上的文件。')) return;
    clearWorks(); state.works = []; render(); toast('已清空');
  },
  'exp-run': runExperience,
  'exp-stop': () => state.exp.abort?.abort(),
  'exp-resume': resumeExperience,
  'exp-reset': () => { state.exp.params = {}; state.exp.error = null; render(); },
  'exp-save': saveExperience,
  'exp-copy': copyExperience,
  'token-fetch': () => loadToken(false),
  'token-force': () => loadToken(true),
  'nav-collapse': () => { state.navCollapsed = !state.navCollapsed; try { localStorage.setItem('ruying-nav-collapsed', state.navCollapsed ? '1' : '0'); } catch { /* ignore */ } render(); },
  'tour-next': () => { const n = nextTourStep(state.tour); if (n < 0) markTourDone(localStorage); state.tour = n; render(); },
  'tour-skip': () => { state.tour = -1; markTourDone(localStorage); render(); },
};

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-action],[data-group],[data-filter],[data-use],[data-experience],[data-create],[data-mode],[data-del],[data-work-view],[data-kb-del],[data-skip],[data-module],[data-module-group],[data-module-all],[data-quick-days],[data-quick-extend],[data-user-act],[data-vendor-act],[data-key-revoke]');
  if (!t) return;
  if (admin.click(t)) return;
  const d = t.dataset;
  if (d.skip !== undefined) { ev.preventDefault(); document.getElementById('main')?.focus(); return; }
  if (d.action) { ev.preventDefault(); actions[d.action]?.(t); return; }
  if (d.group) { state.capFilter = d.group; return go('capabilities'); }
  if (d.filter) { state.capFilter = d.filter; return render(); }
  if (d.use) { location.hash = `#experience/${d.use}`; return; }
  if (d.experience) { state.createTab = d.experience; return go('create'); }
  if (d.create) {
    state.createTab = d.create;
    if (d.create === 'chat') loadKb();
    if (d.create !== 'video') state.tour = -1;
    render();
    viewRoot.querySelector(`[data-create="${d.create}"]`)?.focus();
    return;
  }
  if (d.mode) { if (d.mode !== state.mode) { state.dialog = { type: 'mode' }; render(); } return; }
  if (d.del) {
    if (!window.confirm('确认删除这条作品记录？')) return;
    removeWork(d.del); state.works = listWorks(); render(); toast('已删除');
    return;
  }
  if (d.workView) { const w = getWork(d.workView); if (w) { state.dialog = { type: 'work', work: w }; render(); } return; }
  if (d.kbDel) deleteDoc(d.kbDel);
});

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.bind) {
    const parts = el.dataset.bind.split('.');
    const key = parts.pop();
    const obj = parts.reduce((o, k) => o?.[k], state);
    if (!obj) return;
    obj[key] = el.type === 'checkbox' ? el.checked : el.value;
    if (el.dataset.live !== undefined || el.type === 'checkbox' || el.type === 'radio') render();
    const scope = parts[0];
    if (parts.length === 1 && (scope === 'video' || scope === 'voice')) {
      state[scope].inputError = '';
      const n = words(el.value);
      const counter = document.getElementById(`${scope}-count`);
      if (counter) {
        counter.textContent = scope === 'video' ? `${n} / 200 字 · 约 ${estimateSeconds(el.value)} 秒` : `${n} / 200 字`;
        counter.classList.toggle('pill--err', n > 200); counter.classList.toggle('pill--info', n <= 200);
      }
    }
  } else if (el.dataset.field) {
    state.exp.params[el.dataset.field] = el.value;
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.dialog && state.dialog.type !== 'cred') { state.dialog = null; render(); envSwitch.focus(); return; }
  if (ev.key === 'Enter' && ev.target.id === 'chat-input' && !ev.isComposing) { ev.preventDefault(); sendChat(); }
  if (ev.key === 'Tab' && state.dialog) { // 弹窗内循环焦点
    const f = [...overlayRoot.querySelectorAll('button:not([disabled]), a[href]')];
    if (!f.length) return;
    if (ev.shiftKey && document.activeElement === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); }
    else if (!ev.shiftKey && document.activeElement === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
  }
});

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-form]');
  if (!form) return;
  ev.preventDefault();
  admin.forms[form.dataset.form]?.(form);
});

document.addEventListener('change', (ev) => {
  // select / date 控件在 change 时同步（部分浏览器不触发 input）
  const el = ev.target;
  if (el.dataset?.bind && (el.tagName === 'SELECT' || el.type === 'date')) {
    const parts = el.dataset.bind.split('.'); const key = parts.pop();
    const obj = parts.reduce((o, k) => o?.[k], state);
    if (obj) { obj[key] = el.value; if (el.dataset.live !== undefined) render(); }
  }
  if (ev.target.id === 'kb-file') { uploadFiles(ev.target.files); ev.target.value = ''; }
});

// 拖拽上传：只在投放区生效；页面其他位置松手不让浏览器直接打开文件
const inDrop = (ev) => ev.target.closest?.('[data-dropzone]');
for (const type of ['dragenter', 'dragover']) {
  document.addEventListener(type, (ev) => {
    ev.preventDefault();
    const over = !!inDrop(ev);
    if (over !== state.kb.dragging) { state.kb.dragging = over; inDrop(ev)?.classList.add('is-drag'); if (!over) viewRoot.querySelector('[data-dropzone]')?.classList.remove('is-drag'); }
  });
}
document.addEventListener('dragleave', (ev) => { if (inDrop(ev) && !inDrop({ target: ev.relatedTarget || document.body })) { state.kb.dragging = false; inDrop(ev).classList.remove('is-drag'); } });
document.addEventListener('drop', (ev) => {
  ev.preventDefault();
  state.kb.dragging = false;
  viewRoot.querySelector('[data-dropzone]')?.classList.remove('is-drag');
  if (inDrop(ev) && ev.dataTransfer?.files?.length) uploadFiles(ev.dataTransfer.files);
});

window.addEventListener('hashchange', applyRoute);

/* ================= 启动 ================= */
document.title = `${PRODUCT.name} · ${PRODUCT.vendor}`;
render();
refreshMe().then(applyRoute);
