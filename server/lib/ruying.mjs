// ruying.mjs —— 如影 PaaS 真实接口客户端（仅真实模式使用）
//
// 以下调用方式是线上实测跑通的口径，修改前务必实测：
//   · TTS：POST /api/voice/v3/tts/request（带 qid）→ 轮询 /api/voice/v3/tts/result
//   · 图片数字人：带 videoName；参数放在 param 字段，值为 JSON 字符串 {imageUrl, audioUrl, duration}
//   · 任务查询：POST /api/2dvh/v1/task/info，请求体 {"ids":[...]}
//   · duration 必须是整数秒且 ≥ 5
//
// ⚠ 本仓库基线（2.0.0）不含线上 2.1.5 的实现代码。TTS 请求/结果的字段名已按线上 2.1.5
//   实测口径修正（query 而非 text、request_id 而非 taskId，见 API_NOTES §2）；其余「待核对」
//   处合并前仍请与线上代码逐项核对。
import { isBillable } from './config.mjs';
import { AppError, E, toAppError } from './errors.mjs';

/**
 * 上游请求统一带 Accept-Language: zh-CN（2026-11-11 复测：Node 自带 fetch 默认发 "*"，
 * 平台会把 60112160 等真实错误变成 99999999；显式写 zh-CN 才能看到真实错误码）。
 */
/** 本机地址平台下载不到（课程 ch5 asr.js 原文）：localhost / 127. / 10. / 192.168. / 172.16–31.；解析失败返回 false（相对路径 media/xxx 不会被误拦） */
export function isLocalUrl(url) {
  try { return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(new URL(url).hostname); } catch { return false; }
}

export const UPSTREAM_HEADERS = { 'Accept-Language': 'zh-CN' };

export const PLATFORM = {
  // TTS 三个可调参数与控制台 voiceTest 的三个滑块一一对应：
  //   语速 speed_ratio [0.5,2]（越大越慢，控制台默认 1.25）、音量 volume [1,400]（控制台默认 200.5）、
  //   语调 pitch_offset [-60,60]（控制台默认 0）。只在显式传入时才发，不动老调用（视频口播等）的默认音色。
  ttsRequest: { path: '/api/voice/v3/tts/request', body: (text, qid, opts = {}) => {
    validateTtsParams(opts);
    const b = { qid, query: text, timeout: 30000 };
    const sr = clampNum(opts.speedRatio, 0.5, 2); if (sr != null) b.speed_ratio = sr;
    const vol = clampNum(opts.volume, 1, 400); if (vol != null) b.volume = Math.round(vol);
    const po = clampNum(opts.pitchOffset, -60, 60); if (po != null) b.pitch_offset = po;
    return b;
  } },
  ttsResult: { path: '/api/voice/v3/tts/result', body: (requestId) => ({ request_id: requestId }) },
  imageAvatar: {
    path: '/api/2dvh/v1/material/single/image/video/create',
    body: ({ videoName, imageUrl, audioUrl, duration }) => {
      if (isLocalUrl(imageUrl)) throw E.validation('图片地址是本机地址，平台下载不到，请用本站上传或公网地址。');
      if (isLocalUrl(audioUrl)) throw E.validation('音频地址是本机地址，平台下载不到，请用本站上传或公网地址。');
      return { videoName, param: JSON.stringify({ imageUrl, audioUrl, duration }) };
    },
  },
  taskInfo: { path: '/api/2dvh/v1/task/info', body: (ids) => ({ ids }) },
  // 以下为 2.6.0 真实链路新增：请求体由 server/lib/realcap.mjs 按文档构造
  videoCreate: { path: '/api/2dvh/v1/material/video/create' },
  voiceClone: { path: '/api/2dvh/v1/material/voice/clone/qid/create' },
  avatarTrain: { path: '/api/2dvh/v1/material/2davatar/model/multi/create' },
  avatarRebuild: { path: '/api/2dvh/v1/material/2davatar/model/rebuilding/video' },
  imageEdit: { path: '/api/2dvh/v1/material/single/image/edit' },
  greenImage: { path: '/api/2dvh/v1/material/2davatar/model/green/segment/image/create' },
  greenVideo: { path: '/api/2dvh/v1/material/2davatar/model/green/segment/video/create' },
  liveCreate: { path: '/api/2dvh/v2/material/live/channel/create' },
  liveStart: { path: '/api/2dvh/v1/material/live/channel/start' },
  liveHeartbeat: { path: '/api/2dvh/v1/material/live/channel/heartbeat' },
  liveCommand: { path: '/api/2dvh/v2/material/live/channel/command' },
  decorationCreate: { path: '/api/2dvh/v1/multi-video-live/decoration-tasks' },
  // 以下为 2.12.0 新增（6 个缺的能力）：请求体由 server/lib/realcap.mjs 按飞书文档构造
  contentRepoCreate: { path: '/api/2dvh/v1/material/voice/content/repository/create' },
  fileWarmingCreate: { path: '/api/2dvh/v1/material/file/warming' },
  // 以下为 2.17.0 新增（预热素材查询/删除）：文档 V1.5.2「预热素材查询/删除」
  fileWarmingQuery: { path: '/api/2dvh/v1/material/file/warming/query' },
  fileWarmingDelete: { path: '/api/2dvh/v1/material/file/warming/del' },
  fileTranscode: { path: '/api/2dvh/v1/material/file/transcode' },
  transitionCreate: { path: '/api/2dvh/v1/multi-video-live/transition-transcode-tasks' },
  multiChannelCreate: { path: '/api/2dvh/v1/multi-video-live/channel/create' },
  multiChannelStart: { path: '/api/2dvh/v1/multi-video-live/channel/start' },
  multiHeartbeat: { path: '/api/2dvh/v1/live/video-interactive/channel/heartbeat' },
  multiChannelClose: { path: '/api/2dvh/v1/live/video-interactive/channel/close' },
  // 以下为 2.16.0 新增（直播内测 / 互动直播测试 / 超级直播间控制 / 账单 / Qid 查询）：
  // 接口口径以 2026-11-17 飞书文档核查为准（文档 V1.5.2，2026-10-27）
  liveClose: { path: '/api/2dvh/v1/material/live/channel/close' },
  superProControl: { path: '/api/2dvh/v1/material/live/super/pro/channel/control' },
  multiCommandQueue: { path: '/api/2dvh/v1/live/video-interactive/channel/command/queue' },
  multiQueueList: { path: '/api/2dvh/v1/live/video-interactive/channel/command/queue/list' },
  multiPlaybackBase: { path: '/api/2dvh/v1/multi-video-live/channel' },
  multiChannelBase: { path: '/api/2dvh/v1/live/video-interactive/channel' },
  decorationTaskList: { path: '/api/2dvh/v1/multi-video-live/decoration-tasks/list' },
  transitionTaskList: { path: '/api/2dvh/v1/multi-video-live/transition-transcode-tasks/list' },
  // 以下为 2.17.0 新增（过渡视频批量删除）：文档 V1.5.2「过渡视频素材删除」
  transitionDelete: { path: '/api/2dvh/v1/multi-video-live/transition-transcode-tasks/delete' },
  billList: { path: '/api/assist/bill/list' },
  billVoiceList: { path: '/api/assist/bill/voice/list' },
  qidDetail: { path: '/api/voice/v3/tts/qid' },
};

/** duration 规整：整数秒、至少 5 秒 */
export const normalizeDuration = (sec) => Math.max(5, Math.ceil(Number(sec) || 0));

/**
 * 视频名称清洗（2026-11-13 平台客服实锤）：
 * videoName 含 ，- 等符号时，平台受理任务后一直卡在 status 0 不开始；
 * 用无符号名称则正常开始。只保留中文、字母、数字，其余全部去掉；
 * 去空后用默认名 + 时间戳兜底（纯数字，无符号）。
 */
export function sanitizeVideoName(name) {
  const clean = String(name || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').slice(0, 40);
  return clean || ('口播视频' + String(Date.now()).slice(-6));
}

/** 平台原始失败（供 TokenManager 判断是否 Token 失效） */
class PlatformError extends Error {
  constructor(httpStatus, platformCode, platformMessage) {
    super(platformMessage || `HTTP ${httpStatus}`);
    this.httpStatus = httpStatus; this.platformCode = platformCode; this.platformMessage = platformMessage || '';
  }
}

/** 在返回体里按候选字段名取值（兼容平台不同接口的命名差异） */
export function pick(obj, keys) {
  if (obj == null || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
}

/** 数值夹取：非法值返回 null（调用方直接不发该参数，不动平台默认值） */
export function clampNum(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}

/**
 * 语音合成三滑块显式校验（voice-tts 入口）：越界直接报错，不再静默夹取；
 * volume 非整数自动取整（平台只收整数）。视频 / 直播脚本类 builder 仍用各自的夹取，不动。
 */
export function validateTtsParams(opts = {}) {
  const check = (v, min, max, name) => {
    if (v === undefined || v === null || v === '') return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw E.validation(`${name} 需在 ${min}~${max} 之间，当前为 ${v}。`, '请把数值改到范围内再提交。');
  };
  check(opts.speedRatio, 0.5, 2, '语速 speedRatio');
  check(opts.pitchOffset, -60, 60, '语调 pitchOffset');
  check(opts.volume, 1, 400, '音量 volume');
}

/** 发音人列表项规整：extendParam 是 JSON 串，内含 qid、voiceName、gender */
export function normalizeVoice(r = {}) {
  let ext = {};
  try { ext = typeof r.extendParam === 'string' ? JSON.parse(r.extendParam) : (r.extendParam || {}); } catch { ext = {}; }
  return {
    id: r.id ?? null,
    qid: ext.qid || r.qid || '',
    voiceName: ext.voiceName || r.voiceName || '',
    materialName: r.materialName || ext.voiceName || '',
    gender: Number(ext.gender ?? r.gender ?? 0) || 0,
  };
}

/**
 * 公共形象（系统人物）规整：POST /api/2dvh/v1/material/appearance/list 的 result 条目。
 * extendParam 是 JSON 字符串，含 faceFeatureId / gender / avatarType（1 普通、3 交互、4 动作编辑）。
 * thumbnailUrl 是缩略图，pkgUrl 是模型 zip 包地址（视频合成 digital_role.url 用）。
 */
export function normalizeAppearance(r = {}) {
  let ext = {};
  try { ext = typeof r.extendParam === 'string' ? JSON.parse(r.extendParam) : (r.extendParam || {}); } catch { ext = {}; }
  return {
    id: r.id ?? null,
    name: r.materialName || '',
    thumbnailUrl: r.thumbnailUrl || '',
    pkgUrl: r.pkgUrl || '',
    faceFeatureId: ext.faceFeatureId || r.faceFeatureId || '',
    gender: Number(ext.gender ?? r.gender ?? 0) || 0,
    avatarType: Number(ext.avatarType ?? r.avatarType ?? 1) || 1,
  };
}

/** 语音接口 data.status 状态表（TTS / ASR / 多音字；摘自官方语音“状态表”） */
export const VOICE_STATUS = {
  0: '成功', 1000: '处理中',
  1002: 'TTS 必填参数缺失', 1003: 'TTS 发音人为空', 1004: 'TTS 合成文本为空', 1005: 'TTS 发音人不存在',
  1102: 'TTS 未连接到服务', 1103: 'TTS 繁忙', 1104: 'TTS 内部错误（2026-11-10 实测 qid 不存在也回 1104）', 1105: 'TTS 请求超时', 1106: 'TTS 未知的 request ID',
  2001: 'ASR 必填参数缺失', 2002: 'ASR 音频 URL 为空', 2102: 'ASR 未连接到服务', 2103: 'ASR 繁忙',
  2104: 'ASR 内部错误', 2105: 'ASR 请求超时', 2106: 'ASR 下载音频错误', 2107: 'ASR 未知的 request ID',
  5002: '多音字必填参数缺失', 5004: '多音字文本为空', 5102: '多音字未连接到服务', 5103: '多音字繁忙', 5104: '多音字内部错误', 5105: '多音字请求超时',
};

/** 平台任务状态表（0 未开始、1 排队中、2 生成中、3 已取消、5 已完成、9 异常） */
export const TASK_STATUS_TEXT = { 0: '未开始', 1: '排队中', 2: '生成中', 3: '已取消', 5: '已完成', 9: '异常' };

/** 把平台任务记录规整成前端使用的统一结构 */
export function normalizeTask(t, fallbackId) {
  const raw = pick(t, ['status', 'taskStatus', 'state']);
  const n = Number(raw);
  const status = raw === undefined ? 1 : (Number.isFinite(n) ? n : 1); // 保留 0（未开始），不能用 || 1（会把 0 吞成 1）
  let product = pick(t, ['productParam', 'product', 'result']);
  if (typeof product === 'string') { try { product = JSON.parse(product); } catch { product = {}; } }
  product = product || {};
  const videoUrl = pick(product, ['videoPath', 'videoUrl', 'url', 'fileUrl']) || pick(t, ['videoUrl', 'videoPath']);
  return {
    id: String(pick(t, ['id', 'taskId']) ?? fallbackId),
    status,
    statusText: TASK_STATUS_TEXT[status] || `状态 ${status}`,
    title: pick(t, ['materialName', 'name']) || '',
    raw: product, // 解析后的 productParam，供各能力提取 QID / 图片地址 / face_feature_id 等
    result: status === 5 && videoUrl ? {
      videoUrl,
      thumbUrl: pick(product, ['thumbPath', 'thumbUrl', 'coverUrl']) || '',
      duration: Number(pick(product, ['duration'])) || null,
      watermark: pick(product, ['watermark']) || 'AI生成',
    } : null,
    failReason: status === 9 ? (pick(t, ['failReason', 'errorMsg', 'message']) || '') : '',
  };
}

/** 厂商实时额度规整：把平台 resource 接口的字段映射成前端可渲染的条目数组。
 * 每项 { key, label, unit, allocated, used, remaining }；allocated 为 0 表示未开通。
 * 平台真实结构是 data.resourceConfig，下挂 {base}TotalQty / {base}UsageQty；
 * 用量可能是小数，remaining 保留两位小数。 */
export function normalizeVendorResource(data = {}) {
  const rc = data?.resourceConfig || data || {};
  const FIELDS = [
    { key: 'genVideoDuration', label: '视频合成', unit: '分钟' },
    { key: 'genImageVideoDuration', label: '图片数字人', unit: '秒' },
    { key: 'liveDuration', label: '直播', unit: '分钟' },
    { key: 'genTakeoverVideoDuration', label: '接管视频', unit: '分钟' },
    { key: 'genCharModel', label: '人物形象模型', unit: '个' },
    { key: 'genTtsCharVoiceModel', label: 'TTS 音色模型', unit: '个' },
    { key: 'genVcModel', label: '音色克隆模型', unit: '个' },
    { key: 'genEditImage', label: 'AI 图片编辑', unit: '个' },
    { key: 'videoInteractiveLive', label: '视频互动直播并发', unit: '路' },
  ];
  const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
  return FIELDS.map(({ key, label, unit }) => {
    const allocated = round2(rc[`${key}TotalQty`]);
    const used = round2(rc[`${key}UsageQty`]);
    return { key, label, unit, allocated, used, remaining: round2(allocated - used) };
  });
}

/** 从平台响应里取任务 id（整数或 {taskId} 对象） */
function taskIdOf(data, what) {
  const id = typeof data === 'object' ? pick(data, ['taskId', 'id']) : data;
  if (id === undefined || id === null || id === '') throw E.upstream(400, `${what}已提交但平台未返回任务编号`, `${what} without taskId`);
  return String(id);
}

export function createRuyingClient(cfg, tokens, { fetchImpl = (...a) => fetch(...a), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), invalidCodes = [] } = {}) {
  async function post(apiPath, payload, { billable = false } = {}) {
    if ((billable || isBillable(apiPath)) && !cfg.allowBillable) throw E.billingGuard();
    try {
      return await tokens.withToken(async (token) => {
        let resp;
        try {
          resp = await fetchImpl(`${cfg.baseUrl}${apiPath}`, {
            method: 'POST',
            headers: { ...UPSTREAM_HEADERS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(cfg.requestTimeoutMs || 20000),
          });
        } catch (e) { throw toAppError(e); }
        const text = await resp.text();
        let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
        if (!resp.ok || !j || j.code !== 0) throw new PlatformError(resp.status, j?.code, j?.message);
        return j.data;
      }, { invalidCodes });
    } catch (e) {
      if (e instanceof PlatformError) throw E.upstream(e.httpStatus || 400, e.platformMessage, `${apiPath} http=${e.httpStatus} code=${e.platformCode}`, e.platformCode);
      throw toAppError(e);
    }
  }

  async function get(apiPath) {
    try {
      return await tokens.withToken(async (token) => {
        let resp;
        try {
          resp = await fetchImpl(`${cfg.baseUrl}${apiPath}`, {
            method: 'GET',
            headers: { ...UPSTREAM_HEADERS, Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(cfg.requestTimeoutMs || 20000),
          });
        } catch (e) { throw toAppError(e); }
        const text = await resp.text();
        let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
        if (!resp.ok || !j || j.code !== 0) throw new PlatformError(resp.status, j?.code, j?.message);
        return j.data;
      }, { invalidCodes });
    } catch (e) {
      if (e instanceof PlatformError) throw E.upstream(e.httpStatus || 400, e.platformMessage, `${apiPath} http=${e.httpStatus} code=${e.platformCode}`, e.platformCode);
      throw toAppError(e);
    }
  }

  /** PUT（播放列表全量重排用；与 post 同款错误处理） */
  async function put(apiPath, payload, { billable = false } = {}) {
    if ((billable || isBillable(apiPath)) && !cfg.allowBillable) throw E.billingGuard();
    try {
      return await tokens.withToken(async (token) => {
        let resp;
        try {
          resp = await fetchImpl(`${cfg.baseUrl}${apiPath}`, {
            method: 'PUT',
            headers: { ...UPSTREAM_HEADERS, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(cfg.requestTimeoutMs || 20000),
          });
        } catch (e) { throw toAppError(e); }
        const text = await resp.text();
        let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
        if (!resp.ok || !j || j.code !== 0) throw new PlatformError(resp.status, j?.code, j?.message);
        return j.data;
      }, { invalidCodes });
    } catch (e) {
      if (e instanceof PlatformError) throw E.upstream(e.httpStatus || 400, e.platformMessage, `${apiPath} http=${e.httpStatus} code=${e.platformCode}`, e.platformCode);
      throw toAppError(e);
    }
  }

  // 发音人列表缓存（每个客户端一份，10 分钟有效）
  let voiceListCache = null;
  // 公共形象列表缓存（每个客户端一份，10 分钟有效）
  let appearanceListCache = null;

  return {
    post,
    get,

    /** 厂商实时额度：GET /api/2dvh/v1/user/config/resource，返回规整后的额度条目数组 */
    async resource() {
      const tok = await tokens.get();
      const userId = tok?.userId;
      if (!userId) throw E.upstream(400, '平台未返回用户编号，无法查询厂商额度。', 'resource without userId');
      const data = await get(`/api/2dvh/v1/user/config/resource?userId=${encodeURIComponent(userId)}`);
      return normalizeVendorResource(data);
    },

    /** TTS：提交 → 轮询结果，返回 { audio_url, duration_ms }；opts 可带 qid（选中的发音人，不传用服务端默认）与 speedRatio/volume/pitchOffset */
    async tts(text, { maxWaitMs = 60000, intervalMs = 1500, qid, speedRatio, volume, pitchOffset } = {}) {
      const useQid = qid || cfg.ttsQid;
      if (!useQid) throw new AppError({ code: 'TTS_NOT_CONFIGURED', message: '真实环境未配置配音音色。', hint: '需要管理员在服务端配置 RUYING_TTS_QID。', action: 'config' });
      const created = await post(PLATFORM.ttsRequest.path, PLATFORM.ttsRequest.body(text, useQid, { speedRatio, volume, pitchOffset }));
      // 平台返回 data: { status, request_id, result }；status 0=已完成（result 里直接有 audio_url）、1000=处理中
      if (created && Number(created.status) === 0 && created.result?.audio_url) {
        return { audio_url: created.result.audio_url, duration_ms: Number(created.result.duration_ms) || 0 };
      }
      const requestId = typeof created === 'object' ? pick(created, ['request_id', 'requestId', 'taskId', 'id']) : created;
      if (!requestId) throw E.upstream(400, '配音任务未返回编号', 'tts request without taskId');
      const until = Date.now() + maxWaitMs;
      while (Date.now() < until) {
        const r = await post(PLATFORM.ttsResult.path, PLATFORM.ttsResult.body(requestId));
        const result = r?.result || {};
        const status = Number(pick(r, ['status']));
        // 先判状态：1000 处理中继续等；0 或拿到音频地址即成功；其余失败码立即报错，不等满 60 秒
        if (status === 1000) { await sleep(intervalMs); continue; }
        const url = result.audio_url || pick(r, ['audioUrl', 'audio_url', 'url', 'fileUrl']);
        if (status === 0 || url) {
          const ms = Number(result.duration_ms) || Number(pick(r, ['durationMs', 'duration_ms'])) || (Number(pick(r, ['duration'])) * 1000) || 0;
          return { audio_url: url, duration_ms: ms };
        }
        if (Number.isNaN(status)) { await sleep(intervalMs); continue; } // 响应里没有 status：按旧口径继续等，超时再报
        throw E.upstream(400, `配音生成失败：${VOICE_STATUS[status] || `未知状态 ${status}`}`, `tts status=${status}`);
      }
      throw new AppError({ code: 'TTS_TIMEOUT', message: '配音生成时间过长。', hint: '平台可能在排队，请稍后重试。', action: 'later' });
    },

    /** 发音人列表：POST /api/2dvh/v3/material/tts/list（控制台 voiceTest 下拉框的 321 项同源）；10 分钟缓存，按 qid 去重 */
    async voiceList() {
      const now = Date.now();
      if (voiceListCache && now - voiceListCache.at < 10 * 60 * 1000) return voiceListCache.items;
      const items = [];
      for (let pageNo = 1; pageNo <= 20; pageNo += 1) {
        const d = await post('/api/2dvh/v3/material/tts/list', { pageNo, pageSize: 100 });
        const rows = Array.isArray(d?.result) ? d.result : (Array.isArray(d) ? d : []);
        for (const r of rows) items.push(normalizeVoice(r));
        if (rows.length < 100) break;
      }
      const seen = new Set(); const out = [];
      for (const it of items) { if (!it.qid || seen.has(it.qid)) continue; seen.add(it.qid); out.push(it); }
      voiceListCache = { at: now, items: out };
      return out;
    },

    /** 公共形象列表：POST /api/2dvh/v1/material/appearance/list（控制台“系统人物”同源）；10 分钟缓存，按 id 去重；只读查询、不计费 */
    async appearanceList() {
      const now = Date.now();
      if (appearanceListCache && now - appearanceListCache.at < 10 * 60 * 1000) return appearanceListCache.items;
      const items = [];
      for (let pageNo = 1; pageNo <= 5; pageNo += 1) {
        const d = await post('/api/2dvh/v1/material/appearance/list', { pageNo, pageSize: 100 });
        const rows = Array.isArray(d?.result) ? d.result : (Array.isArray(d) ? d : []);
        for (const r of rows) items.push(normalizeAppearance(r));
        if (rows.length < 100) break;
      }
      const seen = new Set(); const out = [];
      for (const it of items) { if (it.id == null || seen.has(it.id)) continue; seen.add(it.id); out.push(it); }
      appearanceListCache = { at: now, items: out };
      return out;
    },

    /** 图片数字人：返回平台任务编号（videoName 先清洗，含符号会被平台卡住） */
    async createImageAvatar({ imageUrl, audioUrl, duration, videoName }) {
      const data = await post(PLATFORM.imageAvatar.path, PLATFORM.imageAvatar.body({ videoName: sanitizeVideoName(videoName), imageUrl, audioUrl, duration: normalizeDuration(duration) }), { billable: true });
      const id = typeof data === 'object' ? pick(data, ['taskId', 'id', 'videoId']) : data;
      if (!id) throw E.upstream(400, '任务已提交但平台未返回任务编号', 'avatar create without id');
      return String(id);
    },

    /** 任务查询：返回规整后的任务 */
    async taskInfo(id) {
      const data = await post(PLATFORM.taskInfo.path, PLATFORM.taskInfo.body([Number.isNaN(Number(id)) ? id : Number(id)]));
      const list = Array.isArray(data) ? data : (pick(data, ['list', 'records', 'tasks', 'items']) || [data]);
      const item = list.find((t) => String(pick(t, ['id', 'taskId'])) === String(id)) || list[0];
      if (!item) throw E.notFound('平台上找不到这个任务。', '任务可能已过期，请重新生成。');
      return normalizeTask(item, id);
    },

    /** 批量查任务状态：POST /api/2dvh/v1/task/info（ids 数组），返回规整后的任务数组（任务中心列表刷新与历史导入共用） */
    async taskInfoMany(ids) {
      const list = [...new Set((ids || []).map(String))].filter(Boolean);
      if (!list.length) return [];
      const data = await post(PLATFORM.taskInfo.path, PLATFORM.taskInfo.body(list.map((id) => (Number.isNaN(Number(id)) ? id : Number(id)))));
      const arr = Array.isArray(data) ? data : (pick(data, ['list', 'records', 'tasks', 'items']) || [data]);
      return arr.map((item) => normalizeTask(item, pick(item, ['id', 'taskId'])));
    },

    /** 视频合成（video/create）：提交已构造好的 videoName + param，返回任务编号 */
    async createVideoTask({ videoName, param }) {
      const data = await post(PLATFORM.videoCreate.path, { videoName, param }, { billable: true });
      return taskIdOf(data, '视频合成');
    },

    /** 音色复刻：提交训练任务，返回任务编号（QID 训练完成后在任务结果里） */
    async cloneVoice(body) {
      const data = await post(PLATFORM.voiceClone.path, body, { billable: true });
      return taskIdOf(data, '音色复刻');
    },

    /** 形象复刻：提交训练任务，返回任务编号 */
    async trainAvatar(body) {
      const data = await post(PLATFORM.avatarTrain.path, body, { billable: true });
      return taskIdOf(data, '形象复刻');
    },

    /** 人物模型更新：提交重建任务，返回任务编号 */
    async rebuildAvatar(body) {
      const data = await post(PLATFORM.avatarRebuild.path, body, { billable: true });
      return taskIdOf(data, '模型更新');
    },

    /** AI 图片编辑：提交异步任务，返回任务编号 */
    async editImage(body) {
      const data = await post(PLATFORM.imageEdit.path, body, { billable: true });
      return taskIdOf(data, '图片编辑');
    },

    /** 绿幕分割效果预览：kind 为 image 或 video，返回任务编号 */
    async greenPreview(kind, body) {
      const path = kind === 'video' ? PLATFORM.greenVideo.path : PLATFORM.greenImage.path;
      const data = await post(path, body, { billable: false });
      return taskIdOf(data, '绿幕预览');
    },

    /** 直播：创建直播间（创建即开始计时），返回会话信息 */
    async createLiveChannel(body) {
      const data = await post(PLATFORM.liveCreate.path, body, { billable: true });
      if (!data || typeof data !== 'object' || !data.sessionId) throw E.upstream(400, '直播间创建未返回会话编号', 'live create without sessionId');
      return data;
    },

    /** 直播：开播 / 心跳（60 秒一次，心跳丢失超阈值会被动关闭） */
    async liveStart(sessionId) {
      return post(PLATFORM.liveStart.path, { sessionId }, { billable: false });
    },
    async liveHeartbeat(sessionId) {
      return post(PLATFORM.liveHeartbeat.path, { sessionId }, { billable: false });
    },

    /** 直播：关闭直播间（只传 sessionId；不用时须调，否则占用路数；10 分钟无心跳自动断播） */
    async liveClose(sessionId) {
      return post(PLATFORM.liveClose.path, { sessionId }, { billable: false });
    },

    /** 超级直播间 Pro：接管控制（切换数字人 / 前景 / 背景；param 为 JSON 串；只表示接收成功） */
    async superProControl(sessionId, param) {
      return post(PLATFORM.superProControl.path, { sessionId, param: JSON.stringify(param) }, { billable: false });
    },

    /** 视频互动直播：接管入队（type 0 语音播报 / 1 语音输入 / 2 接管脚本；commandTraceId 幂等） */
    async multiCommandQueue(body) {
      return post(PLATFORM.multiCommandQueue.path, body, { billable: false });
    },
    async multiQueueList(sessionId) {
      return get(`${PLATFORM.multiQueueList.path}?sessionId=${encodeURIComponent(sessionId)}`);
    },
    /** 视频互动直播：播放顺序查询 / 全量重排 / 切换当前素材 */
    async multiPlayback(sessionId) {
      return get(`${PLATFORM.multiPlaybackBase.path}/${encodeURIComponent(sessionId)}/playback`);
    },
    async multiPlayMaterials(sessionId, materialIds) {
      return put(`${PLATFORM.multiPlaybackBase.path}/${encodeURIComponent(sessionId)}/play-materials`, materialIds, { billable: false });
    },
    async multiPlaySwitch(sessionId, materialId) {
      return post(`${PLATFORM.multiPlaybackBase.path}/${encodeURIComponent(sessionId)}/play-materials/switch`, { materialId }, { billable: false });
    },
    /** 视频互动直播：直播间状态 / 运行中列表 / 历史列表 / 装修与过渡素材状态 */
    async multiChannelStatus(sessionId) {
      return get(`${PLATFORM.multiChannelBase.path}/${encodeURIComponent(sessionId)}`);
    },
    async multiRunning() {
      return get(`${PLATFORM.multiChannelBase.path}/running`);
    },
    async multiHistory() {
      return get(`${PLATFORM.multiChannelBase.path}/history`);
    },
    async decorationTaskList(taskIds) {
      return post(PLATFORM.decorationTaskList.path, { taskIds }, { billable: false });
    },
    async transitionTaskList(taskIds) {
      return post(PLATFORM.transitionTaskList.path, { taskIds }, { billable: false });
    },

    /** 过渡视频：按任务批量删除（体 {taskIds}，只读查询不扣额度，删除本身不计费） */
    async transitionDelete(taskIds) {
      return post(PLATFORM.transitionDelete.path, { taskIds }, { billable: false });
    },

    /** 账单：非语音任务明细 / 语音按日按月统计（只读查询，不扣额度） */
    async billList(body) {
      return post(PLATFORM.billList.path, body, { billable: false });
    },
    async billVoiceList(body) {
      return post(PLATFORM.billVoiceList.path, body, { billable: false });
    },

    /** Qid 查询：发音人详情（是否支持调音调/语速/音量、音素、字幕、USSML 标签、支持语言） */
    async qidDetail(qid) {
      return get(`${PLATFORM.qidDetail.path}/${encodeURIComponent(qid)}`);
    },

    /** 直播接管：把一段文案推给数字人播报，返回 {isSuccess, commandTraceId} */
    async liveCommand(sessionId, param) {
      return post(PLATFORM.liveCommand.path, { sessionId, param: JSON.stringify(param) }, { billable: false });
    },

    /** 视频互动直播：创建装修任务，返回父任务 id（整数） */
    async createDecorationTask(body) {
      const data = await post(PLATFORM.decorationCreate.path, body, { billable: true });
      return taskIdOf(data, '装修任务');
    },

    /** 视频互动直播：查询装修任务状态（GET） */
    async decorationTaskStatus(id) {
      return get(`${PLATFORM.decorationCreate.path}/${encodeURIComponent(id)}`);
    },

    /** 口水词库：创建内容预热（快速问答库），返回任务编号 */
    async createContentRepo(body) {
      const data = await post(PLATFORM.contentRepoCreate.path, body, { billable: true });
      return taskIdOf(data, '口水词库');
    },

    /** 预热素材：提交 FileId 预热，返回任务编号 */
    async warmFile(body) {
      const data = await post(PLATFORM.fileWarmingCreate.path, body, { billable: true });
      return taskIdOf(data, '预热素材');
    },

    /** 预热素材：按 fileIds 批量查询状态（GET，fileIds 为逗号分隔的 URL 查询参数） */
    async warmFileQuery(fileIds) {
      return get(`${PLATFORM.fileWarmingQuery.path}?fileIds=${encodeURIComponent(fileIds.join(','))}`);
    },

    /** 预热素材：按 fileIds 批量删除（POST，体 {fileIds}，返回任务 id） */
    async warmFileDelete(fileIds) {
      return post(PLATFORM.fileWarmingDelete.path, { fileIds }, { billable: false });
    },

    /** 视频转码：提交转码任务，返回任务编号 */
    async transcodeFile(body) {
      const data = await post(PLATFORM.fileTranscode.path, body, { billable: true });
      return taskIdOf(data, '视频转码');
    },

    /** 过渡视频预处理：提交预处理任务，返回父任务编号 */
    async createTransitionTask(body) {
      const data = await post(PLATFORM.transitionCreate.path, body, { billable: true });
      return taskIdOf(data, '过渡视频预处理');
    },

    /** 视频互动直播：创建直播任务，返回会话信息 */
    async createMultiChannel(body) {
      const data = await post(PLATFORM.multiChannelCreate.path, body, { billable: true });
      if (!data || typeof data !== 'object' || !data.sessionId) throw E.upstream(400, '互动直播创建未返回会话编号', 'multi-live create without sessionId');
      return data;
    },
    async multiChannelStart(sessionId) {
      return post(PLATFORM.multiChannelStart.path, { sessionId }, { billable: false });
    },
    async multiHeartbeat(sessionId) {
      return post(PLATFORM.multiHeartbeat.path, { sessionId }, { billable: false });
    },
    async multiChannelClose(sessionId) {
      return post(PLATFORM.multiChannelClose.path, { sessionId }, { billable: false });
    },
  };
}
