// mask.mjs —— 脱敏：必须展示时用"前4位****后4位"；日志里的令牌/签名一律替换
export function maskValue(value) {
  const s = String(value ?? '');
  if (!s) return s;
  if (s.includes('****')) return s;
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

/** 日志脱敏：把 token/sign/密钥 从文本里替换掉 */
export function redactText(text) {
  return String(text)
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]{12,}/g, '$1****')
    .replace(/("?(?:accessToken|refreshToken|sign|appKey|authKey|api_key)"?\s*[:=]\s*"?)([A-Za-z0-9\-._~+/]{8,})/gi, '$1****');
}
