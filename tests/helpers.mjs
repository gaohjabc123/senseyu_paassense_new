// helpers.mjs —— 测试工具：在进程内启动服务（随机端口、内存数据库、临时知识库目录、可注入 fetch）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.mjs';
import { getConfig } from '../server/lib/config.mjs';

export const quietLog = { log() {}, warn() {}, error() {} };

/** env 只用传入的值，不读真实 .env 与 process.env，保证测试与本机密钥隔离 */
export async function startServer({ env = {}, fetchImpl } = {}) {
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruying-kb-'));
  const cfg = { ...getConfig({ MOCK_TASK_MS: '150', MOCK_SSE_DELAY_MS: '0', ...env }, {}), kbDir, dbFile: ':memory:' };
  const server = createServer({ cfg, fetchImpl, log: quietLog });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  function client(cookie = '', ws = `test-${Math.random().toString(36).slice(2, 12)}`) {
    const headers = (mode) => ({ 'Content-Type': 'application/json', 'X-Requested-With': 'ruying', 'X-Workspace-Id': ws, ...(mode ? { 'X-Ruying-Mode': mode } : {}), ...(cookie ? { Cookie: cookie } : {}) });
    const call = async (method, p, body, mode) => {
      const r = await fetch(base + p, { method, headers: headers(mode), body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
      return { status: r.status, setCookie: r.headers.get('set-cookie'), contentType: r.headers.get('content-type'), ...j };
    };
    return {
      ws, headers, cookie,
      get: (p, mode) => call('GET', p, undefined, mode),
      post: (p, body, mode) => call('POST', p, body ?? {}, mode),
      patch: (p, body, mode) => call('PATCH', p, body ?? {}, mode),
      del: (p, mode) => call('DELETE', p, undefined, mode),
      async sse(text, mode) {
        const r = await fetch(base + '/api/chat', { method: 'POST', headers: headers(mode), body: JSON.stringify({ text }) });
        const raw = await r.text();
        if (!raw.startsWith(':')) return { json: JSON.parse(raw) };
        const events = [...raw.matchAll(/event: (\w+)\ndata: (.+)/g)].map((m) => ({ event: m[1], data: JSON.parse(m[2]) }));
        return {
          meta: events.find((e) => e.event === 'meta')?.data,
          text: events.filter((e) => e.event === 'message').map((e) => e.data.delta).join(''),
          done: events.find((e) => e.event === 'done')?.data,
          error: events.find((e) => e.event === 'error')?.data,
        };
      },
    };
  }

  const anon = client();
  return {
    base, cfg, kbDir, ...anon, client,
    /** 登录并返回带会话的客户端 */
    async login(username, password) {
      const r = await anon.post('/api/auth/login', { username, password });
      if (r.code !== 0) throw new Error(`登录失败：${r.code} ${r.message}`);
      return client(r.setCookie.split(';')[0]);
    },
    async close() { await new Promise((r) => server.close(r)); fs.rmSync(kbDir, { recursive: true, force: true }); },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const today = (offset = 0) => new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10);

export const SUPER = { SUPER_ADMIN_USERNAME: 'root', SUPER_ADMIN_PASSWORD: 'Bootstrap1pw' }; // 测试用示例口令

/** 登录超级管理员并完成首次改密 */
export async function superClient(s) {
  const c = await s.login('root', 'Bootstrap1pw'); // 测试用示例口令
  const r = await c.post('/api/auth/password', { oldPassword: 'Bootstrap1pw', newPassword: 'Changed1pw' }); // 测试用示例口令
  if (r.code !== 0 && r.code !== 'BAD_CREDENTIALS') throw new Error(r.message);
  return r.code === 0 ? c : s.login('root', 'Changed1pw');
}

/** 由超级管理员创建客户，并以客户管理员身份登录（完成首次改密） */
export async function setupTenant(s, sup, overrides = {}) {
  const name = overrides.name || `客户${Math.random().toString(36).slice(2, 7)}`;
  const username = overrides.adminUsername || `adm_${Math.random().toString(36).slice(2, 8)}`;
  const r = await sup.post('/api/admin/tenants', {
    name, plan: 'trial', startsDay: today(-1), expiresDay: today(13), maxUsers: 5,
    modules: ['video-image', 'voice-tts', 'nlp-chat'], ...overrides, admin: { username },
  });
  if (r.code !== 0) throw new Error(`创建客户失败：${r.code} ${r.message}`);
  const first = await s.login(username, r.data.admin.initialPassword);
  await first.post('/api/auth/password', { oldPassword: r.data.admin.initialPassword, newPassword: 'Tenant1pass' });
  return { tenant: r.data.tenant, admin: await s.login(username, 'Tenant1pass'), username };
}

export async function pollUntilDone(c, endpoint, id, mode) {
  for (let i = 0; i < 50; i++) {
    const t = await c.post(endpoint, { id }, mode);
    if (t.code !== 0) return t;
    if (t.data.status === 5 || t.data.status === 9) return t;
    await sleep(50);
  }
  throw new Error('任务未在预期时间内完成');
}

export const KB_TEXT = `如影数字人产品手册

一、产品简介
如影是商予科技推出的数字人内容生产平台，支持视频合成、语音合成与形象复刻。

二、视频合成
文本驱动视频合成：输入一段文案，系统自动配音并驱动数字人生成口播视频。
生成一条 30 秒的视频通常需要 2 到 5 分钟，高峰期可能需要排队。

三、计费说明
视频合成按成片时长计费，语音合成按字数计费。演示环境不产生任何费用。
`;

/** 超级管理员：给厂商池入账，并给客户分配额度（真实模式调用需要额度） */
export async function fund(sup, tenantId, vendorId = 'env', amounts = { video_seconds: 600, tts_chars: 5000, api_calls: 100 }) {
  for (const [meter, amount] of Object.entries(amounts)) {
    const p = await sup.post(`/api/admin/vendors/${vendorId}/purchase`, { meter, amount: amount * 10, note: '测试采购' });
    if (p.code !== 0) throw new Error(`入账失败：${p.message}`);
    const a = await sup.post(`/api/admin/tenants/${tenantId}/quota`, { op: 'allocate', meter, amount });
    if (a.code !== 0) throw new Error(`分配失败：${a.message}`);
  }
}
