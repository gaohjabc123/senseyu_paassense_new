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

export const PLATFORM = {
  ttsRequest: { path: '/api/voice/v3/tts/request', body: (text, qid) => ({ qid, query: text, timeout: 30000 }) },
  ttsResult: { path: '/api/voice/v3/tts/result', body: (requestId) => ({ request_id: requestId }) },
  imageAvatar: {
    path: '/api/2dvh/v1/material/single/image/video/create',
    body: ({ videoName, imageUrl, audioUrl, duration }) => ({ videoName, param: JSON.stringify({ imageUrl, audioUrl, duration }) }),
  },
  taskInfo: { path: '/api/2dvh/v1/task/info', body: (ids) => ({ ids }) },
};

/** duration 规整：整数秒、至少 5 秒 */
export const normalizeDuration = (sec) => Math.max(5, Math.ceil(Number(sec) || 0));

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

export const TASK_STATUS_TEXT = { 1: '未开始（平台排队中）', 2: '生成中', 5: '已完成', 9: '失败' };

/** 把平台任务记录规整成前端使用的统一结构 */
export function normalizeTask(t, fallbackId) {
  const status = Number(pick(t, ['status', 'taskStatus', 'state'])) || 1;
  let product = pick(t, ['productParam', 'product', 'result']);
  if (typeof product === 'string') { try { product = JSON.parse(product); } catch { product = {}; } }
  product = product || {};
  const videoUrl = pick(product, ['videoPath', 'videoUrl', 'url', 'fileUrl']) || pick(t, ['videoUrl', 'videoPath']);
  return {
    id: String(pick(t, ['id', 'taskId']) ?? fallbackId),
    status,
    statusText: TASK_STATUS_TEXT[status] || `状态 ${status}`,
    result: status === 5 && videoUrl ? {
      videoUrl,
      thumbUrl: pick(product, ['thumbPath', 'thumbUrl', 'coverUrl']) || '',
      duration: Number(pick(product, ['duration'])) || null,
      watermark: pick(product, ['watermark']) || 'AI生成',
    } : null,
    failReason: status === 9 ? (pick(t, ['failReason', 'errorMsg', 'message']) || '') : '',
  };
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
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
      if (e instanceof PlatformError) throw E.upstream(e.httpStatus || 400, e.platformMessage, `${apiPath} http=${e.httpStatus} code=${e.platformCode}`);
      throw toAppError(e);
    }
  }

  return {
    post,

    /** TTS：提交 → 轮询结果，返回 { audio_url, duration_ms } */
    async tts(text, { maxWaitMs = 60000, intervalMs = 1500 } = {}) {
      if (!cfg.ttsQid) throw new AppError({ code: 'TTS_NOT_CONFIGURED', message: '真实环境未配置配音音色。', hint: '需要管理员在服务端配置 RUYING_TTS_QID。', action: 'config' });
      const created = await post(PLATFORM.ttsRequest.path, PLATFORM.ttsRequest.body(text, cfg.ttsQid));
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
        const url = result.audio_url || pick(r, ['audioUrl', 'audio_url', 'url', 'fileUrl']);
        const status = Number(pick(r, ['status']));
        if (url) {
          const ms = Number(result.duration_ms) || Number(pick(r, ['durationMs', 'duration_ms'])) || (Number(pick(r, ['duration'])) * 1000) || 0;
          return { audio_url: url, duration_ms: ms };
        }
        if (status === 9 || status === 3) throw E.upstream(400, '配音生成失败', `tts status=${status}`);
        await sleep(intervalMs);
      }
      throw new AppError({ code: 'TTS_TIMEOUT', message: '配音生成时间过长。', hint: '平台可能在排队，请稍后重试。', action: 'later' });
    },

    /** 图片数字人：返回平台任务编号 */
    async createImageAvatar({ imageUrl, audioUrl, duration, videoName }) {
      const data = await post(PLATFORM.imageAvatar.path, PLATFORM.imageAvatar.body({ videoName, imageUrl, audioUrl, duration: normalizeDuration(duration) }), { billable: true });
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
  };
}
