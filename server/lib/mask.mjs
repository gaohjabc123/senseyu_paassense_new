// mask.mjs —— 脱敏：必须展示时用"前4位****后4位"；日志里的令牌/签名一律替换
// 规则：必须展示时一律“前4位****后4位”（≤8 位只显示 ****）；密钥、令牌、密码、邮箱、手机号不出现明文。

// 按键名识别敏感字段（不区分大小写）：appKey、authKey、userPwd、password、secret、各种 token、email、phone/mobile
export const SECRET_KEY_RE = /(appkey|app_key|authkey|auth_key|secret|password|userpwd|pwd|token|email|phone|cellphone|mobile|companyphone)/i;

export function maskValue(value, keep = 4) {
  const s = String(value ?? '');
  if (!s) return s;
  if (s.includes('****')) return s;              // 已打码的不重复处理
  return s.length <= keep * 2 ? '****' : `${s.slice(0, keep)}****${s.slice(-keep)}`;
}

/** 递归脱敏（返回新对象，不改原对象）。keepKeys 里的键名即使匹配也原样保留；dropKeys 里的键直接去掉 */
export function maskDeep(input, { keepKeys = [], dropKeys = [] } = {}, depth = 0) {
  if (depth > 8 || input == null) return input;
  if (Array.isArray(input)) return input.map((v) => maskDeep(v, { keepKeys, dropKeys }, depth + 1));
  if (typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (dropKeys.includes(k)) continue;
    const sensitive = !keepKeys.includes(k) && SECRET_KEY_RE.test(k) && !/expiresin$/i.test(k);
    if (sensitive && ((typeof v === 'string' && v) || (typeof v === 'number' && /phone|mobile/i.test(k)))) out[k] = maskValue(v);
    else out[k] = maskDeep(v, { keepKeys, dropKeys }, depth + 1);
  }
  return out;
}

/** 日志脱敏：把 token/sign/密钥 从文本里替换掉；再补邮箱与 11 位手机号 */
export function redactText(text) {
  return String(text)
    .replace(/(Bearer\s+|Bearer%20)([A-Za-z0-9._\-=+/~*]{8,})/g, (_, p, v) => `${p}${maskValue(v)}`)
    .replace(/((?<![A-Za-z])"?(accessToken|refreshToken|sign|signature|appKey|authKey|userPwd|password|rtcToken|urtcToken|sessionToken)"?\s*[:=]\s*"?)(?!(?:null|true|false)\b)([^",\s}&]+)/gi, (_, p, __, v) => `${p}${maskValue(v)}`)
    .replace(/[\w.+-]+@[\w-]+\.[A-Za-z][\w.]*/g, (m) => maskValue(m))
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, (m) => maskValue(m));
}

/** 尝试把 JSON 文本按 maskDeep 脱敏；不是 JSON 时退回 redactText */
export function maskJsonText(text, opts) {
  if (!text) return text;
  try { return JSON.stringify(maskDeep(JSON.parse(text), opts)); } catch { return redactText(text); }
}
