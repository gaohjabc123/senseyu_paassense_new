// quota.test.mjs —— A（如影）→ B（平台）→ C/D（客户）：额度台账、扣减与退回、API 密钥与开放接口
// 用假的如影平台（mock fetch），不使用真实密钥、不访问外网。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, SUPER, superClient, setupTenant, sleep } from './helpers.mjs';

process.env.OPEN_API_RATE_PER_MIN = '40';
const plat = { ttsFail: false, taskStatus: 5 };
const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) });
async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  if (u.pathname === '/api/uc/v1/access/api/token') return ok({ accessToken: 'tok-x', expireTime: Date.now() + 8 * 3600000 });
  if (u.pathname === '/api/voice/v3/tts/request') return plat.ttsFail ? { ok: false, status: 503, text: async () => '' } : ok({ taskId: 't1' });
  if (u.pathname === '/api/voice/v3/tts/result') return ok({ status: 5, audioUrl: 'https://cdn.invalid/a.mp3', duration: 3 });
  if (u.pathname === '/api/2dvh/v1/material/single/image/video/create') return ok({ id: 9000 + Math.floor(Math.random() * 999) });
  if (u.pathname === '/api/2dvh/v1/task/info') { const id = JSON.parse(init.body).ids[0]; return ok([{ id, status: plat.taskStatus, productParam: JSON.stringify({ videoPath: 'https://cdn.invalid/v.mp4' }), failReason: '素材不合规' }]); }
  return { ok: false, status: 404, text: async () => '' };
}

let s, sup, C, D;
const ENV = { ...SUPER, RUYING_MOCK: 'false', RUYING_APP_ID: 'test-app', RUYING_APP_KEY: 'fake-key', RUYING_BASE_URL: 'https://ruying.invalid', RUYING_TTS_QID: 'qid-t', RUYING_AVATAR_IMAGE_URL: 'https://cdn.invalid/p.png', ALLOW_BILLABLE: 'true' };
const open = async (path, { key, method = 'GET', body, mode } = {}) => {
  const r = await fetch(s.base + path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(mode ? { 'X-Ruying-Mode': mode } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
};
const quotaOf = async (client) => (await client.get('/api/org/overview')).data.quota;

before(async () => {
  s = await startServer({ fetchImpl: fakeFetch, env: ENV });
  sup = await superClient(s);
  C = await setupTenant(s, sup, { name: '客户C', modules: ['video-image', 'voice-tts'], allowReal: true, allowBillable: true, vendorId: 'env' });
  D = await setupTenant(s, sup, { name: '客户D', modules: ['voice-tts'], allowReal: true, vendorId: 'env' });
});
after(async () => { await s.close(); });

test('A→B：采购台账入账；冲减不能低于已分配量', async () => {
  const r = await sup.post('/api/admin/vendors/env/purchase', { meter: 'tts_chars', amount: 1000, note: '采购单 PO-001' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.data.pool.tts_chars, { purchased: 1000, allocated: 0, unallocated: 1000, consumed: 0 });
  await sup.post('/api/admin/vendors/env/purchase', { meter: 'video_seconds', amount: 100 });
  assert.equal((await sup.post('/api/admin/vendors/env/purchase', { meter: 'bad', amount: 1 })).code, 'INVALID_INPUT');
  assert.equal((await C.admin.post('/api/admin/vendors/env/purchase', { meter: 'tts_chars', amount: 1 })).code, 'FORBIDDEN', '只有超级管理员能入账');
});

test('B→C/D：分配不能超过未分配余额；回收不能超过剩余；没有凭据的客户不能分配', async () => {
  assert.equal((await sup.post(`/api/admin/tenants/${C.tenant.id}/quota`, { op: 'allocate', meter: 'tts_chars', amount: 600 })).code, 0);
  assert.equal((await sup.post(`/api/admin/tenants/${D.tenant.id}/quota`, { op: 'allocate', meter: 'tts_chars', amount: 300 })).code, 0);
  const over = await sup.post(`/api/admin/tenants/${D.tenant.id}/quota`, { op: 'allocate', meter: 'tts_chars', amount: 200 });
  assert.equal(over.code, 'POOL_INSUFFICIENT'); assert.match(over.message, /剩 100 字/);
  assert.equal((await sup.post(`/api/admin/tenants/${D.tenant.id}/quota`, { op: 'reclaim', meter: 'tts_chars', amount: 500 })).code, 'INVALID_INPUT');
  assert.equal((await sup.post(`/api/admin/tenants/${C.tenant.id}/quota`, { op: 'allocate', meter: 'video_seconds', amount: 30 })).code, 0);
  assert.equal((await sup.post('/api/admin/vendors/env/purchase', { meter: 'tts_chars', amount: -200 })).code, 'INVALID_INPUT', '冲减后会小于已分配');
  const E = await setupTenant(s, sup, { name: '客户E（无凭据）' });
  assert.equal((await sup.post(`/api/admin/tenants/${E.tenant.id}/quota`, { op: 'allocate', meter: 'tts_chars', amount: 1 })).code, 'NO_VENDOR');
  const pool = (await sup.get('/api/admin/vendors')).data.vendors.find((v) => v.id === 'env').pool;
  assert.deepEqual(pool.tts_chars, { purchased: 1000, allocated: 900, unallocated: 100, consumed: 0 });
});

test('门户真实调用：按字数/秒数扣减；演示环境不扣；额度不足给出可读提示', async () => {
  const q0 = await quotaOf(C.admin);
  assert.equal((await C.admin.post('/api/tts', { text: '欢迎体验如影数字人', purpose: 'voice' }, 'real')).code, 0);
  assert.equal((await quotaOf(C.admin)).tts_chars.used, q0.tts_chars.used + 9);
  assert.equal((await C.admin.post('/api/tts', { text: '欢迎体验如影数字人', purpose: 'voice' }, 'mock')).code, 0);
  assert.equal((await quotaOf(C.admin)).tts_chars.used, q0.tts_chars.used + 9, '演示环境不扣额度');
  const v = await C.admin.post('/api/avatar', { text: '口播', audioUrl: 'https://cdn.invalid/a.mp3', duration: 3.2 }, 'real');
  assert.equal(v.code, 0);
  assert.equal((await quotaOf(C.admin)).video_seconds.used, 5, '视频按整数秒且至少 5 秒计');
  const big = await C.admin.post('/api/avatar', { text: '口播', audioUrl: 'https://cdn.invalid/a.mp3', duration: 40 }, 'real');
  assert.equal(big.code, 'QUOTA_EXHAUSTED'); assert.match(big.message, /需要 40 秒，剩余 25 秒/); assert.equal(big.action, 'contact');
  const me = await C.admin.get('/api/me');
  assert.equal(me.data.quota.items.video_seconds.remaining, 25);
});

test('失败退回：平台调用失败、平台任务失败都退回预扣额度', async () => {
  const before = (await quotaOf(C.admin)).tts_chars.used;
  plat.ttsFail = true;
  const r = await C.admin.post('/api/tts', { text: '这次平台会失败', purpose: 'voice' }, 'real');
  plat.ttsFail = false;
  assert.equal(r.code, 'UPSTREAM_ERROR');
  assert.equal((await quotaOf(C.admin)).tts_chars.used, before, '调用失败退回');

  const v0 = (await quotaOf(C.admin)).video_seconds.used;
  const v = await C.admin.post('/api/avatar', { text: '口播', audioUrl: 'https://cdn.invalid/a.mp3', duration: 6 }, 'real');
  assert.equal((await quotaOf(C.admin)).video_seconds.used, v0 + 6);
  plat.taskStatus = 9;
  const t = await C.admin.post('/api/task', { id: v.data.taskId }, 'real');
  plat.taskStatus = 5;
  assert.equal(t.data.status, 9);
  assert.equal((await quotaOf(C.admin)).video_seconds.used, v0, '任务失败退回');
  const ledger = (await C.admin.get('/api/org/ledger')).data.ledger;
  assert.ok(ledger.some((l) => l.kind === 'refund' && /失败/.test(l.note)));
});

let keyC, keyD;
test('API 密钥：客户管理员自助签发，原文只返回一次；列表只显示前缀', async () => {
  const r = await C.admin.post('/api/org/keys', { name: '官网后台' });
  assert.equal(r.code, 0);
  keyC = r.data.secret;
  assert.match(keyC, /^ry_[A-Za-z0-9_-]{30,}$/);
  const list = await C.admin.get('/api/org/keys');
  assert.ok(!JSON.stringify(list.data).includes(keyC), '列表不含密钥原文');
  assert.ok(list.data.keys[0].prefix.startsWith('ry_'));
  const r2 = await sup.post(`/api/admin/tenants/${D.tenant.id}/keys`, { name: 'D 的服务端', expiresDay: '2099-12-31' });
  keyD = r2.data.secret;
  assert.equal(r2.data.key.expiresDay, '2099-12-31');
  assert.equal((await C.admin.post('/api/org/keys', { name: 'x' })).code, 'INVALID_INPUT');
});

test('开放接口：鉴权、账户、按授权列出能力', async () => {
  assert.equal((await open('/open/v1/account')).status, 401);
  assert.equal((await open('/open/v1/account', { key: 'ry_' + 'x'.repeat(40) })).code, 'INVALID_API_KEY');
  const a = await open('/open/v1/account', { key: keyC });
  assert.equal(a.status, 200); assert.equal(a.data.tenant, '客户C'); assert.ok(a.requestId);
  assert.equal(a.data.quota.tts_chars.allocated, 600);
  const caps = await open('/open/v1/capabilities', { key: keyD });
  assert.deepEqual(caps.data.list.map((c) => c.id), ['voice-tts']);
});

test('开放接口：沙箱不扣额度；真实调用扣客户自己的额度（C、D 互不影响）', async () => {
  const before = (await open('/open/v1/account', { key: keyD })).data.quota.tts_chars.used;
  const sb = await open('/open/v1/tts', { key: keyD, method: 'POST', body: { text: '沙箱联调测试文本' }, mode: 'sandbox' });
  assert.equal(sb.code, 0); assert.equal(sb.data.mode, 'mock');
  const real = await open('/open/v1/tts', { key: keyD, method: 'POST', body: { text: '真实调用测试文本' } });
  assert.equal(real.code, 0); assert.equal(real.data.audio_url, 'https://cdn.invalid/a.mp3');
  assert.equal((await open('/open/v1/account', { key: keyD })).data.quota.tts_chars.used, before + 8);
  const cUsed = (await quotaOf(C.admin)).tts_chars.used;
  await open('/open/v1/tts', { key: keyD, method: 'POST', body: { text: '再来一次真实调用' } });
  assert.equal((await quotaOf(C.admin)).tts_chars.used, cUsed, 'D 的调用不扣 C 的额度');
});

test('开放接口：未开通模块 403、额度不足 402、任务只有本企业能查', async () => {
  const forb = await open('/open/v1/videos', { key: keyD, method: 'POST', body: { audioUrl: 'https://cdn.invalid/a.mp3', duration: 6 } });
  assert.equal(forb.status, 403); assert.equal(forb.code, 'MODULE_FORBIDDEN');
  const left = (await quotaOf(D.admin)).tts_chars.remaining;
  await sup.post(`/api/admin/tenants/${D.tenant.id}/quota`, { op: 'reclaim', meter: 'tts_chars', amount: left - 10, note: '测试回收' });
  const big = await open('/open/v1/tts', { key: keyD, method: 'POST', body: { text: '这段文字超过了十个字的剩余额度' } });
  assert.equal(big.status, 402); assert.equal(big.code, 'QUOTA_EXHAUSTED');
  const v = await open('/open/v1/videos', { key: keyC, method: 'POST', body: { audioUrl: 'https://cdn.invalid/a.mp3', duration: 5, name: '接口生成' } });
  assert.equal(v.code, 0, v.message);
  assert.equal((await open(`/open/v1/tasks/${v.data.taskId}`, { key: keyC })).data.status, 5);
  assert.equal((await open(`/open/v1/tasks/${v.data.taskId}`, { key: keyD })).status, 404, '别的企业查不到');
  const gen = await open('/open/v1/capabilities/voice-tts/run', { key: keyC, method: 'POST', body: { params: { text: '通用能力接口测试' } } });
  assert.equal(gen.code, 0); assert.equal(gen.data.result.mode, 'real');
});

test('开放接口：调用写入 API 类日志，账号显示为密钥名', async () => {
  const logs = await C.admin.get('/api/org/logs?category=api');
  assert.ok(logs.data.rows.length >= 2);
  assert.ok(logs.data.rows.every((r) => r.username === 'API·官网后台'));
  assert.ok(logs.data.rows.some((r) => /扣减 5 秒视频时长/.test(r.detail || '')));
});

test('吊销密钥后立即失效；限流返回 429', async () => {
  const k = (await C.admin.get('/api/org/keys')).data.keys[0];
  let last;
  for (let i = 0; i < 45; i++) last = await open('/open/v1/account', { key: keyC });
  assert.equal(last.status, 429); assert.equal(last.code, 'RATE_LIMITED');
  assert.equal((await C.admin.del(`/api/org/keys/${k.id}`)).code, 0);
  const r = await open('/open/v1/account', { key: keyC });
  assert.equal(r.status, 401); assert.equal(r.code, 'API_KEY_REVOKED');
  assert.equal((await D.admin.del(`/api/org/keys/${k.id}`)).code, 'NOT_FOUND', '不能吊销别家的密钥');
});

test('有剩余额度时不能更换厂商凭据；删除客户时剩余额度退回厂商池', async () => {
  const r = await sup.patch(`/api/admin/tenants/${D.tenant.id}`, { vendorId: null, allowReal: false });
  assert.equal(r.code, 'QUOTA_BOUND');
  const pool0 = (await sup.get('/api/admin/vendors')).data.vendors.find((v) => v.id === 'env').pool.tts_chars;
  const left = (await quotaOf(D.admin)).tts_chars.remaining;
  assert.equal((await sup.del(`/api/admin/tenants/${D.tenant.id}`)).code, 0);
  const pool1 = (await sup.get('/api/admin/vendors')).data.vendors.find((v) => v.id === 'env').pool.tts_chars;
  assert.equal(pool1.unallocated, pool0.unallocated + left);
  await sleep(1);
});
