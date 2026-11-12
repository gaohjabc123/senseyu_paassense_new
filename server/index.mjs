// index.mjs —— 如影 AI 能力开放平台 服务端
// 单端口：静态托管 + 同源 API；演示(mock) / 真实(real) 双模式；多租户后台。
// · 访客：只能用演示环境（PUBLIC_DEMO=false 时必须登录）
// · 客户成员：按企业开通的模块与有效期使用；真实环境需开通并分配厂商凭据
// · 运行模式按请求生效（X-Ruying-Mode），一个人切换不会影响其他人
// · 密钥只在服务端；厂商 APP_KEY 加密存储；计费接口受保护
// · 所有失败统一返回 { code, message, hint, action }
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { createMock } from './mock.mjs';
import { getConfig } from './lib/config.mjs';
import { VERSION } from './lib/version.mjs';
import { TokenManager } from './lib/token.mjs';
import { createRuyingClient } from './lib/ruying.mjs';
import { KbStore } from './lib/kb.mjs';
import { answerQuestion } from './lib/answer.mjs';
import { maskValue, redactText } from './lib/mask.mjs';
import { AppError, E, toAppError, errorBody } from './lib/errors.mjs';
import { openDb } from './lib/db.mjs';
import { createTenancy, SHORTCUT_MODULE, MODULE_IDS } from './lib/tenancy.mjs';
import { createQuota, costOf, METERS } from './lib/quota.mjs';
import { CAPABILITIES, GROUPS, capById, stats, OUTPUT_LABEL } from '../src/lib/capabilities.js';

const PRODUCT_NAME = '如影 AI 能力开放平台';
const MAX_BODY = 1.5 * 1024 * 1024;
const COOKIE = 'ry_sid';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json']);
// 业务失败统一 HTTP 200 + code≠0；只有接口不存在 / 请求体过大 / 未登录 / 服务端异常使用 HTTP 错误码
const HTTP_STATUS = { API_NOT_FOUND: 404, PAYLOAD_TOO_LARGE: 413, INTERNAL: 500, UNAUTHENTICATED: 401 };
const fail = (code, message, hint = '', action = 'fix') => new AppError({ code, message, hint, action });

export function createServer({ cfg = getConfig(), fetchImpl, log = console, db: injectedDb } = {}) {
  const DIST = path.join(cfg.root, 'dist');
  const BASE = (process.env.PUBLIC_BASE_PATH || '').replace(/\/+$/, '');
  const MOCK = createMock({ taskMs: cfg.mockTaskMs });
  const kb = new KbStore(cfg.kbDir, { log: (m) => log.warn(m) });
  const db = injectedDb || openDb(cfg.dbFile);
  const Q = createQuota({ db });
  const T = createTenancy({ db, cfg, quota: Q, log: (m) => log.log(m) });
  T.bootstrap();
  try { kb.prune(); T.pruneLogs(); } catch { /* ignore */ }

  const realTasks = new Map();   // 平台任务编号 -> { owner, vendorKey, canBill }
  const loggedTasks = new Set(); // 已记录完成情况的任务
  const vendorRuntime = new Map(); // vendorKey -> { tokens, clients: Map<canBill, client> }

  /** 按厂商凭据取得（并缓存）Token 管理器与平台客户端 */
  function runtimeFor(vendorId, canBill) {
    const v = T.vendorConfig(vendorId);
    if (!v) throw fail('REAL_NOT_CONFIGURED', '真实环境的厂商凭据不可用。', '请联系商予科技检查为你的企业分配的厂商凭据。', 'contact');
    let rt = vendorRuntime.get(v.key);
    if (!rt) {
      const vcfg = { ...cfg, appId: v.appId, appKey: v.appKey, baseUrl: v.baseUrl, ttsQid: v.ttsQid, avatarImageUrl: v.avatarImageUrl };
      rt = { vcfg, tokens: new TokenManager(vcfg, { fetchImpl, log: (m) => log.log(`[ruying] ${m}`) }), clients: new Map() };
      vendorRuntime.set(v.key, rt);
    }
    if (!rt.clients.has(!!canBill)) rt.clients.set(!!canBill, createRuyingClient({ ...rt.vcfg, allowBillable: !!canBill }, rt.tokens, { fetchImpl }));
    return { key: v.key, vcfg: rt.vcfg, tokens: rt.tokens, client: rt.clients.get(!!canBill) };
  }

  /* ---------- 工具 ---------- */
  const send = (res, status, obj, headers = {}) => {
    const t = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(t), 'Cache-Control': 'no-store', ...headers });
    res.end(t);
  };
  const ok = (res, data, headers) => send(res, 200, { code: 0, message: 'success', data }, headers);
  const sendError = (res, e) => send(res, HTTP_STATUS[e.code] || 200, errorBody(e));

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0, tooLarge = false; const parts = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { tooLarge = true; parts.length = 0; return; } parts.push(c); });
    req.on('end', () => {
      if (tooLarge) return reject(fail('PAYLOAD_TOO_LARGE', '上传内容太大。', '单个文件请控制在 1MB 以内，或拆分后上传。'));
      const raw = Buffer.concat(parts).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(E.validation('请求格式不正确。')); }
    });
    req.on('error', reject);
  });

  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  const secureCookie = (req) => cfg.cookieSecure === 'true' || (cfg.cookieSecure === 'auto' && req.headers['x-forwarded-proto'] === 'https');
  const sessionCookie = (req, token, maxAge) => `${COOKIE}=${token ? encodeURIComponent(token) : ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie(req) ? '; Secure' : ''}`;

  /** 一次请求的上下文：登录信息 + 访问范围 */
  function contextOf(req) {
    const token = cookies(req)[COOKIE];
    const sess = T.resolveSession(token);
    return { token, sess, user: sess?.user || null, access: T.accessOf(sess), ip: clientIp(req) };
  }

  /** 本次请求使用的运行模式 */
  function modeOf(req, ctx) {
    const h = String(req.headers['x-ruying-mode'] || '').toLowerCase();
    if (h === 'real') {
      if (ctx.access.canReal) return 'real';
      if (ctx.access.kind === 'guest') throw fail('REAL_LOGIN_REQUIRED', '真实环境需要登录后使用。', '访客可以继续体验演示环境；已开通的客户请登录。', 'login');
      throw fail('REAL_NOT_CONFIGURED', ctx.access.kind === 'tenant' ? `暂时无法使用真实环境：${ctx.access.realReason || '企业账号当前不可用'}。` : '真实环境尚未配置，暂时无法切换。',
        ctx.access.kind === 'tenant' ? '可以继续使用演示环境；需要开通请联系商予科技。' : '需要在服务端配置如影平台的 APP_ID 与 APP_KEY。', 'config');
    }
    if (h === 'mock' || !ctx.access.canReal) return 'mock';
    return cfg.defaultMode === 'real' ? 'real' : 'mock';
  }

  function workspaceOf(req, ctx) {
    if (ctx.access.workspace) return ctx.access.workspace;
    const ws = String(req.headers['x-workspace-id'] || '');
    if (!KbStore.validWorkspace(ws)) throw fail('BAD_WORKSPACE', '缺少工作区标识。', '请刷新页面后重试。', 'retry');
    return ws;
  }

  const requireUser = (ctx) => { if (!ctx.user) throw fail('UNAUTHENTICATED', '请先登录。', '登录已过期或尚未登录。', 'login'); return ctx.user; };
  const requireRole = (ctx, ...roles) => { const u = requireUser(ctx); if (!roles.includes(u.role)) throw fail('FORBIDDEN', '没有权限访问这个页面。', '', 'contact'); return u; };

  /** 日志里的操作者：登录用户，或开放接口的密钥 */
  const actorOf = (ctx) => ({ tenantId: ctx.access.tenant?.id ?? null, userId: ctx.user?.id ?? null, username: ctx.user?.username ?? (ctx.apiKey ? `API·${ctx.apiKey.name}` : null), ip: ctx.ip });
  const categoryOf = (ctx) => (ctx.apiKey ? 'api' : 'usage');

  /** 记录一次能力调用（成功或失败）到使用日志 */
  async function track(ctx, { action, capability, mode, detail }, fn) {
    const t0 = Date.now();
    const entry = { category: categoryOf(ctx), action, capability, mode, detail, ...actorOf(ctx) };
    try {
      const r = await fn();
      T.writeLog({ ...entry, durationMs: Date.now() - t0, detail: r?.__charge ? `${detail ? detail + '；' : ''}扣减 ${r.__charge.amount} ${METERS[r.__charge.meter].unit}${METERS[r.__charge.meter].label}` : detail });
      return r;
    } catch (e) {
      const err = toAppError(e);
      T.writeLog({ ...entry, ok: false, code: err.code, durationMs: Date.now() - t0 });
      throw err;
    }
  }

  const words = (t) => [...String(t || '').replace(/\s/g, '')].length;

  /** 校验模块权限；被拒绝的调用也写入日志，方便管理员了解成员的需求 */
  function guard(ctx, moduleId, action) {
    try { T.assertModule(ctx.access, moduleId); } catch (e) {
      if (ctx.user || ctx.apiKey) T.writeLog({ category: categoryOf(ctx), action, capability: moduleId, ok: false, code: e.code, ...actorOf(ctx) });
      throw e;
    }
  }

  /**
   * 计量执行：真实环境下按客户额度预扣 → 执行 → 失败退回。
   * 演示环境、沙箱、超级管理员自测不扣额度。返回值上挂 __charge 供日志与任务失败退款使用。
   */
  async function metered(ctx, mode, cost, ref, fn) {
    const t = mode === 'real' && ctx.access.kind === 'tenant' && cost ? T.tenantRaw(ctx.access.tenant.id) : null;
    const charge = t ? Q.consume(t, cost, ref, actorOf(ctx).username) : null;
    try {
      const r = await fn(charge);
      if (charge && r && typeof r === 'object') Object.defineProperty(r, '__charge', { value: charge, enumerable: false });
      return r;
    } catch (e) { Q.refund(charge, `调用失败自动退回（${toAppError(e).code}）`); throw e; }
  }

  /* ---------- 核心能力操作（门户与开放接口共用） ---------- */
  const resolveMode = (m) => (typeof m === 'function' ? m() : m); // 先校验权限，再判断运行模式

  async function opTts(ctx, modeArg, text, purpose) {
    const module = purpose === 'video' ? SHORTCUT_MODULE.video : SHORTCUT_MODULE.voice;
    guard(ctx, module, purpose === 'video' ? 'video.tts' : 'voice.tts');
    const mode = resolveMode(modeArg);
    if (words(text) < 4) throw E.validation('文案至少 4 个字，请再写一点。');
    if (words(text) > 200) throw E.validation('文案最多 200 个字，请删减后再生成。');
    return track(ctx, { action: purpose === 'video' ? 'video.tts' : 'voice.tts', capability: module, mode }, () =>
      metered(ctx, mode, costOf('tts', { text }), 'tts', async () => (mode === 'real' ? { ...(await runtimeFor(ctx.access.vendorId, ctx.access.canBill).client.tts(String(text))), mode: 'real' } : MOCK.tts(text))));
  }

  async function opAvatar(ctx, modeArg, { text = '', audioUrl = '', duration = 0, imageUrl = '', name = '' }) {
    guard(ctx, SHORTCUT_MODULE.video, 'video.create');
    const mode = resolveMode(modeArg);
    if (!audioUrl) throw E.validation('缺少配音音频地址（audioUrl）。');
    if (!(Number(duration) > 0)) throw E.validation('时长（duration）无效。');
    return track(ctx, { action: 'video.create', capability: SHORTCUT_MODULE.video, mode }, () =>
      metered(ctx, mode, costOf('avatar', { duration }), 'video', async (charge) => {
        if (mode !== 'real') return { taskId: MOCK.createAvatarTask(), mode: 'mock' };
        const rt = runtimeFor(ctx.access.vendorId, ctx.access.canBill);
        const img = imageUrl || rt.vcfg.avatarImageUrl;
        if (!img) throw fail('AVATAR_NOT_CONFIGURED', '没有可用的数字人形象图片。', ctx.apiKey ? '请在请求里传 imageUrl（可公网访问的人像图片地址）。' : '请联系平台管理员为厂商凭据配置形象图地址。', 'config');
        if (imageUrl && !/^https?:\/\//.test(imageUrl)) throw E.validation('imageUrl 需为 http(s) 地址。');
        const taskId = await rt.client.createImageAvatar({ imageUrl: img, audioUrl, duration, videoName: String(name || `口播-${String(text).slice(0, 16)}`).slice(0, 40) });
        realTasks.set(taskId, { owner: ctx.access.workspace, vendorId: ctx.access.vendorId, capability: SHORTCUT_MODULE.video, charge });
        return { taskId, mode: 'real' };
      }));
  }

  async function opCapability(ctx, modeArg, id, params = {}) {
    const cap = capById(id);
    if (!cap) throw E.notFound('没有这项能力。', '请回到能力目录重新选择。');
    guard(ctx, cap.id, 'capability.run');
    const mode = resolveMode(modeArg);
    const cost = mode === 'real' ? costOf('capability', { capId: cap.id, params }) : null;
    return track(ctx, { action: 'capability.run', capability: cap.id, mode }, () => metered(ctx, mode, cost, cap.id, async (charge) => {
      if (mode !== 'real') return MOCK.runCapability(id, params);
      const rt = runtimeFor(ctx.access.vendorId, ctx.access.canBill);
      if (cap.id === 'voice-tts') {
        if (words(params.text) < 4) throw E.validation('文案至少 4 个字，请再写一点。');
        const r = await rt.client.tts(String(params.text));
        return { sync: true, result: { capabilityId: id, output: 'audio', title: cap.experience.mockTitle || cap.name, audioUrl: r.audio_url, durationMs: r.duration_ms, mode: 'real' } };
      }
      if (cap.id === 'video-image') {
        if (!/^https?:\/\//.test(params.imageUrl || '') || !/^https?:\/\//.test(params.audioUrl || '')) throw E.validation('真实环境需要填写可公网访问的图片和音频地址（http/https）。');
        const taskId = await rt.client.createImageAvatar({ imageUrl: params.imageUrl, audioUrl: params.audioUrl, duration: params.duration, videoName: String(params.prompt || cap.name).slice(0, 40) });
        realTasks.set(taskId, { owner: ctx.access.workspace, vendorId: ctx.access.vendorId, capability: cap.id, charge });
        return { sync: false, taskId, output: 'video', mode: 'real' };
      }
      if (cap.realApi) {
        const data = await rt.client.post(cap.realApi, params, { billable: cap.billable });
        return { sync: true, result: { capabilityId: id, output: 'json', title: `${cap.name}（平台回执）`, json: data, jsonText: JSON.stringify(data, null, 2), mode: 'real' } };
      }
      const r = MOCK.runCapability(id, params);
      const note = `「${cap.name}」需要先在如影控制台准备前置资源（模型 / 知识库 / 直播间等），此处返回的是演示结果。`;
      if (r.result) r.result.realModeNote = note; else r.realModeNote = note;
      return r;
    }));
  }

  /** 查询任务；平台任务失败时自动退回预扣的额度 */
  async function opTask(ctx, id) {
    const real = realTasks.get(String(id));
    if (real) {
      if (real.owner !== ctx.access.workspace) throw E.notFound('找不到这个任务。', '任务只能由提交它的企业查看。');
      const t = await runtimeFor(real.vendorId, false).client.taskInfo(id);
      if ((t.status === 5 || t.status === 9) && !loggedTasks.has(String(id))) {
        loggedTasks.add(String(id));
        if (t.status === 9) Q.refund(real.charge, `平台任务 ${id} 失败，自动退回`);
        T.writeLog({ category: categoryOf(ctx), action: 'task.finish', capability: real.capability, mode: 'real', ok: t.status === 5, code: t.status === 9 ? 'TASK_FAILED' : null, detail: `任务 ${id}${t.status === 9 && real.charge ? '，已退回额度' : ''}`, ...actorOf(ctx) });
      }
      return { ...t, mode: 'real' };
    }
    const t = MOCK.task(id);
    if (!t) throw E.notFound('找不到这个任务。', '演示任务在服务重启后会被清空，请重新提交。');
    return { ...t, mode: 'mock' };
  }

  function meView(ctx) {
    const a = ctx.access;
    return {
      user: ctx.user ? T.publicUser(ctx.user) : null,
      tenant: a.tenant || null,
      access: { kind: a.kind, allowed: a.allowed, modules: a.modules, canReal: a.canReal, realReason: a.realReason || '' },
      quota: a.kind === 'tenant' ? { items: Q.tenantQuota(a.tenant.id), low: Q.lowItems(a.tenant.id) } : null,
      publicDemo: cfg.publicDemo,
    };
  }

  function configView(mode, ctx) {
    const a = ctx.access;
    let v = null;
    if (a.canReal) { try { v = T.vendorConfig(a.vendorId); } catch { v = null; } }
    return {
      mode, defaultMode: cfg.defaultMode, realAvailable: a.canReal, realReason: a.realReason || '',
      appIdMasked: v ? maskValue(v.appId) : '未配置',
      allowBillable: !!a.canBill,
      ttsConfigured: !!v?.ttsQid, avatarImageConfigured: !!v?.avatarImageUrl, llmConfigured: !!cfg.deepseekKey,
      vendorManaged: a.kind === 'tenant',
    };
  }

  function serveFile(req, res, filePath, { cache }) {
    let st; try { st = fs.statSync(filePath); } catch { return false; }
    if (!st.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' };
    if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && st.size > 1024) {
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
      fs.createReadStream(filePath).pipe(zlib.createGzip()).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      fs.createReadStream(filePath).pipe(res);
    }
    return true;
  }

  /* ---------- 路由：认证与账号 ---------- */
  async function authRoutes(req, res, p, ctx) {
    const m = req.method;
    if (p === '/api/me' && m === 'GET') return ok(res, meView(ctx)), true;
    if (p === '/api/auth/login' && m === 'POST') {
      const { username, password } = await readBody(req);
      if (!username || !password) throw E.validation('请输入用户名和密码。');
      const r = T.login({ username, password, ip: ctx.ip, ua: req.headers['user-agent'] });
      const next = { ...ctx, ...{ sess: T.resolveSession(r.token) } };
      next.user = next.sess.user; next.access = T.accessOf(next.sess);
      return ok(res, meView(next), { 'Set-Cookie': sessionCookie(req, r.token, r.maxAgeSec) }), true;
    }
    if (p === '/api/auth/logout' && m === 'POST') {
      T.logout(ctx.token);
      return ok(res, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) }), true;
    }
    if (p === '/api/auth/password' && m === 'POST') {
      const u = requireUser(ctx);
      const { oldPassword, newPassword } = await readBody(req);
      T.changePassword(u, oldPassword, newPassword, ctx.token);
      const sess = T.resolveSession(ctx.token);
      return ok(res, meView({ ...ctx, sess, user: sess.user, access: T.accessOf(sess) })), true;
    }
    return false;
  }

  /* ---------- 路由：超级管理员 ---------- */
  async function adminRoutes(req, res, p, url, ctx) {
    if (!p.startsWith('/api/admin/')) return false;
    const actor = requireRole(ctx, 'super_admin');
    if (actor.must_change_pw) throw fail('PASSWORD_CHANGE_REQUIRED', '请先修改初始密码。', '', 'fix');
    const m = req.method;
    const seg = p.split('/').slice(3); // ['tenants', id?, 'users'?]
    const body = m === 'GET' || m === 'DELETE' ? {} : await readBody(req);

    if (seg[0] === 'overview' && m === 'GET') {
      const tenants = T.listTenants();
      return ok(res, {
        tenants: { total: tenants.length, active: tenants.filter((t) => t.usable).length, trial: tenants.filter((t) => t.plan === 'trial').length, expired: tenants.filter((t) => t.expired).length, expiringSoon: tenants.filter((t) => t.usable && t.daysLeft <= 7).map((t) => ({ id: t.id, name: t.name, expiresDay: t.expiresDay, daysLeft: t.daysLeft })) },
        usage: T.usageStats(undefined, 30),
      }), true;
    }
    if (seg[0] === 'modules' && m === 'GET') return ok(res, { groups: GROUPS.map((g) => ({ id: g.id, name: g.name, modules: CAPABILITIES.filter((c) => c.group === g.id).map((c) => ({ id: c.id, name: c.name, billable: c.billable })) })) }), true;

    if (seg[0] === 'tenants') {
      if (!seg[1] && m === 'GET') return ok(res, { tenants: T.listTenants() }), true;
      if (!seg[1] && m === 'POST') return ok(res, T.createTenant(actor, body, ctx.ip)), true;
      const id = seg[1];
      if (!seg[2]) {
        if (m === 'GET') return ok(res, { tenant: T.getTenant(id), users: T.listUsers(id), usage: T.usageStats(id, 30), quota: Q.tenantQuota(id), keys: T.listKeys(id), ledger: Q.ledgerOf({ tenantId: id, limit: 30 }) }), true;
        if (m === 'PATCH') return ok(res, { tenant: T.updateTenant(actor, id, body, ctx.ip) }), true;
        if (m === 'DELETE') { T.deleteTenant(actor, id, ctx.ip); return ok(res, { ok: true }), true; }
      }
      if (seg[2] === 'users' && m === 'POST') return ok(res, T.createUser(actor, id, body, ctx.ip)), true;
      if (seg[2] === 'quota' && m === 'POST') {
        // 从厂商池分配给客户 / 从客户回收到厂商池
        const t = T.tenantRaw(id);
        if (!t) throw E.notFound('客户不存在。');
        const quota = body.op === 'reclaim' ? Q.reclaim(actor, t, body.meter, body.amount, body.note) : Q.allocate(actor, t, body.meter, body.amount, body.note);
        T.audit(actor, body.op === 'reclaim' ? 'quota.reclaim' : 'quota.allocate', `「${t.name}」${body.op === 'reclaim' ? '回收' : '分配'} ${body.amount} ${METERS[body.meter].unit}${METERS[body.meter].label}${body.note ? `（${String(body.note).slice(0, 40)}）` : ''}`, ctx.ip);
        return ok(res, { quota, ledger: Q.ledgerOf({ tenantId: id, limit: 30 }) }), true;
      }
      if (seg[2] === 'keys' && m === 'POST') return ok(res, T.createKey(actor, id, body, ctx.ip)), true;
    }
    if (seg[0] === 'users' && seg[1]) return userOps(req, res, actor, seg, body, ctx), true;
    if (seg[0] === 'keys' && seg[1] && m === 'DELETE') return ok(res, { key: T.revokeKey(actor, seg[1], ctx.ip) }), true;

    if (seg[0] === 'vendors') {
      if (!seg[1] && m === 'GET') { const d = T.listVendors(); return ok(res, { ...d, meters: METERS, vendors: d.vendors.map((v) => ({ ...v, pool: Q.vendorPool(v.id) })) }), true; }
      if (seg[1] && seg[2] === 'purchase' && m === 'POST') {
        // 登记从厂商（A）采购的额度：这是平台自己的台账
        if (!T.listVendors().vendors.some((v) => v.id === seg[1])) throw E.notFound('厂商凭据不存在。');
        const pool = Q.purchase(actor, seg[1], body.meter, body.amount, body.note);
        T.audit(actor, 'quota.purchase', `${T.listVendors().vendors.find((v) => v.id === seg[1]).name}：采购入账 ${body.amount} ${METERS[body.meter].unit}${METERS[body.meter].label}${body.note ? `（${String(body.note).slice(0, 40)}）` : ''}`, ctx.ip);
        return ok(res, { pool }), true;
      }
      if (seg[1] && seg[2] === 'ledger' && m === 'GET') return ok(res, { ledger: Q.ledgerOf({ vendorId: seg[1], limit: 100 }) }), true;
      if (!seg[1] && m === 'POST') return ok(res, { vendor: T.saveVendor(actor, null, body, ctx.ip) }), true;
      if (seg[1] && !seg[2] && m === 'PATCH') { const v = T.saveVendor(actor, seg[1], body, ctx.ip); return ok(res, { vendor: v }), true; }
      if (seg[1] && !seg[2] && m === 'DELETE') { T.deleteVendor(actor, seg[1], ctx.ip); return ok(res, { ok: true }), true; }
      if (seg[1] && seg[2] === 'token' && m === 'POST') {
        // 从厂商获取 Token（验证凭据可用），只返回打码后的状态
        const rt = runtimeFor(seg[1], false);
        try { await rt.tokens.get({ force: !!body.force }); } catch (e) {
          T.audit(actor, 'vendor.token', `获取 Token 失败：${T.listVendors().vendors.find((v) => v.id === seg[1])?.name || seg[1]}`, ctx.ip);
          throw e;
        }
        T.audit(actor, 'vendor.token', `${body.force ? '强制更换' : '获取'} Token：${T.listVendors().vendors.find((v) => v.id === seg[1])?.name || seg[1]}`, ctx.ip);
        return ok(res, { token: rt.tokens.status() }), true;
      }
      if (seg[1] && seg[2] === 'token' && m === 'GET') {
        const v = T.vendorConfig(seg[1]);
        const rt = v && vendorRuntime.get(v.key);
        return ok(res, { token: rt ? rt.tokens.status() : { hasToken: false } }), true;
      }
    }
    if (seg[0] === 'logs' && m === 'GET') return ok(res, logsQuery(url, { tenantId: url.searchParams.get('tenant') === 'guest' ? null : (url.searchParams.get('tenant') || undefined) })), true;
    if (seg[0] === 'logs.csv' && m === 'GET') return sendCsv(res, logsQuery(url, { tenantId: url.searchParams.get('tenant') || undefined }, 5000)), true;
    throw fail('API_NOT_FOUND', '接口不存在。');
  }

  /* ---------- 路由：客户管理员 ---------- */
  async function orgRoutes(req, res, p, url, ctx) {
    if (!p.startsWith('/api/org/')) return false;
    const actor = requireRole(ctx, 'tenant_admin');
    if (actor.must_change_pw) throw fail('PASSWORD_CHANGE_REQUIRED', '请先修改初始密码。', '', 'fix');
    const m = req.method;
    const seg = p.split('/').slice(3);
    const tid = actor.tenant_id;
    const body = m === 'GET' || m === 'DELETE' ? {} : await readBody(req);
    if (seg[0] === 'overview' && m === 'GET') {
      const t = T.getTenant(tid);
      return ok(res, { tenant: { ...t, vendorId: undefined, vendorName: undefined, note: undefined }, usage: T.usageStats(tid, 30), quota: Q.tenantQuota(tid), low: Q.lowItems(tid), meters: METERS }), true;
    }
    if (seg[0] === 'keys' && !seg[1] && m === 'GET') return ok(res, { keys: T.listKeys(tid), quota: Q.tenantQuota(tid), meters: METERS, modules: T.getTenant(tid).modules, canReal: ctx.access.canReal }), true;
    if (seg[0] === 'keys' && !seg[1] && m === 'POST') return ok(res, T.createKey(actor, tid, body, ctx.ip)), true;
    if (seg[0] === 'keys' && seg[1] && m === 'DELETE') {
      if (!T.listKeys(tid).some((k) => k.id === seg[1])) throw E.notFound('密钥不存在。');
      return ok(res, { key: T.revokeKey(actor, seg[1], ctx.ip) }), true;
    }
    if (seg[0] === 'ledger' && m === 'GET') return ok(res, { ledger: Q.ledgerOf({ tenantId: tid, limit: 100 }), meters: METERS }), true;
    if (seg[0] === 'users' && !seg[1] && m === 'GET') return ok(res, { users: T.listUsers(tid), maxUsers: T.getTenant(tid).maxUsers }), true;
    if (seg[0] === 'users' && !seg[1] && m === 'POST') return ok(res, T.createUser(actor, tid, body, ctx.ip)), true;
    if (seg[0] === 'users' && seg[1]) return userOps(req, res, actor, seg, body, ctx), true;
    if (seg[0] === 'logs' && m === 'GET') return ok(res, logsQuery(url, { tenantId: tid })), true;
    if (seg[0] === 'logs.csv' && m === 'GET') return sendCsv(res, logsQuery(url, { tenantId: tid }, 5000)), true;
    throw fail('API_NOT_FOUND', '接口不存在。');
  }

  function userOps(req, res, actor, seg, body, ctx) {
    const id = seg[1];
    if (!seg[2] && req.method === 'PATCH') return ok(res, { user: T.updateUser(actor, id, body, ctx.ip) });
    if (!seg[2] && req.method === 'DELETE') { T.deleteUser(actor, id, ctx.ip); return ok(res, { ok: true }); }
    if (seg[2] === 'reset-password' && req.method === 'POST') return ok(res, T.resetPassword(actor, id, ctx.ip));
    throw fail('API_NOT_FOUND', '接口不存在。');
  }

  function logsQuery(url, scope, size) {
    const sp = url.searchParams;
    const okParam = sp.get('ok');
    return T.queryLogs({
      ...scope, userId: sp.get('user') || undefined, capability: sp.get('capability') || undefined, category: sp.get('category') || undefined,
      ok: okParam === '1' ? true : okParam === '0' ? false : undefined, from: sp.get('from') || undefined, to: sp.get('to') || undefined,
      page: sp.get('page') || 1, size: size || sp.get('size') || 50,
    });
  }

  function sendCsv(res, { rows }) {
    const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['时间', '客户', '账号', '类别', '操作', '能力', '环境', '结果', '错误码', '耗时(ms)', '说明', 'IP'];
    const lines = rows.map((r) => [new Date(r.at).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }), r.tenant_name || (r.tenant_id ? r.tenant_id : '访客/平台'), r.username || '', r.category, r.action, r.capability ? (capById(r.capability)?.name || r.capability) : '', r.mode || '', r.ok ? '成功' : '失败', r.code || '', r.duration_ms ?? '', r.detail || '', r.ip || ''].map(cell).join(','));
    const t = '\uFEFF' + [head.join(','), ...lines].join('\r\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="usage-logs-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
    res.end(t);
  }

  /* ---------- 路由：工作台能力 ---------- */
  async function workspaceRoutes(req, res, p, url, ctx) {
    const m = req.method;
    const a = ctx.access;

    if (p === '/api/health' && m === 'GET') {
      return ok(res, { status: 'ok', service: PRODUCT_NAME, version: VERSION, defaultMode: cfg.defaultMode, realAvailable: cfg.realAvailable, capabilities: CAPABILITIES.length, ts: Date.now() });
    }
    if (p === '/api/config' && m === 'GET') return ok(res, configView(modeOf(req, ctx), ctx));
    if (p === '/api/mode' && m === 'POST') {
      const { mode } = await readBody(req);
      if (!['mock', 'real'].includes(mode)) throw E.validation('运行模式只能是演示（mock）或真实（real）。');
      req.headers['x-ruying-mode'] = mode;
      return ok(res, configView(modeOf(req, ctx), ctx));
    }

    if (p === '/api/token') {
      // 平台 Token 由超级管理员统一管理；其他角色只看到说明
      if (ctx.user?.role !== 'super_admin' || !a.canReal) return ok(res, { applicable: false, managed: a.kind === 'tenant' });
      const rt = runtimeFor(a.vendorId, a.canBill);
      if (m === 'POST') { const { force } = await readBody(req); await rt.tokens.get({ force: !!force }); }
      return ok(res, { applicable: true, mode: 'real', ...rt.tokens.status() });
    }

    if (p === '/api/capabilities' && m === 'GET') {
      return ok(res, {
        list: CAPABILITIES.map((c) => ({
          id: c.id, groupId: c.group, group: GROUPS.find((g) => g.id === c.group)?.name, name: c.name, desc: c.desc, scene: c.scene,
          api: c.api, doc: c.doc, tag: c.tag || '', status: c.status, output: c.experience?.output || 'text',
          outputLabel: OUTPUT_LABEL[c.experience?.output] || '文本', allowed: a.modules.includes(c.id),
        })),
        total: CAPABILITIES.length, groups: GROUPS.length, ready: CAPABILITIES.filter((c) => c.status === 'ready').length, stats: stats(),
      });
    }
    if (p === '/api/capability' && m === 'GET') {
      const cap = capById(url.searchParams.get('id'));
      if (!cap) throw E.notFound('没有这项能力。', '请回到能力目录重新选择。');
      return ok(res, cap);
    }

    if (p === '/api/capability/run' && m === 'POST') {
      const { id, params = {} } = await readBody(req);
      return ok(res, await opCapability(ctx, () => modeOf(req, ctx), id, params));
    }
    if ((p === '/api/capability/task' || p === '/api/task') && m === 'POST') {
      const { id } = await readBody(req);
      return ok(res, await opTask(ctx, id));
    }
    if (p === '/api/tts' && m === 'POST') {
      const { text = '', purpose } = await readBody(req);
      return ok(res, await opTts(ctx, () => modeOf(req, ctx), text, purpose));
    }
    if (p === '/api/avatar' && m === 'POST') {
      const { text = '', audioUrl = '', duration = 0 } = await readBody(req);
      return ok(res, await opAvatar(ctx, () => modeOf(req, ctx), { text, audioUrl, duration }));
    }

    /* ---------- 知识库 ---------- */
    if (p === '/api/kb' && m === 'GET') {
      T.assertModule(a, SHORTCUT_MODULE.chat);
      return ok(res, { docs: kb.list(workspaceOf(req, ctx)), shared: a.kind === 'tenant' });
    }
    if (p === '/api/kb/upload' && m === 'POST') {
      T.assertModule(a, SHORTCUT_MODULE.chat);
      const ws = workspaceOf(req, ctx);
      const { name, content } = await readBody(req);
      try {
        const doc = kb.add(ws, { name, content });
        T.writeLog({ category: 'usage', action: 'kb.upload', capability: SHORTCUT_MODULE.chat, mode: 'mock', detail: String(name).slice(0, 80), tenantId: a.tenant?.id ?? null, userId: ctx.user?.id, username: ctx.user?.username, ip: ctx.ip });
        return ok(res, { doc, docs: kb.list(ws) });
      } catch (e) {
        if (!e.kbCode) throw e;
        const dupe = ['DUPLICATE', 'SAME_NAME'].includes(e.kbCode);
        return send(res, 200, { code: `KB_${e.kbCode}`, message: e.message, hint: dupe ? '列表里已有这份资料，可以直接提问。' : '', action: 'fix', data: null });
      }
    }
    if (p === '/api/kb' && m === 'DELETE') {
      T.assertModule(a, SHORTCUT_MODULE.chat);
      const ws = workspaceOf(req, ctx);
      if (!kb.remove(ws, url.searchParams.get('id'))) throw E.notFound('这份资料已经不在知识库里了。', '刷新列表看看。');
      T.writeLog({ category: 'usage', action: 'kb.delete', capability: SHORTCUT_MODULE.chat, tenantId: a.tenant?.id ?? null, userId: ctx.user?.id, username: ctx.user?.username, ip: ctx.ip });
      return ok(res, { docs: kb.list(ws) });
    }

    if (p === '/api/chat' && m === 'POST') {
      guard(ctx, SHORTCUT_MODULE.chat, 'kb.chat');
      const mode = modeOf(req, ctx);
      const ws = workspaceOf(req, ctx);
      const { text = '' } = await readBody(req);
      const qn = String(text).trim();
      if (!qn) throw E.validation('请输入问题。');
      if (qn.length > 500) throw E.validation('问题太长了，请控制在 500 字以内。');
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n');
      const ctrl = new AbortController();
      res.on('close', () => ctrl.abort());
      let hit = null;
      const emit = (event, data) => { if (event === 'meta') hit = data.hit; if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      const t0 = Date.now();
      let engine = null;
      const emitWrap = (event, data) => { if (event === 'meta') engine = data.engine; emit(event, data); };
      const logChat = (okFlag, code, extra = '') => T.writeLog({ category: 'usage', action: 'kb.chat', capability: SHORTCUT_MODULE.chat, mode, ok: okFlag, code, durationMs: Date.now() - t0, detail: [hit === false ? '未命中资料' : hit ? '命中资料' : '', extra].filter(Boolean).join('；'), ...actorOf(ctx) });
      // 大模型问答按次计量：客户额度不足时退回原文摘录（免费），并如实说明
      let answerMode = mode;
      const metering = mode === 'real' && a.kind === 'tenant' && cfg.deepseekKey;
      if (metering && Q.tenantQuota(a.tenant.id).api_calls.remaining < 1) {
        answerMode = 'mock';
        emit('meta', { hit: null, sources: [], engine: 'extract', notice: '大模型问答额度已用完，以下为资料原文摘录；需要追加额度请联系企业管理员。' });
      }
      try {
        const answer = await answerQuestion({ kb, ws, question: qn, mode: answerMode, cfg, emit: emitWrap, signal: ctrl.signal, deps: { fetchImpl } });
        emit('done', { answer });
        let extra = '';
        if (metering && engine === 'deepseek' && answer) { try { Q.consume(T.tenantRaw(a.tenant.id), costOf('chat'), 'kb.chat', actorOf(ctx).username); extra = '扣减 1 次其他能力调用'; } catch { /* 并发下余额刚好用完：本次不再扣 */ } }
        logChat(true, null, extra);
      } catch (e) {
        if (!ctrl.signal.aborted) {
          log.error('[chat] ' + redactText(e.message));
          emit('error', { message: '回答失败了。', hint: '请稍后重新提问。', action: 'retry' });
          logChat(false, 'CHAT_FAILED');
        }
      }
      res.end();
      return;
    }

    throw fail('API_NOT_FOUND', '接口不存在。');
  }

  /* ---------- 开放接口（客户用 B 签发的 API 密钥调用；B 用 A 的 Token 转发） ---------- */
  const OPEN_STATUS = { INVALID_API_KEY: 401, API_KEY_REVOKED: 401, API_KEY_EXPIRED: 401, RATE_LIMITED: 429, MODULE_FORBIDDEN: 403, TENANT_EXPIRED: 403, TENANT_NOT_STARTED: 403, TENANT_DISABLED: 403,
    REAL_NOT_ENABLED: 403, QUOTA_EXHAUSTED: 402, INVALID_INPUT: 400, NOT_FOUND: 404, API_NOT_FOUND: 404, PAYLOAD_TOO_LARGE: 413, BILLING_GUARDED: 403,
    UPSTREAM_REJECTED: 502, UPSTREAM_ERROR: 502, UPSTREAM_UNREACHABLE: 502, AUTH_FAILED: 502, UPSTREAM_TIMEOUT: 504, TTS_TIMEOUT: 504, INTERNAL: 500 };
  const rate = new Map(); // keyId -> { windowStart, n }
  const RATE_LIMIT = Number(process.env.OPEN_API_RATE_PER_MIN || 120);

  async function openRoutes(req, res, p, reqId) {
    const auth = String(req.headers.authorization || '');
    const k = T.resolveKey(auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
    const r = rate.get(k.key.id) || { windowStart: Date.now(), n: 0 };
    if (Date.now() - r.windowStart > 60000) { r.windowStart = Date.now(); r.n = 0; }
    r.n += 1; rate.set(k.key.id, r);
    if (r.n > RATE_LIMIT) throw fail('RATE_LIMITED', `请求太频繁：每个密钥每分钟最多 ${RATE_LIMIT} 次。`, '请稍后重试，或降低并发。', 'later');
    const ctx = { user: null, apiKey: { id: k.key.id, name: k.keyName }, access: k.access, ip: clientIp(req) };
    const sandbox = ['sandbox', 'mock'].includes(String(req.headers['x-ruying-mode'] || '').toLowerCase());
    const modeFn = () => {
      if (sandbox) return 'mock';
      if (!ctx.access.canReal) throw fail('REAL_NOT_ENABLED', `企业暂时无法调用真实接口：${ctx.access.realReason || '企业账号当前不可用'}。`, '联调阶段可以加请求头 X-Ruying-Mode: sandbox 使用沙箱（返回样例结果，不扣额度）。', 'contact');
      return 'real';
    };
    const send2 = (data) => send(res, 200, { code: 0, message: 'success', requestId: reqId, data });
    const m = req.method;
    const seg = p.split('/').slice(3); // /open/v1/<seg...>
    if (seg[0] === 'account' && m === 'GET') {
      const t = ctx.access.tenant;
      return send2({ tenant: t.name, plan: t.plan, startsDay: t.startsDay, expiresDay: t.expiresDay, usable: t.usable, realEnabled: ctx.access.canReal, modules: ctx.access.modules, quota: Q.tenantQuota(t.id), meters: METERS });
    }
    if (seg[0] === 'capabilities' && !seg[1] && m === 'GET') {
      return send2({ list: CAPABILITIES.filter((c) => ctx.access.modules.includes(c.id)).map((c) => ({ id: c.id, name: c.name, group: GROUPS.find((g) => g.id === c.group)?.name, output: c.experience?.output, fields: (c.experience?.fields || []).map((f) => ({ key: f.key, label: f.label, type: f.type })) })) });
    }
    if (m === 'GET' || m === 'POST') T.assertModule(ctx.access, null); // 有效期校验
    if (seg[0] === 'tts' && m === 'POST') { const b = await readBody(req); return send2(await opTts(ctx, modeFn, String(b.text || ''), 'voice')); }
    if (seg[0] === 'videos' && m === 'POST') { const b = await readBody(req); return send2(await opAvatar(ctx, modeFn, { text: b.name || '', audioUrl: b.audioUrl, duration: b.duration, imageUrl: b.imageUrl, name: b.name })); }
    if (seg[0] === 'capabilities' && seg[1] && seg[2] === 'run' && m === 'POST') { const b = await readBody(req); return send2(await opCapability(ctx, modeFn, seg[1], b.params || {})); }
    if (seg[0] === 'tasks' && seg[1] && m === 'GET') return send2(await opTask(ctx, seg[1]));
    throw fail('API_NOT_FOUND', '接口不存在。', '可用接口见「接入指南 → 开放接口」。');
  }

  return http.createServer(async (req, res) => {
    let p, url;
    try { url = new URL(req.url, 'http://localhost'); p = url.pathname; } catch { res.writeHead(400); return res.end(); }
    if (BASE && (p === BASE || p.startsWith(BASE + '/'))) p = p.slice(BASE.length) || '/';

    if (p.startsWith('/open/v1/')) {
      const reqId = `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      try { await openRoutes(req, res, p, reqId); } catch (err) {
        const e = toAppError(err);
        if (e.code === 'INTERNAL') log.error(`[open] ${req.method} ${p} → ${redactText(err?.stack || '')}`);
        if (!res.headersSent) send(res, OPEN_STATUS[e.code] || 400, { ...errorBody(e), requestId: reqId });
      }
      return;
    }

    if (p.startsWith('/api/')) {
      try {
        // CSRF：所有写操作必须带自定义头（跨站表单无法设置），配合 SameSite=Lax 的会话 Cookie
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'ruying') {
          throw fail('FORBIDDEN', '请求来源不被允许。', '请刷新页面后重试。', 'retry');
        }
        const ctx = contextOf(req);
        if (await authRoutes(req, res, p, ctx)) return;
        if (await adminRoutes(req, res, p, url, ctx)) return;
        if (await orgRoutes(req, res, p, url, ctx)) return;
        await workspaceRoutes(req, res, p, url, ctx);
      } catch (err) {
        const e = toAppError(err);
        if (e.code === 'INTERNAL') log.error(`[api] ${req.method} ${p} → ${redactText(err?.stack || e.detail || '')}`);
        else if (e.detail) log.error(`[api] ${req.method} ${p} → ${e.code} · ${redactText(e.detail)}`);
        if (!res.headersSent) sendError(res, e);
        else res.end();
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (p.startsWith('/files/')) {
      const f = path.join(MOCK.assets, path.basename(p));
      if (serveFile(req, res, f, { cache: 'public, max-age=86400' })) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found');
    }
    const target = path.join(DIST, p === '/' ? 'index.html' : p);
    if (target.startsWith(DIST + path.sep)) {
      const hashed = p.startsWith('/assets/');
      if (serveFile(req, res, target, { cache: hashed ? 'public, max-age=31536000, immutable' : (target.endsWith('.html') ? 'no-cache' : 'public, max-age=3600') })) return;
      if (hashed || path.extname(p)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    }
    if (serveFile(req, res, path.join(DIST, 'index.html'), { cache: 'no-cache' })) return;
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('前端尚未构建：请先运行 npm run build。');
  });
}

export { MODULE_IDS };

/* ---------- 直接运行时启动 ---------- */
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const cfg = getConfig();
  const port = Number(process.env.PORT || 8080);
  const server = createServer({ cfg });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[${PRODUCT_NAME}] v${VERSION} http://127.0.0.1:${port}  默认模式=${cfg.defaultMode}  默认厂商凭据=${cfg.realAvailable ? '已配置' : '未配置'}  访客演示=${cfg.publicDemo ? '开启' : '关闭'}`);
    for (const w of cfg.warnings) console.warn('[配置提示] ' + w);
    if (!cfg.dataEncryptionKey) console.warn('[配置提示] 未设置 DATA_ENCRYPTION_KEY：超级管理员暂时不能在后台保存厂商凭据');
    if (!fs.existsSync(path.join(cfg.root, 'dist'))) console.log('[提示] 未发现 dist/，请先 npm run build。');
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
