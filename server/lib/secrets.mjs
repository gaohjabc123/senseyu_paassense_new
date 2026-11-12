// secrets.mjs —— 口令哈希（scrypt）、会话令牌、厂商密钥加密（AES-256-GCM）
import crypto from 'node:crypto';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, s, k] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const expected = Buffer.from(k, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, got);
}
/** 口令规则：至少 8 位，同时包含字母和数字 */
export function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 8) return '密码至少 8 位';
  if (s.length > 64) return '密码最多 64 位';
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return '密码需要同时包含字母和数字';
  return '';
}
/** 生成一次性初始密码（易读，避开 0/O/1/l） */
export function generatePassword() {
  const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
  const d = '23456789';
  const all = a + d;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(a), pick(d), ...Array.from({ length: 10 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
export const newSessionToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

/** 厂商密钥加密：需要服务端配置 DATA_ENCRYPTION_KEY（任意长度口令，经 SHA-256 派生为 32 字节） */
export function makeCipher(secret) {
  if (!secret) return null;
  const key = crypto.createHash('sha256').update(String(secret)).digest();
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
      return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
    },
    decrypt(blob) {
      const [v, iv, tag, enc] = String(blob).split(':');
      if (v !== 'v1') throw new Error('unknown cipher version');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
    },
  };
}
