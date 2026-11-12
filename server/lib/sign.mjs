// sign.mjs —— 取 Token 签名：sign = MD5(appId + timestamp + appKey)，32 位小写
import crypto from 'node:crypto';

export function md5Hex(input) {
  return crypto.createHash('md5').update(String(input), 'utf8').digest('hex');
}

/** 按单位生成时间戳：ms=13 位毫秒；s=10 位秒 */
export function makeTimestamp(unit = 'ms', now = Date.now()) {
  return unit === 's' ? String(Math.floor(now / 1000)) : String(now);
}

export function makeTokenSign(appId, timestamp, appKey) {
  if (!appId || !timestamp || !appKey) throw new Error('签名参数不完整：appId/timestamp/appKey 都必须有值');
  if (!/^\d{10}$|^\d{13}$/.test(String(timestamp))) throw new Error('timestamp 必须是 10 位秒或 13 位毫秒');
  return md5Hex(`${appId}${timestamp}${appKey}`);
}

/** 换取 Token 的请求体（与官方「用户接入」文档一致） */
export function buildTokenBody(appId, appKey, unit = 'ms', now = Date.now()) {
  const timestamp = makeTimestamp(unit, now);
  return { appId, timestamp, sign: makeTokenSign(appId, timestamp, appKey), grantType: 'sign' };
}
