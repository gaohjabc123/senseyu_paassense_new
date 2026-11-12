// config.mjs —— 运行配置：优先读 process.env，读不到再回退到项目根目录 .env（自解析，不依赖 dotenv）
// 密钥只在服务端使用，任何字段都不会原样下发前端。
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');

export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * @param {object} env   环境变量来源（默认 process.env）
 * @param {object} file  .env 文件内容（默认读取项目根目录 .env；测试可传 {} 隔离）
 */
export function getConfig(env = process.env, file = loadDotEnv()) {
  const pick = (k, d = '') => {
    const v = env[k];
    if (v !== undefined && v !== '') return String(v);
    const f = file[k];
    if (f !== undefined && f !== '') return String(f);
    return d;
  };
  const appId = pick('RUYING_APP_ID');
  const appKey = pick('RUYING_APP_KEY');
  const wantReal = pick('RUYING_MOCK', 'true').toLowerCase() === 'false';
  const placeholder = (v) => !v || /^mock[-_]/i.test(v);
  const hasCredentials = !placeholder(appId) && !placeholder(appKey);

  const warnings = [];
  if (wantReal && !hasCredentials) warnings.push('RUYING_MOCK=false 但缺少 RUYING_APP_ID / RUYING_APP_KEY，已回退到演示模式');
  const tsUnit = pick('SIGN_TS_UNIT', 'ms');
  if (!['ms', 's'].includes(tsUnit)) throw new Error(`SIGN_TS_UNIT 只能是 ms 或 s，当前：${tsUnit}`);

  return {
    root: ROOT,
    defaultMode: wantReal && hasCredentials ? 'real' : 'mock',
    realAvailable: hasCredentials,
    warnings,
    appId,
    appKey,
    baseUrl: pick('RUYING_BASE_URL', 'https://aigc.softsugar.com').replace(/\/+$/, ''),
    tsUnit,
    ttsQid: pick('RUYING_TTS_QID'),
    avatarImageUrl: pick('RUYING_AVATAR_IMAGE_URL'),
    allowBillable: pick('ALLOW_BILLABLE', 'false').toLowerCase() === 'true',
    deepseekKey: pick('DEEPSEEK_API_KEY'),
    deepseekBaseUrl: pick('DEEPSEEK_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
    deepseekModel: pick('DEEPSEEK_MODEL', 'deepseek-chat'),
    kbDir: pick('KB_DIR', path.join(ROOT, 'data')),
    dbFile: pick('DB_FILE', path.join(pick('KB_DIR', path.join(ROOT, 'data')), 'ruying.db')),
    dataEncryptionKey: pick('DATA_ENCRYPTION_KEY'),
    superAdminUsername: pick('SUPER_ADMIN_USERNAME'),
    superAdminPassword: pick('SUPER_ADMIN_PASSWORD'),
    publicDemo: pick('PUBLIC_DEMO', 'true').toLowerCase() !== 'false',
    logRetentionDays: Number(pick('LOG_RETENTION_DAYS', 180)),
    cookieSecure: pick('COOKIE_SECURE', 'auto'),
    mockTaskMs: Number(pick('MOCK_TASK_MS', 1400)),
    mockSseDelayMs: Number(pick('MOCK_SSE_DELAY_MS', 15)),
    requestTimeoutMs: Number(pick('UPSTREAM_TIMEOUT_MS', 20000)),
  };
}

export const BILLABLE_PATHS = [
  '/api/2dvh/v1/material/video/create',
  '/api/2dvh/v1/material/video/batchCreate',
  '/api/2dvh/v1/material/single/image/video/create',
  '/api/2dvh/v1/material/single/image/edit',
  '/api/2dvh/v1/material/face/swap/create',
  '/api/2dvh/v1/material/2davatar/model/multi/create',
  '/api/2dvh/v1/material/2davatar/model/rebuilding/video',
];

export function isBillable(pathname) {
  return BILLABLE_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}
