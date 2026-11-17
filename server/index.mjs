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
import { createRuyingClient, normalizeDuration, TASK_STATUS_TEXT } from './lib/ruying.mjs';
import { DEMO_AVATARS } from './lib/demo-avatars.mjs';
import { KbStore } from './lib/kb.mjs';
import { answerQuestion, completeDeepSeek } from './lib/answer.mjs';
import { buildVoiceCloneBody, buildAvatarTrainBody, buildAvatarRebuildBody, buildImageEditBody, buildGreenPreviewBody, buildVideoCreateParam, buildLiveChannelParam, buildDecorationTaskBody, buildContentRepoBody, buildWarmingBody, buildTranscodeBody, buildTransitionBody, extractTaskResult, assertVendorQuota } from './lib/realcap.mjs';
import { maskValue, redactText } from './lib/mask.mjs';
import { AppError, E, toAppError, errorBody } from './lib/errors.mjs';
import { openDb } from './lib/db.mjs';
import { createTenancy, SHORTCUT_MODULE, MODULE_IDS } from './lib/tenancy.mjs';
import { mediaDir, mediaSpec, storeMedia, sweepMedia } from './lib/media.mjs';
import { createQuota, costOf, METERS } from './lib/quota.mjs';
import { createTeaching } from './lib/teaching.mjs';
import { CAPABILITIES, GROUPS, capById, stats, OUTPUT_LABEL } from '../src/lib/capabilities.js';

const PRODUCT_NAME = '如影 AI 能力开放平台';
const MAX_BODY = 1.5 * 1024 * 1024;
const COOKIE = 'ry_sid';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', // 站内上传的文档素材（/media/ 供平台拉取）
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
  const MEDIA_DIR = mediaDir(cfg.kbDir); // 站内上传的素材（图片/音频/视频），按 /media/<随机名> 对外提供
  const db = injectedDb || openDb(cfg.dbFile);
  const Q = createQuota({ db });
  const T = createTenancy({ db, cfg, quota: Q, log: (m) => log.log(m) });
  const TE = createTeaching({ db, tenancy: T });
  T.bootstrap();
  try { kb.prune(); T.pruneLogs(); sweepMedia(MEDIA_DIR); } catch { /* ignore */ }

  const realTasks = new Map();   // 平台任务编号 -> { owner, vendorKey, canBill }
  const loggedTasks = new Set(); // 已记录完成情况的任务

  /** 任务名：优先取表单里的任务名/名称/提示词/文案，取不到用能力名 */
  const taskName = (capId, params = {}) => {
    const cand = params.videoName || params.name || params.imageName || params.materialName || params.prompt || params.text || '';
    const s = String(cand).replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, 40) : (capById(capId)?.name || capId);
  };

  /** 任务登记落库：平台任务编号一旦创建就写进 tasks 表（重启不丢），任务中心唯一来源 */
  function recordTask(taskId, workspace, vendorId, capability, name, charge) {
    try {
      db.prepare(`INSERT OR IGNORE INTO tasks (id, workspace, vendor_id, capability, name, status, result, charge, refunded, created_at, updated_at) VALUES (?,?,?,?,?,?,1,'',0,?,?)`)
        .run(String(taskId), workspace, vendorId, capability, String(name || capability || '').slice(0, 40), charge ? JSON.stringify(charge) : '', Date.now(), Date.now());
    } catch (e) { log.warn(`任务登记落库失败 ${taskId}: ${toAppError(e).message}`); }
  }

  /** 同步任务行状态与结果（查询/列表刷新时调用）；落库失败不挡查询 */
  function updateTaskRow(id, status, result) {
    try { db.prepare('UPDATE tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?').run(Number(status) || 1, result ? JSON.stringify(result) : '', Date.now(), String(id)); } catch { /* ignore */ }
  }

  /** 任务行转前端形状：结果 JSON 解析失败时返回 null，不抛错 */
  const publicTask = (row) => {
    let result = null;
    try { result = row.result ? JSON.parse(row.result) : null; } catch { result = null; }
    const cap = capById(row.capability);
    return {
      id: String(row.id), capability: row.capability || '', capabilityName: cap?.name || (row.capability ? row.capability : '历史任务'),
      name: row.name || '', status: Number(row.status) || 1,
      statusText: TASK_STATUS_TEXT[Number(row.status)] || '未知',
      output: result?.output || cap?.experience?.output || 'video',
      result, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  };
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

  /** 读原始二进制请求体（素材上传用；上限按文件类型定，超了直接 413） */
  const readRaw = (req, maxBytes) => new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', (c) => { size += c.length; if (size <= maxBytes) parts.push(c); });
    req.on('end', () => {
      if (size > maxBytes) return reject(fail('PAYLOAD_TOO_LARGE', '文件太大了。', `单个文件请控制在 ${Math.round(maxBytes / 1024 / 1024)}MB 以内。`));
      if (!size) return reject(E.validation('没有收到文件内容。'));
      resolve(Buffer.concat(parts));
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

  async function opTts(ctx, modeArg, text, purpose, opts = {}) {
    const module = purpose === 'video' ? SHORTCUT_MODULE.video : SHORTCUT_MODULE.voice;
    guard(ctx, module, purpose === 'video' ? 'video.tts' : 'voice.tts');
    const mode = resolveMode(modeArg);
    if (words(text) < 4) throw E.validation('文案至少 4 个字，请再写一点。');
    // 上限与控制台 voiceTest 一致：语音合成（测试文本）最多 2000 字；视频口播仍限 200 字（时长与额度口径）
    if (purpose === 'video' ? words(text) > 200 : words(text) > 2000) throw E.validation(purpose === 'video' ? '文案最多 200 个字，请删减后再生成。' : '测试文本最多 2000 个字，请删减后再生成。');
    return track(ctx, { action: purpose === 'video' ? 'video.tts' : 'voice.tts', capability: module, mode }, () =>
      metered(ctx, mode, costOf('tts', { text }), 'tts', async () => (mode === 'real' ? { ...(await runtimeFor(ctx.access.vendorId, ctx.access.canBill).client.tts(String(text), opts)), mode: 'real' } : MOCK.tts(text))));
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
        if (!img) throw fail('AVATAR_NOT_CONFIGURED', '没有可用的数字人形象图片。', ctx.apiKey ? '请在请求里传 imageUrl（可公网访问的人像图片地址）。' : '请在上方填入一张人像图片地址（可公网访问），或请管理员在「厂商凭据」里配置一个默认形象图。', 'config');
        if (imageUrl && !/^https?:\/\//.test(imageUrl)) throw E.validation('imageUrl 需为 http(s) 地址。');
        const taskId = await rt.client.createImageAvatar({ imageUrl: img, audioUrl, duration, videoName: String(name || `口播${String(text).slice(0, 16)}`).slice(0, 40) });
        realTasks.set(taskId, { owner: ctx.access.workspace, vendorId: ctx.access.vendorId, capability: SHORTCUT_MODULE.video, charge });
        recordTask(taskId, ctx.access.workspace, ctx.access.vendorId, SHORTCUT_MODULE.video, String(name || `口播${String(text).slice(0, 16)}`).slice(0, 40), charge);
        return { taskId, mode: 'real' };
      }));
  }

  /* ---------- 核心能力操作（门户与开放接口共用） ----------
   * 真实链路（2.6.0）：每个能力按平台文档接通，不再把表单原样 POST 给平台。
   *   video-tts：TTS + 默认形象图 → 图片数字人（与创作中心视频口播同一链路）
   *   video-image：图片数字人（已验证；加厂商额度预检）
   *   voice-tts：TTS（已验证）
   *   voice-clone：音色复刻（文档请求体；异步任务）
   *   voice-nlp：平台无接口，自建 DeepSeek 按场景改写
   *   avatar-train：形象复刻（文档请求体；异步任务）
   *   avatar-green：绿幕分割预览接口（图片/视频两路；异步任务）
   *   avatar-update：模型重建（文档扁平字段；异步任务）
   *   image-edit：图片编辑（文档请求体；异步任务）
   *   video-script：生成文档级有效的 video/create param；填了形象信息时提交到平台生成
   *   nlp-kb：平台无接口；下载文档存进服务端自建知识库
   *   nlp-chat：平台无接口；服务端自建检索 + 大模型回答
   *   live-script / live-pro：创建直播间（创建即开始计时；需已训练并预热的形象）
   *   live-multi：创建装修任务（第一步；直播创建是第二步，需 FINISHED 素材与并发路数）
   *   live-wordbank：口水词库（内容预热；异步任务，登记进任务中心）
   *   live-warming：预热素材上传（FileId 预热；异步任务，登记进任务中心）
   *   live-transcode：视频转码（异步任务，登记进任务中心）
   *   live-decorate：直播间装修（创建装修任务；异步任务，登记进任务中心）
   *   live-transition：过渡视频预处理（异步任务，登记进任务中心）
   *   avatar-terminal：平台未开放接口，不调平台，直接返回说明（不产生任务、不扣额度）
   */
  async function opCapability(ctx, modeArg, id, params = {}, wsOf) {
    const cap = capById(id);
    if (!cap) throw E.notFound('没有这项能力。', '请回到能力目录重新选择。');
    guard(ctx, cap.id, 'capability.run');
    const mode = resolveMode(modeArg);
    const cost = mode === 'real' ? costOf('capability', { capId: cap.id, params }) : null;
    return track(ctx, { action: 'capability.run', capability: cap.id, mode }, () => metered(ctx, mode, cost, cap.id, async (charge) => {
      if (mode !== 'real') return MOCK.runCapability(id, params);
      const rt = runtimeFor(ctx.access.vendorId, ctx.access.canBill);
      const client = rt.client;
      const registerTask = (taskId, output) => {
        realTasks.set(taskId, { owner: ctx.access.workspace, vendorId: ctx.access.vendorId, capability: cap.id, charge });
        recordTask(taskId, ctx.access.workspace, ctx.access.vendorId, cap.id, taskName(cap.id, params), charge);
        return { sync: false, taskId, output: output || cap.experience?.output || 'video', mode: 'real' };
      };
      const syncJson = (json, note) => ({ sync: true, result: { capabilityId: id, output: 'json', title: cap.experience.mockTitle || cap.name, json, jsonText: JSON.stringify(json, null, 2), mode: 'real', ...(note ? { realModeNote: note } : {}) } });
      const qid = rt.vcfg.ttsQid || cfg.ttsQid || '';

      if (cap.id === 'video-tts') {
        const text = String(params.text || '').trim();
        if (words(text) < 4) throw E.validation('文案至少 4 个字，请再写一点。');
        if (words(text) > 200) throw E.validation('文案最多 200 个字，请删减后再生成。');
        const duration = normalizeDuration(words(text) / 3.8);
        await assertVendorQuota(client, 'genImageVideoDuration', duration, '图片数字人');
        const audio = await client.tts(text);
        const img = rt.vcfg.avatarImageUrl;
        if (!img) throw fail('AVATAR_NOT_CONFIGURED', '没有可用的数字人形象图片。', '请管理员在「厂商凭据」里配置一个默认形象图。', 'config');
        const taskId = await client.createImageAvatar({ imageUrl: img, audioUrl: audio.audio_url, duration, videoName: `口播${text.slice(0, 16)}` });
        return registerTask(taskId, 'video');
      }
      if (cap.id === 'video-image') {
        // 2.8.0：图片地址留空时自动用服务端默认形象图（与文本驱动视频合成同一张）
        const img = String(params.imageUrl || '').trim() || rt.vcfg.avatarImageUrl || '';
        if (!/^https?:\/\//.test(img)) {
          if (!img) throw fail('AVATAR_NOT_CONFIGURED', '没有可用的数字人形象图片。', '请填写图片地址，或让管理员在「厂商凭据」里配置默认形象图。', 'config');
          throw E.validation('人像图片地址需为 http(s) 地址；留空时使用服务端默认形象图。');
        }
        if (!/^https?:\/\//.test(params.audioUrl || '')) throw E.validation('真实环境需要填写可公网访问的音频地址（http/https）。');
        const duration = normalizeDuration(params.duration);
        await assertVendorQuota(client, 'genImageVideoDuration', duration, '图片数字人');
        const taskId = await client.createImageAvatar({ imageUrl: img, audioUrl: params.audioUrl, duration, videoName: String(params.prompt || cap.name).slice(0, 40) });
        return registerTask(taskId, 'video');
      }
      if (cap.id === 'voice-tts') {
        if (words(params.text) < 4) throw E.validation('文案至少 4 个字，请再写一点。');
        if (words(params.text) > 2000) throw E.validation('测试文本最多 2000 个字，请删减后再生成。');
        const qid = String(params.qidInput || '').trim() || String(params.qid || '').trim() || undefined;
        const r = await client.tts(String(params.text), { qid, speedRatio: params.speed, volume: params.volume, pitchOffset: params.pitch });
        return { sync: true, result: { capabilityId: id, output: 'audio', title: cap.experience.mockTitle || cap.name, audioUrl: r.audio_url, durationMs: r.duration_ms, mode: 'real' } };
      }
      if (cap.id === 'voice-clone') {
        await assertVendorQuota(client, 'genVcModel', 1, '音色克隆模型');
        const taskId = await client.cloneVoice(buildVoiceCloneBody(params));
        return registerTask(taskId, 'json');
      }
      if (cap.id === 'voice-nlp') {
        const text = String(params.text || '').trim();
        if (!text) throw E.validation('请输入原始内容。');
        if (!cfg.deepseekKey) throw fail('LLM_NOT_CONFIGURED', '真实环境未配置大模型。', '需要管理员在服务端配置 DEEPSEEK_API_KEY。', 'config');
        const scene = String(params.scene || '客服口语');
        const rewritten = await completeDeepSeek(cfg, [
          { role: 'system', content: `你是口语化改写助手。把用户给出的内容改写成${scene}风格的口语表达，保持原意，不添加原文没有的事实，不编造数字、价格与承诺，简洁自然。只输出改写后的文本，不要解释。` },
          { role: 'user', content: text },
        ], { fetchImpl });
        return { sync: true, result: { capabilityId: id, output: 'text', title: cap.experience.mockTitle || cap.name, text: rewritten, mode: 'real' } };
      }
      if (cap.id === 'avatar-train') {
        await assertVendorQuota(client, 'genCharModel', 1, '人物形象模型');
        const taskId = await client.trainAvatar(buildAvatarTrainBody(params));
        return registerTask(taskId, 'json');
      }
      if (cap.id === 'avatar-green') {
        const body = buildGreenPreviewBody(params);
        const taskId = await client.greenPreview(body.kind, { materialName: body.materialName, url: body.url, param: body.param });
        return registerTask(taskId, 'image');
      }
      if (cap.id === 'avatar-update') {
        const taskId = await client.rebuildAvatar(buildAvatarRebuildBody(params));
        return registerTask(taskId, 'json');
      }
      if (cap.id === 'image-edit') {
        await assertVendorQuota(client, 'genEditImage', 1, 'AI 图片编辑');
        const taskId = await client.editImage(buildImageEditBody(params));
        return registerTask(taskId, 'image');
      }
      if (cap.id === 'video-script') {
        const faceFeatureId = String(params.faceFeatureId || cfg.faceFeatureId || '').trim();
        const modelUrl = String(params.modelUrl || cfg.avatarModelUrl || '').trim();
        // 发音人：表单里选的（下拉/直接输 QID）优先于服务端默认音色
        const scriptQid = String(params.qidInput || '').trim() || String(params.qid || '').trim() || qid;
        if (faceFeatureId && modelUrl) {
          await assertVendorQuota(client, 'genVideoDuration', 1, '视频合成');
          // 2.8.0：把服务端已配置的形象值（cfg 回落）也传进请求体，否则留空表单 + 已配置服务端时会抛错
          const body = buildVideoCreateParam({ ...params, faceFeatureId, modelUrl }, { qid: scriptQid });
          const taskId = await client.createVideoTask(body);
          return registerTask(taskId, 'video');
        }
        const param = JSON.parse(buildVideoCreateParam({ ...params, faceFeatureId: faceFeatureId || 'your_face_feature_id', modelUrl: modelUrl || 'https://example.com/avatar.zip' }, { qid: scriptQid }).param);
        return syncJson(param, (faceFeatureId || modelUrl)
          ? '形象信息不完整，未提交到平台：face_feature_id 与形象 zip 包地址两者都要填。'
          : '这份 param 可直接提交到视频合成接口；需要先训练形象（形象复刻），拿到 face_feature_id 与 zip 包地址后填入再提交。');
      }
      if (cap.id === 'nlp-kb') {
        const docUrl = String(params.docUrl || '').trim();
        if (!/^https?:\/\//.test(docUrl)) throw E.validation('资料文档 URL 需为 http(s) 地址。');
        const ext = docUrl.split('?')[0].split('.').pop()?.toLowerCase();
        if (!['txt', 'md', 'markdown'].includes(ext || '')) throw fail('UNSUPPORTED_DOC', '知识库目前只支持 .txt / .md 文档。', 'PDF、Word 请先转成纯文本再上传，或用工作台「知识库管理」上传文件。', 'fix');
        let content;
        try {
          const resp = await fetchImpl(docUrl, { signal: AbortSignal.timeout(20000) });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          content = await resp.text();
        } catch (e) {
          throw fail('DOC_FETCH_FAILED', '资料文档下载失败。', '请确认地址可公网访问，或直接在工作台「知识库管理」里上传文件。', 'retry');
        }
        if (!content.trim()) throw fail('DOC_EMPTY', '下载到的文档是空的。');
        const ws = wsOf();
        const baseName = String(params.name || '未命名知识库').trim() || '未命名知识库';
        const fileName = /\.(txt|md|markdown)$/i.test(baseName) ? baseName : `${baseName}.md`;
        try {
          const doc = kb.add(ws, { name: fileName, content });
          return syncJson({ kbId: doc.id, name: doc.name, chars: doc.chars, chunkCount: doc.chunkCount, docCount: kb.list(ws).length, status: '已入库', desc: String(params.desc || '') }, '已存进服务端知识库，现在可以在「流式问答助手」里提问。');
        } catch (e) {
          if (e.kbCode) throw fail(`KB_${e.kbCode}`, e.message, '列表里已有这份资料，可以直接提问。', 'fix');
          throw e;
        }
      }
      if (cap.id === 'nlp-chat') {
        const question = String(params.text || '').trim();
        if (!question) throw E.validation('请输入问题。');
        if (question.length > 500) throw E.validation('问题太长了，请控制在 500 字以内。');
        const ws = wsOf();
        let answer = '';
        let note = '';
        const emit = (event, data) => {
          if (event === 'message') answer += data.delta || '';
          if (event === 'meta' && data.notice) note = data.notice;
        };
        const finalAnswer = await answerQuestion({ kb, ws, question, mode: 'real', cfg, emit, deps: { fetchImpl } });
        const text = finalAnswer || answer;
        return { sync: true, result: { capabilityId: id, output: 'chat', title: cap.experience.mockTitle || cap.name, text, mode: 'real', ...(note ? { realModeNote: note } : {}) } };
      }
      if (cap.id === 'live-script' || cap.id === 'live-pro') {
        await assertVendorQuota(client, 'liveDuration', 1, '直播');
        const body = buildLiveChannelParam(params, { qid, faceFeatureId: cfg.liveFaceFeatureId, fileId: cfg.liveFileId });
        const session = await client.createLiveChannel(body);
        const json = {
          sessionId: session.sessionId,
          status: session.status,
          statusText: session.status === 35 ? '视频流创建完成、可开播' : session.status === 32 ? '视频流创建中' : `状态 ${session.status}`,
          pullRtmpUrl: session.pullRtmpUrl || '', pullFlvUrl: session.pullFlvUrl || '', pullHlsUrl: session.pullHlsUrl || '',
          ...(cap.id === 'live-pro' ? { controlApi: 'POST /api/2dvh/v1/material/live/super/pro/channel/control（切换数字人 / 前景 / 背景）' } : {}),
        };
        return syncJson(json, '直播间已创建，开始计时；尚未开播。开播需调 start 接口并每 60 秒发送心跳；不发送心跳会在阈值后被动关闭。');
      }
      if (cap.id === 'live-multi') {
        const body = buildDecorationTaskBody(params, { faceFeatureId: cfg.liveFaceFeatureId });
        const taskId = await client.createDecorationTask(body);
        return syncJson({ decorationTaskId: taskId, statusQuery: `GET /api/2dvh/v1/multi-video-live/decoration-tasks/${taskId}`, next: '子素材状态 FINISHED 后，才能用 materialId 创建直播（需推流 RTMP 地址与播放列表）。' }, '装修任务已创建；直播创建是第二步，需要 FINISHED 素材与可用并发路数。');
      }
      if (cap.id === 'live-wordbank') {
        const body = buildContentRepoBody(params, { faceFeatureId: cfg.liveFaceFeatureId });
        const taskId = await client.createContentRepo(body);
        return registerTask(taskId, 'json');
      }
      if (cap.id === 'live-warming') {
        const body = buildWarmingBody(params);
        const taskId = await client.warmFile(body);
        return registerTask(taskId, 'json');
      }
      if (cap.id === 'live-transcode') {
        const body = buildTranscodeBody(params);
        const taskId = await client.transcodeFile(body);
        return registerTask(taskId, 'json');
      }
      if (cap.id === 'live-decorate') {
        const body = buildDecorationTaskBody(params, { faceFeatureId: cfg.liveFaceFeatureId });
        const taskId = await client.createDecorationTask(body);
        return registerTask(taskId, 'json');
      }
      if (cap.id === 'live-transition') {
        const body = buildTransitionBody(params);
        const taskId = await client.createTransitionTask(body);
        return registerTask(taskId, 'json');
      }
      if (cap.id === 'avatar-terminal') {
        return syncJson({ available: false, reason: '平台未开放终端模型转换接口', ...(params.modelName ? { modelName: String(params.modelName).slice(0, 64) } : {}), alternative: '如需生成人物模型，请用「形象复刻」（avatar-train）。', doc: '飞书《人物形象模型生成》文档无此接口，仅附录有状态枚举。' }, '平台没有这个接口，本次没有调用平台、不扣额度。');
      }
      // 未覆盖的能力：仍按旧口径返回演示结果并如实说明
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
      // 2.6.0：按能力把平台任务结果规整成前端可直接渲染的形状（带 output 字段）
      const extracted = extractTaskResult(real.capability, t);
      const result = extracted ?? t.result;
      updateTaskRow(String(id), t.status, result); // 同步落库，任务中心不用等列表刷新
      return { ...t, result, output: result?.output || capById(real.capability)?.experience?.output || 'video', mode: 'real' };
    }
    // 重启后内存里的登记丢了，从 tasks 表里找（任务中心唯一来源）
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(String(id));
    if (row) {
      if (row.workspace !== ctx.access.workspace) throw E.notFound('找不到这个任务。', '任务只能由提交它的企业查看。');
      const t = await runtimeFor(row.vendor_id, false).client.taskInfo(id);
      const extracted = extractTaskResult(row.capability, t);
      const result = extracted ?? t.result ?? null;
      updateTaskRow(String(id), Number(t.status) || row.status, result);
      if (Number(t.status) === 9 && row.charge && !row.refunded) {
        try { Q.refund(JSON.parse(row.charge), `平台任务 ${id} 失败，自动退回`); db.prepare('UPDATE tasks SET refunded = 1 WHERE id = ?').run(String(id)); } catch { /* 退回失败不挡查询 */ }
      }
      return { ...t, result, output: result?.output || capById(row.capability)?.experience?.output || 'video', mode: 'real' };
    }
    const t = MOCK.task(id);
    if (!t) throw E.notFound('找不到这个任务。', '演示任务在服务重启后会被清空，请重新提交。');
    return { ...t, mode: 'mock' };
  }

  /** 任务中心列表：先把未完成的任务向平台批量刷新一次（最多 50 条，按厂商分组），再按条件查表 */
  async function opTaskList(ctx, modeArg, sp) {
    const mode = resolveMode(modeArg);
    const ws = ctx.access.workspace;
    if (mode !== 'real') {
      const all = MOCK.list();
      return { tasks: all.map((t) => publicTask({ id: String(t.id), capability: t.capability || '', name: t.name || '', status: t.status, result: t.result ? JSON.stringify(t.result) : '', created_at: t.createdAt || Date.now(), updated_at: t.createdAt || Date.now() })), total: all.length };
    }
    const pending = db.prepare(`SELECT id, vendor_id FROM tasks WHERE workspace = ? AND status IN (1,2) ORDER BY created_at DESC LIMIT 50`).all(ws);
    if (pending.length) {
      const byVendor = new Map();
      for (const r of pending) { if (!byVendor.has(r.vendor_id)) byVendor.set(r.vendor_id, []); byVendor.get(r.vendor_id).push(r.id); }
      for (const [vendorId, ids] of byVendor) {
        try {
          const recs = await runtimeFor(vendorId, false).client.taskInfoMany(ids);
          for (const t of recs) {
            const r = db.prepare('SELECT capability, charge, refunded FROM tasks WHERE id = ?').get(String(t.id));
            if (!r) continue;
            const extracted = extractTaskResult(r.capability, t);
            updateTaskRow(String(t.id), Number(t.status) || 1, extracted ?? t.result ?? null);
            if (Number(t.status) === 9 && r.charge && !r.refunded) {
              try { Q.refund(JSON.parse(r.charge), `平台任务 ${t.id} 失败，自动退回`); db.prepare('UPDATE tasks SET refunded = 1 WHERE id = ?').run(String(t.id)); } catch { /* ignore */ }
            }
          }
        } catch { /* 单个厂商刷新失败不挡列表 */ }
      }
    }
    const status = sp.get('status');
    const capability = sp.get('capability');
    const q = (sp.get('q') || '').trim();
    const limit = Math.min(100, Math.max(1, Number(sp.get('limit')) || 50));
    const offset = Math.max(0, Number(sp.get('offset')) || 0);
    const where = ['workspace = ?']; const args = [ws];
    if (['1', '2', '5', '9'].includes(status)) { where.push('status = ?'); args.push(Number(status)); }
    if (capability) { where.push('capability = ?'); args.push(capability); }
    if (q) { where.push('(id LIKE ? OR name LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    const total = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where.join(' AND ')}`).get(...args).n;
    const rows = db.prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return { tasks: rows.map(publicTask), total };
  }

  /** 历史任务导入：浏览器本地存的任务编号（最多 50 个）向平台批量查一次，未登记的写入 tasks 表 */
  async function opTaskImport(ctx, modeArg, ids) {
    const mode = resolveMode(modeArg);
    if (mode !== 'real') return { imported: 0, note: '演示环境不导入历史任务。' };
    const ws = ctx.access.workspace;
    const known = new Set(db.prepare('SELECT id FROM tasks WHERE workspace = ?').all(ws).map((r) => String(r.id)));
    const fresh = [...new Set((ids || []).map(String))].filter((id) => id && !known.has(id)).slice(0, 50);
    if (!fresh.length) return { imported: 0 };
    const recs = await runtimeFor(ctx.access.vendorId, false).client.taskInfoMany(fresh);
    let n = 0;
    for (const t of recs) {
      const extracted = extractTaskResult('', t);
      db.prepare(`INSERT OR IGNORE INTO tasks (id, workspace, vendor_id, capability, name, status, result, charge, refunded, created_at, updated_at) VALUES (?,?,?,'',?,?,?,'',0,?,?)`)
        .run(String(t.id), ws, ctx.access.vendorId, `历史任务 ${t.id}`, Number(t.status) || 1, extracted ? JSON.stringify(extracted) : '', Date.now(), Date.now());
      n += 1;
    }
    return { imported: n };
  }

  function meView(ctx) {
    const a = ctx.access;
    const u = ctx.user;
    const school = !!a.tenant?.isSchool;
    const className = u?.class_id ? (db.prepare('SELECT name FROM classes WHERE id = ?').get(u.class_id)?.name || '') : '';
    return {
      user: u ? { ...T.publicUser(u), className } : null,
      tenant: a.tenant || null,
      // 教学功能开关：院校客户才有班级、提交与批改
      teaching: { isSchool: school, canReview: school && ['teacher', 'tenant_admin'].includes(u?.role), canSubmit: school && u?.role === 'member' && !!className },
      access: { kind: a.kind, allowed: a.allowed, modules: a.modules, canReal: a.canReal, realReason: a.realReason || '' },
      quota: a.kind === 'tenant' ? { kind: 'tenant', items: Q.tenantQuota(a.tenant.id), low: Q.lowItems(a.tenant.id) } : null,
      publicDemo: cfg.publicDemo,
    };
  }

  /** 超级管理员的厂商实时额度：直接问平台 resource 接口，不走内部台账（台账是空的）。失败不抛，由调用方降级。 */
  async function vendorQuotaView(vendorId) {
    const rt = runtimeFor(vendorId, false);
    const items = await rt.client.resource();
    const low = items.filter((it) => it.allocated > 0 && it.remaining / it.allocated < 0.1).map((it) => it.key);
    return { kind: 'vendor', source: 'live', items, low, fetchedAt: new Date().toISOString() };
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
      // 2.8.0：服务端已配置的前置资源状态，供体验页表单直接显示（布尔值与公开图片地址，不含密钥）
      avatarImageUrl: v?.avatarImageUrl || '',
      faceFeatureConfigured: !!cfg.faceFeatureId, avatarModelConfigured: !!cfg.avatarModelUrl,
      liveAvatarConfigured: !!(cfg.liveFaceFeatureId && cfg.liveFileId),
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
    if (p === '/api/me' && m === 'GET') {
      const view = meView(ctx);
      if (ctx.access.kind === 'super' && ctx.access.canReal && ctx.access.vendorId) {
        try { view.quota = await vendorQuotaView(ctx.access.vendorId); }
        catch (e) { view.quota = { kind: 'vendor', source: 'live', items: [], low: [], error: '暂时无法从厂商获取实时额度，请稍后刷新。' }; }
      }
      return ok(res, view), true;
    }
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
        if (m === 'GET') return ok(res, { tenant: T.getTenant(id), users: T.listUsers(id), usage: T.usageStats(id, 30), quota: Q.tenantQuota(id), keys: T.listKeys(id), ledger: Q.ledgerOf({ tenantId: id, limit: 30 }), classes: TE.listClasses(id) }), true;
        if (m === 'PATCH') return ok(res, { tenant: T.updateTenant(actor, id, body, ctx.ip) }), true;
        if (m === 'DELETE') { T.deleteTenant(actor, id, ctx.ip); return ok(res, { ok: true }), true; }
      }
      if (seg[2] === 'users' && seg[3] === 'import' && m === 'POST') return ok(res, T.importUsers(actor, id, body, ctx.ip)), true;
      if (seg[2] === 'users' && !seg[3] && m === 'POST') return ok(res, T.createUser(actor, id, body, ctx.ip)), true;
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
    if (seg[0] === 'users' && !seg[1] && m === 'GET') { const t = T.getTenant(tid); return ok(res, { users: T.listUsers(tid), maxUsers: t.maxUsers, isSchool: t.isSchool, classes: TE.listClasses(tid) }), true; }
    if (seg[0] === 'users' && !seg[1] && m === 'POST') return ok(res, T.createUser(actor, tid, body, ctx.ip)), true;
    if (seg[0] === 'users' && seg[1] === 'import' && !seg[2] && m === 'POST') return ok(res, T.importUsers(actor, tid, body, ctx.ip)), true;
    // 班级（院校客户）：建班、指定任课教师、删除
    if (seg[0] === 'classes') {
      if (!seg[1] && m === 'GET') return ok(res, { classes: TE.listClasses(tid), teachers: T.listUsers(tid).filter((u) => ['teacher', 'tenant_admin'].includes(u.role) && u.status === 'active').map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role })), isSchool: T.getTenant(tid).isSchool }), true;
      if (!seg[1] && m === 'POST') return ok(res, { class: TE.createClass(actor, tid, body, ctx.ip) }), true;
      if (seg[1] && !seg[2] && m === 'PATCH') return ok(res, { class: TE.updateClass(actor, seg[1], body, ctx.ip) }), true;
      if (seg[1] && !seg[2] && m === 'DELETE') { TE.deleteClass(actor, seg[1], ctx.ip); return ok(res, { ok: true }), true; }
    }
    if (seg[0] === 'users' && seg[1]) return userOps(req, res, actor, seg, body, ctx), true;
    if (seg[0] === 'logs' && m === 'GET') return ok(res, logsQuery(url, { tenantId: tid })), true;
    if (seg[0] === 'logs.csv' && m === 'GET') return sendCsv(res, logsQuery(url, { tenantId: tid }, 5000)), true;
    throw fail('API_NOT_FOUND', '接口不存在。');
  }

  /* ---------- 路由：作品（服务端保存）与批改 ---------- */
  async function teachingRoutes(req, res, p, url, ctx) {
    const m = req.method;
    if (p === '/api/works' || p.startsWith('/api/works/')) {
      const u = requireUser(ctx); // 访客的作品只存在本机浏览器，不走服务端
      const seg = p.split('/').slice(3); // [id?, 'submit'|'withdraw'?]
      if (!seg[0]) {
        if (m === 'GET') return ok(res, { works: TE.listWorks(u) }), true;
        if (m === 'POST') return ok(res, TE.addWork(u, await readBody(req))), true;
        if (m === 'DELETE') return ok(res, { ...TE.clearWorks(u), works: TE.listWorks(u) }), true;
      } else if (!seg[1]) {
        if (m === 'PATCH') { const { title } = await readBody(req); return ok(res, { work: TE.renameWork(u, seg[0], title) }), true; }
        if (m === 'DELETE') { TE.removeWork(u, seg[0]); return ok(res, { ok: true }), true; }
      } else if (m === 'POST' && seg[1] === 'submit') return ok(res, { work: TE.submitWork(u, seg[0], ctx.ip) }), true;
      else if (m === 'POST' && seg[1] === 'withdraw') return ok(res, { work: TE.withdrawWork(u, seg[0], ctx.ip) }), true;
      throw fail('API_NOT_FOUND', '接口不存在。');
    }
    if (p.startsWith('/api/teach/')) {
      const actor = requireRole(ctx, 'teacher', 'tenant_admin');
      if (actor.must_change_pw) throw fail('PASSWORD_CHANGE_REQUIRED', '请先修改初始密码。', '', 'fix');
      const seg = p.split('/').slice(3);
      const filter = { classId: url.searchParams.get('class') || '', status: url.searchParams.get('status') || '' };
      if (seg[0] === 'works' && !seg[1] && m === 'GET') return ok(res, TE.reviewList(actor, filter)), true;
      if (seg[0] === 'works.csv' && m === 'GET') return sendGradesCsv(res, TE.reviewList(actor, filter).works), true;
      if (seg[0] === 'works' && seg[1] && seg[2] === 'review' && m === 'POST') return ok(res, { work: TE.review(actor, seg[1], await readBody(req), ctx.ip) }), true;
      throw fail('API_NOT_FOUND', '接口不存在。');
    }
    return false;
  }

  const csvCell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; // 防止表格软件把单元格当公式执行
  const csvTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '');

  /** 成绩单：教师 / 学校管理员导出，用于教学留档 */
  function sendGradesCsv(res, works) {
    const head = ['班级', '账号', '姓名', '作品', '类型', '环境', '提交时间', '评分', '评语', '批改人', '批改时间', '作品地址'];
    const lines = works.map((w) => [w.className, w.student.username, w.student.name, w.title, w.type, w.mode === 'real' ? '真实环境' : '演示样例', csvTime(w.submittedAt),
      w.review ? w.review.score : '', w.review?.comment || '', w.review?.reviewer || '', csvTime(w.review?.at), /^https?:/.test(w.url) ? w.url : ''].map(csvCell).join(','));
    const t = '\uFEFF' + [head.join(','), ...lines].join('\r\n');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="grades-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
    res.end(t);
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
      return ok(res, await opCapability(ctx, () => modeOf(req, ctx), id, params, () => workspaceOf(req, ctx)));
    }
    if ((p === '/api/capability/task' || p === '/api/task') && m === 'POST') {
      const { id } = await readBody(req);
      return ok(res, await opTask(ctx, id));
    }
    if (p === '/api/tts' && m === 'POST') {
      const { text = '', purpose, qid, speedRatio, volume, pitchOffset } = await readBody(req);
      return ok(res, await opTts(ctx, () => modeOf(req, ctx), text, purpose, { qid, speedRatio, volume, pitchOffset }));
    }
    if (p === '/api/voice/list' && m === 'GET') {
      const mode = modeOf(req, ctx);
      // 未登录或演示环境：只给服务端默认音色（晓悦），下拉框不至于空着
      if (mode !== 'real' || !ctx.access.canReal) return ok(res, { voices: cfg.ttsQid ? [{ qid: cfg.ttsQid, voiceName: '晓悦', materialName: '女声-甜美-晓悦', gender: 2 }] : [] });
      return ok(res, { voices: await runtimeFor(ctx.access.vendorId, ctx.access.canBill).client.voiceList() });
    }
    if (p === '/api/avatar/list' && m === 'GET') {
      const mode = modeOf(req, ctx);
      // 未登录或演示环境：只给 8 个系统形象样例（控制台截图里那批，真实数据），选择器不至于空着
      if (mode !== 'real' || !ctx.access.canReal) return ok(res, { avatars: DEMO_AVATARS });
      return ok(res, { avatars: await runtimeFor(ctx.access.vendorId, ctx.access.canBill).client.appearanceList() });
    }
    if (p === '/api/tasks' && m === 'GET') return ok(res, await opTaskList(ctx, () => modeOf(req, ctx), url.searchParams));
    if (p === '/api/tasks/import' && m === 'POST') {
      const { ids = [] } = await readBody(req);
      return ok(res, await opTaskImport(ctx, () => modeOf(req, ctx), ids));
    }
    if (p === '/api/avatar' && m === 'POST') {
      const { text = '', audioUrl = '', duration = 0, imageUrl = '' } = await readBody(req);
      return ok(res, await opAvatar(ctx, () => modeOf(req, ctx), { text, audioUrl, duration, imageUrl }));
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
    /* ---------- 站内素材上传：登录用户传图片/音频/视频，得到本站可公开访问的地址 ---------- */
    if (p === '/api/media/upload' && m === 'POST') {
      requireUser(ctx); // 未登录不开放上传，避免公开地址被滥用
      const kind = String(req.headers['x-file-kind'] || '');
      const spec = mediaSpec(kind); // 类型不对先报，不读请求体
      let filename = '';
      try { filename = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch { filename = ''; }
      const saved = storeMedia({ dir: MEDIA_DIR, kind, filename, buffer: await readRaw(req, spec.maxBytes) });
      T.writeLog({ category: 'usage', action: 'media.upload', capability: null, mode: 'mock', detail: `${saved.name}（${Math.round(saved.size / 1024)}KB）`, ...actorOf(ctx) });
      return ok(res, { url: saved.url, name: saved.name, size: saved.size, kind });
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
    if (seg[0] === 'tts' && m === 'POST') { const b = await readBody(req); return send2(await opTts(ctx, modeFn, String(b.text || ''), 'voice', { qid: b.qid, speedRatio: b.speedRatio, volume: b.volume, pitchOffset: b.pitchOffset })); }
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
        if (await teachingRoutes(req, res, p, url, ctx)) return;
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
    if (p.startsWith('/media/')) {
      // 站内上传的素材：只认单层随机文件名，不拼用户给的路径
      const name = p.slice(7);
      if (!name || name !== path.basename(name)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
      if (serveFile(req, res, path.join(MEDIA_DIR, name), { cache: 'public, max-age=86400' })) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found');
    }
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
