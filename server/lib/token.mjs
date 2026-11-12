// token.mjs —— 服务端 Token 生命周期
// · 平台返回的是「绝对过期点」：每个 Token 的剩余时长不固定，必须按平台给的过期时间计算
// · 剩余不足 REFRESH_BEFORE_MS（30 分钟）时提前重新获取，不等到过期
// · 调用返回 Token 无效（平台提前作废）时：作废缓存 → 重取一次 → 重试一次（只重试一次）
// · 并发请求合并为一次换取
import { buildTokenBody } from './sign.mjs';
import { maskValue } from './mask.mjs';
import { AppError, E, toAppError } from './errors.mjs';

export const REFRESH_BEFORE_MS = 30 * 60 * 1000;
const MIN_REUSE_MS = 60 * 1000; // 平台下发的 Token 本身就很短时，至少复用 1 分钟，避免每次调用都重新换取

/**
 * 从 Token 响应里解析过期时间点（毫秒时间戳）。
 * 优先使用平台给的绝对时间（expireTime / expiresAt / expireAt / expiredTime，秒或毫秒、或日期字符串）；
 * 只有完全没有绝对时间时才退回 expiresIn（相对秒数）。
 */
export function parseExpiry(data = {}, now = Date.now()) {
  for (const k of ['expireTime', 'expiresAt', 'expireAt', 'expiredTime', 'expiredAt']) {
    const v = data[k];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
    const t = Date.parse(String(v));
    if (Number.isFinite(t)) return t;
  }
  const sec = Number(data.expiresIn);
  if (Number.isFinite(sec) && sec > 0) return now + sec * 1000;
  return null;
}

/** 平台响应是否表示「Token 无效 / 已过期」 */
export function isTokenInvalid({ httpStatus = 0, code, message = '' } = {}, extraCodes = []) {
  if (httpStatus === 401) return true;
  if (code !== undefined && extraCodes.map(String).includes(String(code))) return true;
  const m = String(message);
  return /(token|令牌|凭证|授权|鉴权|认证)/i.test(m) && /(无效|过期|失效|invalid|expired|unauthori)/i.test(m);
}

export class TokenManager {
  constructor(cfg, { fetchImpl = (...a) => fetch(...a), log = () => {}, now = () => Date.now() } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.log = log;
    this.now = now;
    this.cached = null; // { accessToken, expiresAt, fetchedAt }
    this.inflight = null;
    this.fetchCount = 0;
    this.lastError = null;
  }

  /** 缓存是否可以直接用（剩余 ≥ 30 分钟，或刚取到且仍有效） */
  usable() {
    if (!this.cached) return false;
    const remain = this.cached.expiresAt - this.now();
    if (remain <= 5000) return false;
    if (remain >= REFRESH_BEFORE_MS) return true;
    return this.now() - this.cached.fetchedAt < MIN_REUSE_MS;
  }

  status() {
    const c = this.cached;
    const remainSec = c ? Math.max(0, Math.floor((c.expiresAt - this.now()) / 1000)) : 0;
    return {
      hasToken: !!c && remainSec > 0,
      tokenMasked: c ? maskValue(c.accessToken) : null,
      expiresAt: c ? new Date(c.expiresAt).toISOString() : null,
      refreshAt: c ? new Date(c.expiresAt - REFRESH_BEFORE_MS).toISOString() : null,
      remainSec,
      fetchedAt: c ? new Date(c.fetchedAt).toISOString() : null,
      fetchCount: this.fetchCount,
      lastError: this.lastError,
    };
  }

  invalidate() { this.cached = null; }

  async get({ force = false } = {}) {
    if (!force && this.usable()) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = this._fetchToken().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async _fetchToken() {
    const body = buildTokenBody(this.cfg.appId, this.cfg.appKey, this.cfg.tsUnit);
    let resp, json = null;
    try {
      resp = await this.fetch(`${this.cfg.baseUrl}/api/uc/v1/access/api/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.requestTimeoutMs || 20000),
      });
      const text = await resp.text();
      try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    } catch (e) {
      const err = toAppError(e);
      this.lastError = { code: err.code, message: err.message, at: new Date(this.now()).toISOString() };
      throw err;
    }
    if (!resp.ok || !json || json.code !== 0 || !json.data?.accessToken) {
      this.lastError = { code: json?.code ?? `HTTP_${resp.status}`, message: '换取 Token 失败', at: new Date(this.now()).toISOString() };
      throw E.tokenFailed(`token http=${resp.status} code=${json?.code} msg=${json?.message}`);
    }
    const now = this.now();
    const expiresAt = parseExpiry(json.data, now);
    if (!expiresAt || expiresAt <= now) {
      this.lastError = { code: 'BAD_EXPIRY', message: '平台返回的 Token 过期时间无法识别', at: new Date(now).toISOString() };
      throw E.tokenFailed('token response has no usable expiry');
    }
    this.cached = { accessToken: json.data.accessToken, expiresAt, fetchedAt: now };
    this.fetchCount += 1;
    this.lastError = null;
    this.log(`[token] 获取成功，${Math.round((expiresAt - now) / 60000)} 分钟后过期（第 ${this.fetchCount} 次获取）`);
    return this.cached;
  }

  /**
   * 带 Token 执行一次调用；若平台判定 Token 无效，作废缓存、重取一次再重试（仅一次）。
   * fn(accessToken) 失败时应抛出带 { httpStatus, platformCode, message } 的错误。
   */
  async withToken(fn, { invalidCodes = [] } = {}) {
    const first = await this.get();
    try {
      return await fn(first.accessToken);
    } catch (e) {
      if (!(e?.tokenInvalid || isTokenInvalid({ httpStatus: e?.httpStatus, code: e?.platformCode, message: e?.platformMessage }, invalidCodes))) throw e;
      this.log('[token] 平台判定 Token 无效，作废缓存并重试一次');
      this.invalidate();
      const second = await this.get({ force: true });
      try {
        return await fn(second.accessToken);
      } catch (e2) {
        if (e2 instanceof AppError) throw e2;
        if (isTokenInvalid({ httpStatus: e2?.httpStatus, code: e2?.platformCode, message: e2?.platformMessage }, invalidCodes)) {
          throw E.tokenFailed(`retry still invalid: ${e2?.platformMessage}`);
        }
        throw e2;
      }
    }
  }
}
