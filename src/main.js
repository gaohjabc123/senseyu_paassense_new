// main.js —— 如影 AI 能力开放平台 前端入口
// 渲染策略：顶栏、页脚（含双 logo）只在启动时渲染一次；之后状态变化只更新内容区与覆盖层，
// 环境开关只改文字和样式，logo 图片元素永远不会被重建。事件统一委托在 document 上，只绑定一次。
import './style.css';
import { PRODUCT, DEFAULT_VIEW, SITE_VIEWS, navById, SHORTCUT_MODULE } from './lib/product.js';
import { TOUR_STEPS, nextTourStep, shouldShowTour, markTourDone } from './lib/guide.js';
import { validateText, estimateSeconds, stageLabel, EXPERIENCES, expTabCap } from './lib/wizard.js';
import { api, ApiError, getMode, setMode, pollTask, uploadKb, uploadMedia, chatStream, toApiError } from './lib/api.js';
import { listWorks, addWork, removeWork, renameWork, clearWorks } from './lib/works.js';
import { capById } from './lib/capabilities.js';
import { words } from './lib/html.js';
import * as V from './lib/views.js';
import { experienceView, NEXT_STEPS } from './lib/experience.js';
import { loadRecent, saveRecent, extractRecent } from './lib/recent.js';
import { routeKey, pushNav, popNav } from './lib/navstack.js';
import { initialAdminState, parseAdminHash, renderAdminRoute, ADMIN_ROUTES, credentialDialog, createAdminController } from './lib/admin.js';

const SAMPLE_TEXT = '新款智能手表今天上市，支持全天心率监测、睡眠分析与运动记录，轻巧续航七天，欢迎到店体验。';
const MAX_UPLOAD_BYTES = 1024 * 1024;

const state = {
  view: DEFAULT_VIEW,
  mode: getMode(),
  navCollapsed: (() => { try { return localStorage.getItem('ruying-nav-collapsed') === '1'; } catch { return false; } })(),
  config: null, configError: null,
  voiceOptions: null, voiceListFailed: false, // 平台发音人列表（/api/voice/list）：null=未加载，[]=加载失败或为空
  avatarOptions: null, avatarListFailed: false, // 平台公共形象列表（/api/avatar/list）：null=未加载，[]=加载失败或为空
  taskCenter: { status: 'all', cap: 'all', q: '', list: [], total: 0, loading: false, error: null, imported: false }, // 任务中心列表与筛选
  modeSwitching: false, modeError: null,
  capFilter: 'all',
  createTab: 'video',
  video: { text: '新款智能手表今天上市，支持全天心率监测与运动记录，欢迎了解。', imageUrl: '', phase: 'idle', stage: '', queued: false, startedAt: 0, taskId: null, error: null, inputError: '', result: null, abort: null },
  voice: { text: '大家好，欢迎使用如影 AI 能力开放平台。', qid: '', qidInput: '', speed: 1.25, volume: 200.5, pitch: 0, busy: false, error: null, inputError: '', result: null },
  kb: { loaded: false, loading: false, loadError: null, docs: [], uploads: [], dragging: false, deleting: null },
  chat: { messages: [], input: '', streaming: false, abort: null, lastQuestion: '' },
  exp: { capId: null, params: {}, running: false, stage: '', queued: false, startedAt: 0, taskId: null, error: null, result: null, abort: null },
  expPrefill: null, // 「下一步」带入的参数：跳到目标能力时一次性填入（applyRoute 里消费）
  recent: loadRecent(), // 上次的结果（本机）：上次合成的音频 / 上次训好的形象 / 上次复刻的 QID
  backStack: [], // 返回栈：走过的页面（本机内存，刷新清空），「返回」按钮按它回上一个页面
  token: { loading: false, data: null, error: null },
  works: listWorks(), worksError: null, localWorkCount: 0,
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
  const key = JSON.stringify([state.me?.user?.id, state.me?.user?.displayName, state.me?.tenant?.name, state.me?.user?.role]);
  if (key !== userSlotKey) { userSlotKey = key; userSlot.innerHTML = V.userSlotHtml(state.me); }
}

/* ================= 渲染：只更新内容区 ================= */
const adminTitle = (v) => { const r = ADMIN_ROUTES[v]; return r ? (state.me?.teaching?.isSchool && r.schoolTitle) || r.title : ''; };
const CONSOLE_TITLE = { overview: '工作台总览', create: '创作中心', taskcenter: '任务中心', tasks: '我的作品', settings: '环境与配置', experience: '能力体验' };
/* 站内页（产品）与登录页：站内页进统一壳但不显示工作台标题栏；登录页保持全宽 */
const isSiteLayout = (v) => v === 'login';
const isSitePage = (v) => SITE_VIEWS.includes(v);
const isWorkspace = (v) => ['overview', 'create', 'taskcenter', 'tasks', 'settings', 'experience'].includes(v);
const userSlot = document.getElementById('user-slot');
let userSlotKey = null;

function pageHtml() {
  const s = state;
  if (ADMIN_ROUTES[s.view]) return renderAdminRoute(s);
  if (s.view === 'experience') {
    const cap = capById(s.exp.capId);
    if (cap && s.me && !V.canUse(s, cap.id)) return `<div class="console">${V.errorBlock({ message: `你的企业未开通「${cap.name}」。`, hint: '如需使用，请联系你的企业管理员或商予科技开通。', action: 'contact' })}</div>`;
    return cap ? experienceView(s, cap) : `<div class="console">${V.errorBlock({ message: '没有找到这项能力。', hint: '请回到能力矩阵重新选择。', action: 'config' })}</div>`;
  }
  const page = {
    home: V.homeView, capabilities: V.capabilitiesView, scenarios: V.scenariosView, integration: V.integrationView,
    overview: V.overviewView, create: V.createView, taskcenter: V.taskCenterView, tasks: V.tasksView, settings: V.settingsView,
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
  const isSitePageNow = isSitePage(state.view);
  const accessNote = isWorkspace(state.view) ? V.accessBanner(state) : '';
  const banner = state.configError ? `<div class="page-banner">${V.errorBlock(state.configError, { retry: 'reload-config' })}</div>` : accessNote ? `<div class="page-banner">${accessNote}</div>` : '';
  viewRoot.className = `view-root ${isSite ? 'view-root--site' : 'view-root--console'}`;
  viewRoot.innerHTML = isSite
    ? `<main id="main" tabindex="-1" class="site-main">${banner}${pageHtml()}</main>`
    : `<div class="console-shell${state.navCollapsed ? ' nav-collapsed' : ''}">${V.sidenav(state)}<main id="main" tabindex="-1" class="console-main">${banner}${isSitePageNow ? '' : V.consoleBar(state, CONSOLE_TITLE[state.view] || adminTitle(state.view) || '工作台')}${pageHtml()}</main></div>`;

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
  const link = viewRoot.querySelector('.sidenav [data-view="tasks"]');
  if (!link) return;
  let em = link.querySelector('em');
  if (!em) { em = document.createElement('em'); link.appendChild(em); }
  em.textContent = String(state.works.length);
  em.setAttribute('aria-label', `${state.works.length} 个作品`);
}

/* ================= 作品：登录后保存在账号里（服务端），访客保存在本机浏览器 ================= */
const remoteWorks = () => !!state.me?.user;
const decorateWork = (w) => ({ ...w, remote: true, days: null, createdAt: new Date(w.at).toLocaleString('zh-CN', { hour12: false }) });
const worksKey = () => JSON.stringify(state.works.map((w) => [w.id, w.title, w.submittedAt, w.review?.at]));
const findWork = (id) => state.works.find((w) => w.id === id) || null;

/** 重新读取作品列表；返回列表是否有变化（用于决定要不要重渲染） */
async function reloadWorks() {
  const before = worksKey();
  if (!remoteWorks()) { state.works = listWorks(); state.worksError = null; state.localWorkCount = 0; }
  else {
    try { state.works = (await api.works.list()).map(decorateWork); state.worksError = null; }
    catch (e) { state.worksError = toApiError(e); }
    state.localWorkCount = listWorks().length; // 这台电脑上未登录时保存的作品，可以导入到账号
  }
  updateWorksBadge();
  return before !== worksKey();
}

/** 保存一条作品；返回 { ok, duplicate, remote, persisted, error } */
async function saveWork(input) {
  if (!remoteWorks()) {
    const r = addWork(input);
    state.works = listWorks(); updateWorksBadge();
    return { ok: true, duplicate: !!r.duplicate, remote: false, persisted: r.persisted };
  }
  try {
    const r = await api.works.add(input);
    if (!r.duplicate) state.works = [decorateWork(r.work), ...state.works];
    updateWorksBadge();
    return { ok: true, duplicate: r.duplicate, remote: true, persisted: true };
  } catch (e) { return { ok: false, error: toApiError(e) }; }
}

function saved(r, btn) {
  if (!r.ok) { toast(`没有保存成功：${r.error.message}${r.error.hint ? ` ${r.error.hint}` : ''}`); return; }
  toast(r.remote ? (r.duplicate ? '这条作品已经在「我的作品」里了' : '已保存到「我的作品」，换电脑登录也能找回')
    : r.persisted ? '已保存到「我的作品」，7 天内可在本机找回；登录后保存可长期保留' : '浏览器禁止本地存储，作品只在本次打开期间有效');
  if (btn) { btn.textContent = '已保存'; btn.disabled = true; }
}

/** 对一条服务端作品执行操作（改名 / 删除 / 提交 / 撤回），失败时给出可读提示 */
async function workOp(fn, okText) {
  try { await fn(); await reloadWorks(); render(); if (okText) toast(okText); }
  catch (e) { const err = toApiError(e); toast(err.message + (err.hint ? ` ${err.hint}` : '')); }
}

/* ================= 路由（hash） ================= */
function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (h.startsWith('experience/')) return { view: 'experience', capId: h.slice(11) };
  const adm = parseAdminHash(h);
  if (adm) return adm;
  if (h === 'catalog') return { view: 'capabilities' }; // 能力目录已并进能力矩阵，旧链接/书签直接跳过去
  if (navById(h)) return { view: h };
  return { view: DEFAULT_VIEW };
}
let navFromGo = false; // 本轮 applyRoute 是站内 go() 触发的（栈已在 go 里压好，不再重复压）
function go(view, { push = true } = {}) {
  const target = `#${view}`;
  if (push) state.backStack = pushNav(state.backStack, routeKey(state.route), view);
  navFromGo = true;
  if (location.hash === target) applyRoute(); else location.hash = target;
}
function applyRoute() {
  const prevKey = routeKey(state.route);
  const r = parseHash();
  const nextKey = routeKey(r);
  // 浏览器前进/后退或手输 hash：后退时把已回到的那页弹出栈，前进时把上一页压栈
  if (navFromGo) navFromGo = false;
  else if (nextKey === (state.backStack[state.backStack.length - 1] || null)) state.backStack = popNav(state.backStack)[1];
  else if (prevKey !== nextKey) state.backStack = pushNav(state.backStack, prevKey, nextKey);
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
    if (state.expPrefill?.capId === r.capId) { state.exp.params = { ...state.expPrefill.params }; state.expPrefill = null; }
  }
  if (r.view === 'tasks' || r.view === 'overview') reloadWorks().then((changed) => { if (changed && state.view === r.view && !state.dialog) render(); });
  if (r.view === 'create' && state.me) {
    const allowed = EXPERIENCES.filter((e) => V.canUse(state, SHORTCUT_MODULE[e.id])).map((e) => e.id);
    if (allowed.length && !allowed.includes(state.createTab)) state.createTab = allowed[0];
    enterExpTab(state.createTab);
  }
  if ((r.view === 'overview' && V.canUse(state, SHORTCUT_MODULE.chat)) || (r.view === 'create' && state.createTab === 'chat')) loadKb();
  if ((r.view === 'experience' && r.capId === 'voice-tts') || r.view === 'create') loadVoiceList();
  if ((r.view === 'experience' && r.capId === 'video-script') || r.view === 'create') loadAvatarList();
  if (r.view === 'taskcenter') loadTaskCenter();
  if (r.view !== 'taskcenter') stopTaskCenterTimer();
  if (r.view === 'settings' && state.mode === 'real') loadToken();
  if (r.view === 'create' && state.createTab === 'video' && state.tour < 0 && shouldShowTour(localStorage)) state.tour = 0;
  if (r.view !== 'create') state.tour = -1;
  render();
  if (changed) { window.scrollTo(0, 0); document.getElementById('main')?.focus({ preventScroll: true }); }
}

/* ================= 数据加载 ================= */
/** 发音人列表：只拉一次（服务端 10 分钟缓存），失败时留空数组、下拉框退回默认音色 */
let voiceListLoading = false;
async function loadVoiceList() {
  if (state.voiceOptions || voiceListLoading) return;
  voiceListLoading = true;
  try {
    const d = await api.voiceList();
    state.voiceOptions = Array.isArray(d?.voices) ? d.voices : [];
    state.voiceListFailed = false;
  } catch { state.voiceOptions = []; state.voiceListFailed = true; }
  voiceListLoading = false;
  render();
}

/* ================= 系统形象列表 ================= */
/** 公共形象列表：只拉一次（服务端 10 分钟缓存），失败时留空数组、选择器退回手动填写 */
let avatarListLoading = false;
async function loadAvatarList() {
  if (state.avatarOptions || avatarListLoading) return;
  avatarListLoading = true;
  try {
    const d = await api.avatarList();
    state.avatarOptions = Array.isArray(d?.avatars) ? d.avatars : [];
    state.avatarListFailed = false;
  } catch { state.avatarOptions = []; state.avatarListFailed = true; }
  avatarListLoading = false;
  render();
}

/** 环境或登录人变了：发音人/系统形象列表按新身份重拉。
 * 否则先在演示环境打开过页面、再登录切到真实环境，下拉框仍显示演示的 8 个样例
 * （loadAvatarList/loadVoiceList 只在列表为空时才拉，旧列表不为空就直接返回）。 */
function resetOptionLists() {
  state.avatarOptions = null; state.avatarListFailed = false;
  state.voiceOptions = null; state.voiceListFailed = false;
  loadAvatarList(); loadVoiceList();
}

/* ================= 任务中心 ================= */
/** 任务中心列表：首次打开先把这台浏览器里存过的任务编号导入一次（真实环境），再按筛选拉列表 */
async function loadTaskCenter() {
  const tc = state.taskCenter;
  if (tc.loading) return;
  tc.loading = true; tc.error = null;
  if (state.view === 'taskcenter') render();
  try {
    if (!tc.imported) {
      tc.imported = true;
      try {
        const raw = JSON.parse(localStorage.getItem(TASK_HISTORY_KEY) || '[]');
        const ids = (Array.isArray(raw) ? raw : []).map((x) => x.id).filter(Boolean);
        if (ids.length && state.mode === 'real') await api.taskImport(ids);
      } catch { /* 导入失败不挡列表 */ }
    }
    const d = await api.taskList({ status: tc.status === 'all' ? '' : tc.status, capability: tc.cap === 'all' ? '' : tc.cap, q: tc.q || '' });
    tc.list = d.tasks || []; tc.total = d.total || 0;
  } catch (e) { tc.error = toApiError(e); }
  tc.loading = false;
  if (state.view !== 'taskcenter') return;
  render();
  if ((tc.list || []).some((t) => t.status === 1 || t.status === 2)) startTaskCenterTimer();
}

/** 未完成的任务每 15 秒自动刷新一次状态，跑完自动停；离开任务中心即停 */
let taskCenterTimer = null;
function startTaskCenterTimer() {
  if (taskCenterTimer) return;
  taskCenterTimer = setInterval(() => {
    if (state.view !== 'taskcenter') { stopTaskCenterTimer(); return; }
    if ((state.taskCenter.list || []).some((t) => t.status === 1 || t.status === 2)) loadTaskCenter();
    else stopTaskCenterTimer();
  }, 15000);
}
function stopTaskCenterTimer() { if (taskCenterTimer) { clearInterval(taskCenterTimer); taskCenterTimer = null; } }

async function loadConfig() {
  state.configError = null;
  try {
    state.config = await api.config();
  } catch (e) {
    const err = toApiError(e);
    if (err.code === 'REAL_NOT_CONFIGURED' && state.mode === 'real') {
      setMode('mock'); state.mode = 'mock';
      resetOptionLists();
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
    resetOptionLists();
  }
  if (state.mode === 'real' && !state.me.access?.canReal) { setMode('mock'); state.mode = 'mock'; }
  await reloadWorks();
  seedCompletedProbeTasks();
  syncTaskHistory();
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
    const created = await api.avatar({ text: v.text, audioUrl: tts.audio_url, duration: Math.max(1, Math.round((tts.duration_ms || estimateSeconds(v.text) * 1000) / 1000)), imageUrl: v.imageUrl || '' });
    v.taskId = created.taskId;
    rememberTaskId(v.taskId, 'video');
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
    const autoSaved = await autoSaveVideo(result, v.text);
    renderIf('create', 'video');
    toast(autoSaved ? '视频生成完成，已自动保存到我的作品' : '视频生成完成');
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
  const check = validateText(v.text, 4, 2000);
  if (!check.ok) { v.inputError = check.message; return render(); }
  Object.assign(v, { busy: true, inputError: '', error: null, result: null });
  render();
  try { v.result = await api.tts(v.text, 'voice', { qid: (v.qidInput || '').trim() || v.qid || undefined, speedRatio: Number(v.speed ?? 1.25), volume: Number(v.volume ?? 200.5), pitchOffset: Number(v.pitch ?? 0) }); if (state.mode === 'real' && v.result?.audio_url) state.recent = saveRecent({ audioUrl: v.result.audio_url }); } catch (e) { v.error = toApiError(e); }
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

/** 能力表单里的素材上传：传到本站，得到绝对地址后填进对应字段（多行 textarea 追加一行）；
 * 多图字段一次可多选，按字段的 maxItems 封顶（图片编辑最多 3 张，与服务端 1~3 张校验一致）。 */
async function uploadMediaField(input) {
  const files = [...(input.files || [])];
  const field = input.dataset.uploadField;
  const kind = input.dataset.kind || 'image';
  if (!files.length || !field) return;
  const btn = document.querySelector(`[data-action="exp-upload"][data-field="${field}"]`);
  const label = btn?.textContent || '上传文件';
  const def = capById(state.exp.capId)?.experience?.fields?.find((f) => f.key === field);
  const maxItems = Number(def?.maxItems || 0);
  const currentCount = () => String(state.exp.params[field] ?? document.querySelector(`[data-field="${field}"]`)?.value ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
  let done = 0;
  for (const file of files) {
    if (file.size === 0) { toast('文件是空的'); continue; }
    if (maxItems && currentCount() >= maxItems) { toast(`最多 ${maxItems} 张图片`); break; }
    if (btn) { btn.disabled = true; btn.textContent = '上传中…'; }
    try {
      const d = await uploadMedia(file, { kind, onProgress: (p) => { if (btn) btn.textContent = `上传中 ${p}%`; } });
      const url = new URL(d.url, location.href).href;
      const el = document.querySelector(`[data-field="${field}"]`);
      const cur = String(state.exp.params[field] ?? el?.value ?? '');
      state.exp.params[field] = el?.tagName === 'TEXTAREA' && cur.trim() ? `${cur.replace(/\s+$/, '')}\n${url}` : url;
      done += 1;
    } catch (e) {
      const err = toApiError(e);
      toast(err.message + (err.hint ? ` ${err.hint}` : ''));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }
  if (done) { render(); toast(files.length > 1 ? `已上传 ${done} 张，地址已填入表单` : '已上传，地址已填入表单'); }
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

/** 切到嵌通用体验器的快捷入口时，把 exp 状态切到对应能力（已是该能力时保留表单与结果） */
function enterExpTab(tabId) {
  const cap = expTabCap(tabId);
  if (!cap) return;
  if (state.exp.capId !== cap) {
    state.exp.abort?.abort();
    state.exp = { capId: cap, params: {}, running: false, stage: '', queued: false, startedAt: 0, taskId: null, error: null, result: null, abort: null };
  }
}

/** 通用体验器当前是否可见：体验页，或创作中心里正嵌着它的那个标签页 */
const expVisible = () => state.view === 'experience' || (state.view === 'create' && expTabCap(state.createTab) === state.exp.capId);

async function runExperience() {
  const e = state.exp;
  const cap = capById(e.capId);
  if (!cap || e.running) return;
  Object.assign(e, { running: true, stage: '已提交', queued: false, error: null, result: null, taskId: null, startedAt: Date.now() });
  render(); startTicker();
  try {
    const r = await api.runCapability(cap.id, collectExpParams());
    if (r.sync) { e.result = r.result; }
    else { e.taskId = r.taskId; rememberTaskId(e.taskId, 'experience'); e.result = await pollExperience(); }
    e.running = false;
    rememberResult(cap.id, e.result);
    const expAutoSaved = await autoSaveExperience();
    if (expVisible()) { render(); document.getElementById('exp-result-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    if (expAutoSaved) toast('已自动保存到我的作品');
  } catch (err) {
    e.running = false;
    e.error = err?.name === 'AbortError'
      ? new ApiError({ message: '已停止等待。', hint: `任务仍在继续处理（编号 ${e.taskId}），需要时可以继续等待结果。`, action: 'resume' })
      : toApiError(err);
    if (expVisible()) render();
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
        if (stage !== e.stage || queued !== e.queued) { e.stage = stage; e.queued = queued; if (expVisible()) render(); }
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
  e.running = false; rememberResult(e.capId, e.result); if (expVisible()) render();
}

/** 记住这次的结果（只记真实环境）：下次进表单一点就能填上 */
function rememberResult(capId, result) {
  const patch = extractRecent(capId, result);
  if (patch) state.recent = saveRecent(patch);
}

/** 任务完成自动保存：只存真实环境的媒体结果，演示样例不自动进作品。
 * 返回 true 表示新存了一条；已存在（去重）或不满足条件返回 false。 */
async function autoSaveVideo(result, text) {
  if (!result || result.mode !== 'real' || !result.videoUrl) return false;
  const r = await saveWork({ kind: 'video', type: '视频口播', title: String(text || '').slice(0, 20) || '视频口播', url: result.videoUrl, duration: result.duration, mode: result.mode });
  return r.ok && !r.duplicate;
}

async function autoSaveExperience() {
  const r = state.exp.result;
  const cap = capById(state.exp.capId);
  if (!r || !cap || r.mode !== 'real') return false;
  const url = r.videoUrl || r.audioUrl || r.imageUrl || '';
  if (!url) return false; // 纯文字结果不自动保存，手动点保存才进作品
  const out = r.output;
  const kind = ['video', 'audio', 'image'].includes(out) ? out : 'text';
  const res = await saveWork({
    kind, type: cap.name, title: r.title || cap.name, mode: r.mode, url,
    text: kind === 'text' ? (r.jsonText || r.text || '') : '',
    duration: r.duration || (r.durationMs ? r.durationMs / 1000 : null),
  });
  return res.ok && !res.duplicate;
}

/** 一次性补录：把平台上已知的已完成视频任务补进作品（超管首次打开时）。
 * 2026-11-13：除 11-11 三个测试任务外，7023071 与 7023472 也已完成（12.24 秒），
 * 一并补录；用新 flag（v2），已跑过旧版补录的用户也会再跑一次补齐新增的两条。
 * 只跑一次，其他用户不受影响；按 URL 去重，已在作品里的不会重复。 */
async function seedCompletedProbeTasks() {
  const FLAG = 'ruying_works_seeded_20261113_v2';
  try {
    if (state.me?.access?.kind !== 'super' || localStorage.getItem(FLAG)) return;
    const seeds = [
      { title: '口播 7003939', url: 'https://oss-aigc-prod.softsugar.com/single-img-vid/download/617/3322f49b-9fa1-434e-bd9a-2ac51204485c/3322f49b-9fa1-434e-bd9a-2ac51204485c.mp4', duration: 2.64 },
      { title: '口播 7003965', url: 'https://oss-aigc-prod.softsugar.com/single-img-vid/download/617/4161ef14-95ee-4de9-a518-d154c8b69129/4161ef14-95ee-4de9-a518-d154c8b69129.mp4', duration: 2.64 },
      { title: '口播 7003986', url: 'https://oss-aigc-prod.softsugar.com/single-img-vid/download/617/8810a098-47f2-4b3e-93a4-525d863b2074/8810a098-47f2-4b3e-93a4-525d863b2074.mp4', duration: 2.64 },
      { title: '口播 7023071（默认图实测）', url: 'https://oss-aigc-prod.softsugar.com/single-img-vid/download/617/960c18fd-0e2e-4bc8-bbcf-def8f6ab6064/960c18fd-0e2e-4bc8-bbcf-def8f6ab6064.mp4', duration: 12.24 },
      { title: '口播 7023472（智能手表）', url: 'https://oss-aigc-prod.softsugar.com/single-img-vid/download/617/e25e1544-0076-4023-80f9-7ee6f76f8aea/e25e1544-0076-4023-80f9-7ee6f76f8aea.mp4', duration: 12.24 },
    ];
    localStorage.setItem(FLAG, '1');
    for (const s of seeds) await saveWork({ kind: 'video', type: '视频口播', title: s.title, url: s.url, duration: s.duration, mode: 'real' });
  } catch { /* 本地存储不可用时静默跳过 */ }
}

/** 任务编号历史：视频任务一创建就把编号存进浏览器（最多 50 条），
 * 即使中途关掉页面，编号也不会丢；下次打开时 syncTaskHistory 会按编号
 * 逐个查一次平台，跑完的自动补进作品。 */
const TASK_HISTORY_KEY = 'ruying_task_history';
function rememberTaskId(id, kind) {
  try {
    if (id === null || id === undefined || id === '') return;
    const raw = JSON.parse(localStorage.getItem(TASK_HISTORY_KEY) || '[]');
    const list = Array.isArray(raw) ? raw : [];
    const key = String(id);
    if (list.some((x) => String(x.id) === key)) return;
    list.unshift({ id: key, kind: kind || 'video', at: Date.now() });
    localStorage.setItem(TASK_HISTORY_KEY, JSON.stringify(list.slice(0, 50)));
  } catch { /* 本地存储不可用时静默跳过 */ }
}

/** 同步任务历史：超管打开工作台时，对历史里的每个任务编号只查一次平台，
 * 已完成（status 5）且有视频地址的，自动补进作品；未完成的不动，等它跑完
 * 由自动保存接手。只在真实环境跑，失败静默跳过，不挡页面。 */
async function syncTaskHistory() {
  try {
    if (state.me?.access?.kind !== 'super' || state.mode !== 'real') return;
    const raw = JSON.parse(localStorage.getItem(TASK_HISTORY_KEY) || '[]');
    const list = Array.isArray(raw) ? raw : [];
    if (!list.length) return;
    for (const item of list) {
      try {
        const t = await api.task(item.id);
        if (t?.status === 5 && t?.result?.videoUrl) await saveWork({ kind: 'video', type: '视频口播', title: `口播 ${item.id}`, url: t.result.videoUrl, duration: t.result.duration, mode: 'real' });
      } catch { /* 单个任务查失败就跳过，不影响其他 */ }
    }
  } catch { /* 静默跳过 */ }
}

async function saveExperience(btn) {
  const r = state.exp.result;
  const cap = capById(state.exp.capId);
  if (!r || !cap) return;
  const out = r.output;
  const kind = ['video', 'audio', 'image'].includes(out) ? out : 'text';
  const res = await saveWork({
    kind, type: cap.name, title: r.title || cap.name, mode: r.mode,
    url: r.videoUrl || r.audioUrl || r.imageUrl || '',
    text: kind === 'text' ? (r.jsonText || r.text || '') : '',
    duration: r.duration || (r.durationMs ? r.durationMs / 1000 : null),
  });
  saved(res, btn);
}

function copyExperience() {
  const r = state.exp.result;
  const t = r?.jsonText || r?.text || '';
  if (!navigator.clipboard?.writeText) return toast('当前浏览器不支持自动复制，请手动选择文本复制');
  navigator.clipboard.writeText(t).then(() => toast('已复制'), () => toast('复制失败，请手动选择文本复制'));
}

/** 视频脚本 JSON 下载：把当前结果的 param 存成本地文件（控制台「导出视频合成脚本」的同款文件） */
function downloadJsonExperience() {
  const r = state.exp.result;
  const t = r?.jsonText || (r?.json ? JSON.stringify(r.json, null, 2) : '');
  if (!t) return toast('没有可下载的 JSON');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `videoScript_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([t], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`已下载 ${name}`);
}

/** 视频脚本 JSON 导入：把控制台导出的脚本（或本站下载的 JSON）回填表单；缺的字段恢复默认 */
function importVideoScriptJson(text) {
  let j;
  try { j = JSON.parse(text); } catch { return toast('JSON 解析失败，请确认文件是控制台导出的脚本'); }
  if (!j || typeof j !== 'object' || !j.digital_role || !j.tts_query) return toast('这个 JSON 不是视频合成脚本');
  const p = {};
  const set = (k, v) => { if (v !== undefined && v !== null && v !== '') p[k] = v; };
  set('videoFormat', j.video_format);
  if (j.watermark) { p.watermark = j.watermark.show === false ? '关闭' : '开启'; set('watermarkContent', j.watermark.content); }
  const dr = j.digital_role;
  set('avatarId', dr.id); set('faceFeatureId', dr.face_feature_id); set('avatarName', dr.name); set('modelUrl', dr.url);
  if (dr.position) { set('roleX', dr.position.x); set('roleY', dr.position.y); }
  set('roleScale', dr.scale); set('roleRotate', dr.rotation); set('roleVolume', dr.volume); set('roleLayer', dr.z_position);
  const tc = j.tts_config || {};
  set('qid', tc.qid); set('pitch', tc.pitch_offset); set('speed', tc.speed_ratio); set('volume', tc.volume);
  set('lines', j.tts_query.content);
  if (j.subtitle) {
    p.subtitle = j.subtitle.position ? '顶部标题' : '底部白字';
    const urls = j.subtitle.urls;
    if (typeof urls === 'string') set('subtitleUrls', urls);
    else if (Array.isArray(urls)) set('subtitleUrls', urls.join('\n'));
    set('subtitleScale', j.subtitle.scale); set('subtitleFontSize', j.subtitle.font_size);
    set('subtitleStrokeWidth', j.subtitle.stroke_width); set('subtitleOpacity', j.subtitle.opacity);
    set('subtitleMaxLen', j.subtitle.subtitle_max_len);
    if (j.subtitle.subtitle_cut_by_punc !== undefined) p.subtitleCutByPunc = j.subtitle.subtitle_cut_by_punc ? '开启' : '关闭';
    if (j.subtitle.auto_font_size !== undefined) p.subtitleAutoFontSize = j.subtitle.auto_font_size ? '开启' : '关闭';
    set('subtitleCanvasRatio', j.subtitle.sub_to_canvas_width_ratio);
  } else { p.subtitle = '无字幕'; }
  const fg = (j.foregrounds || [])[0];
  if (fg) {
    set('foregroundUrl', fg.url);
    if (Array.isArray(fg.rect)) { set('fgX', fg.rect[0]); set('fgY', fg.rect[1]); set('fgW', fg.rect[2]); set('fgH', fg.rect[3]); }
    set('fgRotate', fg.rotation); set('fgStart', fg.start); set('fgDuration', fg.duration);
  }
  const bg = (j.backgrounds || [])[0];
  if (bg) { set('bgUrl', bg.url); set('bgStart', bg.start); set('bgDuration', bg.duration); }
  const bgm = (j['background-musics'] || [])[0];
  if (bgm) { set('bgmUrl', bgm.url); set('bgmVolume', bgm.volume); if (bgm.cycle !== undefined) p.bgmCycle = bgm.cycle ? '开启' : '关闭'; }
  if (j.title) {
    set('titleText', j.title.text); set('titleScale', j.title.scale);
    if (j.title.position) { set('titleX', j.title.position.x); set('titleY', j.title.position.y); }
    set('titleRotate', j.title.rotation); set('titleFontSize', j.title.font_size); set('titleOpacity', j.title.opacity);
  }
  const ft = (j['foreground-texts'] || [])[0];
  if (ft) {
    set('fgText', ft.text); set('fgTextScale', ft.scale);
    if (ft.position) { set('fgTextX', ft.position.x); set('fgTextY', ft.position.y); }
    set('fgTextRotate', ft.rotation); set('fgTextFontSize', ft.font_size); set('fgTextOpacity', ft.opacity);
  }
  const b = j.effects?.beautify;
  if (b) {
    for (const [k, v] of Object.entries(b)) {
      if (k === 'whiten_mode') p.whitenMode = String(v);
      else if (k === 'smooth_mode') p.smoothMode = String(v);
      else p[k] = v;
    }
  }
  state.exp.params = { ...p };
  state.exp.result = null; state.exp.error = null;
  render();
  toast('已导入脚本 JSON，表单已填好');
}

/* ================= 环境切换 ================= */
async function confirmMode() {
  const next = state.mode === 'real' ? 'mock' : 'real';
  state.dialog = null; state.modeSwitching = true; state.modeError = null;
  render();
  try {
    state.config = await api.switchMode(next);
    setMode(next); state.mode = next;
    resetOptionLists();
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
  'save-video': async (btn) => {
    const r = state.video.result; if (!r) return;
    saved(await saveWork({ kind: 'video', type: '视频口播', title: state.video.text.slice(0, 20), url: r.videoUrl, duration: r.duration, mode: r.mode }), btn);
  },
  'run-voice': runVoice,
  'save-voice': async (btn) => {
    const r = state.voice.result; if (!r) return;
    saved(await saveWork({ kind: 'audio', type: '语音合成', title: state.voice.text.slice(0, 20), url: r.audio_url, duration: r.duration_ms / 1000, mode: r.mode }), btn);
  },
  'kb-reload': () => loadKb(true),
  'chat-send': () => sendChat(),
  'chat-stop': () => state.chat.abort?.abort(),
  'chat-retry': () => sendChat(state.chat.lastQuestion),
  'works-clear': async () => {
    if (!remoteWorks()) {
      if (!window.confirm('确认清空全部作品记录？只会清除本机记录，不影响平台上的文件。')) return;
      clearWorks(); state.works = []; render(); toast('已清空');
      return;
    }
    if (!window.confirm('确认清空账号里的全部作品？已提交但未批改的作品会一并撤回并删除；已批改的作品会保留。')) return;
    try { const r = await api.works.clear(); await reloadWorks(); render(); toast(r.kept ? `已清空，保留了 ${r.kept} 条已批改的作品` : '已清空'); }
    catch (e) { toast(toApiError(e).message); }
  },
  'works-reload': async () => { await reloadWorks(); render(); },
  'taskcenter-refresh': () => loadTaskCenter(),
  'taskcenter-search': () => loadTaskCenter(),
  'taskcenter-refresh-one': async (btn) => {
    const id = btn?.dataset?.task; if (!id) return;
    try { await api.task(id); } catch (e) { toast(toApiError(e).message); }
    loadTaskCenter();
  },
  // 任务中心：已完成任务的结果文件保存到作品（视频/图片/音频按链接保存）
  'taskcenter-save': async (btn) => {
    const id = btn?.dataset?.task; if (!id) return;
    const t = (state.taskCenter.list || []).find((x) => String(x.id) === String(id));
    const r = t?.result; if (!r) return;
    const input = r.output === 'video' && r.videoUrl ? { kind: 'video', type: t.capabilityName || '视频', title: t.name || t.id, url: r.videoUrl, duration: r.duration || null, mode: r.mode || state.mode }
      : r.output === 'image' && r.imageUrl ? { kind: 'image', type: t.capabilityName || '图片', title: t.name || t.id, url: r.imageUrl, mode: r.mode || state.mode }
      : r.output === 'audio' && r.audioUrl ? { kind: 'audio', type: t.capabilityName || '语音', title: t.name || t.id, url: r.audioUrl, duration: r.durationMs ? r.durationMs / 1000 : null, mode: r.mode || state.mode }
      : null;
    if (!input) { toast('这个任务没有可保存的文件链接。'); return; }
    saved(await saveWork(input), btn);
  },
  // 把这台电脑上未登录时保存的作品导入到当前账号（按地址去重），导入后清掉本机记录
  'works-import-local': async () => {
    const local = listWorks();
    if (!local.length) return;
    if (!window.confirm(`把这台电脑上未登录时保存的 ${local.length} 条作品导入到你的账号？如果这些不是你的作品，请点「取消」。`)) return;
    let done = 0;
    for (const w of local.slice().reverse()) {
      try { const r = await api.works.add({ kind: w.kind, type: w.type, title: w.title, url: w.url, text: w.text, duration: w.duration, mode: w.mode }); if (!r.duplicate) done += 1; } catch { /* 单条失败跳过 */ }
    }
    clearWorks();
    await reloadWorks(); render(); toast(`已导入 ${done} 条作品`);
  },
  'work-submit': (el) => {
    const w = findWork(el.dataset.id); if (!w) return;
    if (!window.confirm(`把「${w.title}」提交给老师批改？批改前可以撤回。`)) return;
    workOp(() => api.works.submit(w.id), '已提交，等待老师批改');
  },
  'work-withdraw': (el) => { const w = findWork(el.dataset.id); if (w) workOp(() => api.works.withdraw(w.id), '已撤回'); },
  'exp-run': runExperience,
  'exp-stop': () => state.exp.abort?.abort(),
  'exp-resume': resumeExperience,
  'exp-reset': () => { state.exp.params = {}; state.exp.error = null; render(); },
  'exp-save': saveExperience,
  'exp-copy': copyExperience,
  'exp-download-json': downloadJsonExperience,
  'exp-recent': (el) => {
    const field = el.dataset.field; const value = el.dataset.value || '';
    if (!field || !value) return;
    state.exp.params[field] = value; render(); toast('已填入上次的结果');
  },
  'exp-copy-qid': (el) => {
    const qid = el.dataset.qid || '';
    if (!qid) return;
    if (!navigator.clipboard?.writeText) return toast('当前浏览器不支持自动复制，请手动选择 QID 复制');
    navigator.clipboard.writeText(qid).then(() => toast('QID 已复制'), () => toast('复制失败，请手动选择 QID 复制'));
  },
  'exp-default-avatar': (el) => {
    const field = el.dataset.field; const value = el.dataset.value || '';
    if (!field || !value) return;
    state.exp.params[field] = value; render(); toast('已填入默认形象图');
  },
  'exp-next': (el) => {
    const step = (NEXT_STEPS[state.exp.capId] || []).find((x) => x.cap === el.dataset.cap);
    if (!step) return;
    state.expPrefill = { capId: step.cap, params: step.params(state.exp.result || {}) };
    go(`experience/${step.cap}`);
  },
  'nav-back': () => {
    const back = V.backTargetFor(state);
    if (!back) return;
    state.backStack = popNav(state.backStack || [])[1]; // 弹出已返回的那一页，避免原地打转
    go(back.target, { push: false });
  },
  'exp-upload': (el) => {
    if (!state.me?.user) { toast('请先登录再上传文件。登录后上传的素材会得到一个本站地址，直接填进表单就能用。'); return; }
    document.querySelector(`[data-upload-field="${el.dataset.field}"]`)?.click();
  },
  'exp-images-remove': (el) => {
    const field = el.dataset.field; const url = el.dataset.url || '';
    if (!field || !url) return;
    const cur = String(state.exp.params[field] ?? '');
    state.exp.params[field] = cur.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && s !== url).join('\n');
    render();
  },
  'token-fetch': () => loadToken(false),
  'token-force': () => loadToken(true),
  'nav-collapse': () => { state.navCollapsed = !state.navCollapsed; try { localStorage.setItem('ruying-nav-collapsed', state.navCollapsed ? '1' : '0'); } catch { /* ignore */ } render(); },
  'tour-next': () => { const n = nextTourStep(state.tour); if (n < 0) markTourDone(localStorage); state.tour = n; render(); },
  'tour-skip': () => { state.tour = -1; markTourDone(localStorage); render(); },
};

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-action],[data-group],[data-filter],[data-use],[data-experience],[data-create],[data-mode],[data-del],[data-rename],[data-work-view],[data-kb-del],[data-skip],[data-module],[data-module-group],[data-module-all],[data-quick-days],[data-quick-extend],[data-user-act],[data-vendor-act],[data-key-revoke],[data-class-act],[data-teach-view],[data-teach-save]');
  if (!t) return;
  if (admin.click(t)) return;
  const d = t.dataset;
  if (d.skip !== undefined) { ev.preventDefault(); document.getElementById('main')?.focus(); return; }
  if (d.action) { ev.preventDefault(); actions[d.action]?.(t); return; }
  if (d.group) { state.capFilter = d.group; return go('capabilities'); }
  if (d.filter) { state.capFilter = d.filter; return render(); }
  if (d.use) { return go(`experience/${d.use}`); }
  if (d.experience) { state.createTab = d.experience; enterExpTab(d.experience); return go('create'); }
  if (d.create) {
    state.createTab = d.create;
    enterExpTab(d.create);
    if (d.create === 'chat') loadKb();
    if (d.create !== 'video') state.tour = -1;
    render();
    viewRoot.querySelector(`[data-create="${d.create}"]`)?.focus();
    return;
  }
  if (d.mode) { if (d.mode !== state.mode) { state.dialog = { type: 'mode' }; render(); } return; }
  if (d.del) {
    const w = findWork(d.del); if (!w) return;
    if (!window.confirm(w.submittedAt ? '这条作品已提交给老师，删除后老师将看不到它。确认删除？' : '确认删除这条作品记录？')) return;
    if (w.remote) { workOp(() => api.works.remove(w.id), '已删除'); return; }
    removeWork(d.del); state.works = listWorks(); render(); toast('已删除');
    return;
  }
  if (d.rename) {
    const w = findWork(d.rename);
    if (!w) return;
    const name = window.prompt('给作品改个名字', w.title);
    if (name === null) return;
    if (!name.trim()) { toast('名字不能为空'); return; }
    if (w.remote) { workOp(() => api.works.rename(w.id, name), '已改名'); return; }
    renameWork(d.rename, name); state.works = listWorks(); render(); toast('已改名');
    return;
  }
  if (d.workView) { const w = findWork(d.workView); if (w) { state.dialog = { type: 'work', work: w }; render(); } return; }
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
    // 滑块（创作中心语音面板）：同步滑块旁的数值显示，不整页重渲染
    if (el.type === 'range') { const out = el.parentElement?.querySelector('.range-value'); if (out) out.textContent = el.value; }
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
    // 滑块字段（range）：存数值，并同步滑块旁的数值显示，不整页重渲染
    if (el.type === 'range') {
      state.exp.params[el.dataset.field] = Number(el.value);
      const out = el.parentElement?.querySelector('.range-value');
      if (out) out.textContent = el.value;
    } else if (el.type === 'checkbox') {
      const on = el.dataset.on ?? '开启'; const off = el.dataset.off ?? '关闭';
      state.exp.params[el.dataset.field] = el.checked ? on : off;
      const label = el.closest('.switch')?.querySelector('.switch-label');
      if (label) label.textContent = el.checked ? on : off;
    } else {
      state.exp.params[el.dataset.field] = el.value;
    }
    // 系统形象下拉：选一个自动填入编号与模型地址，并重渲染（填文本框、显示所选缩略图）
    if (el.dataset.field === 'avatar') {
      const picked = (state.avatarOptions || []).find((a) => String(a.faceFeatureId || '') === String(el.value || ''));
      if (picked) { state.exp.params.faceFeatureId = picked.faceFeatureId; state.exp.params.modelUrl = picked.pkgUrl || ''; state.exp.params.avatarId = picked.id ?? ''; state.exp.params.avatarName = picked.name || ''; render(); toast(`已选形象 ${picked.name || ''}，编号与模型地址已填入`); }
      else { state.exp.params.avatarId = ''; state.exp.params.avatarName = ''; }
    }
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
    if (parts[0] === 'taskCenter') loadTaskCenter(); // 任务中心筛选：选完即重拉列表
  }
  if (admin.change(el)) return;
  if (ev.target.dataset?.uploadField) { uploadMediaField(ev.target); ev.target.value = ''; return; }
  if (ev.target.dataset?.importJson !== undefined) { const f = ev.target.files?.[0]; if (f) f.text().then(importVideoScriptJson).catch(() => toast('读取文件失败')); ev.target.value = ''; return; }
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
