// real.test.mjs —— 真实模式的代码层验证：用假的平台（mock fetch）替代如影与 DeepSeek，
// 不使用任何真实密钥、不发出任何外网请求、不产生费用。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, pollUntilDone, KB_TEXT, SUPER, superClient, setupTenant, fund } from './helpers.mjs';
import { normalizeDuration } from '../server/lib/ruying.mjs';

const calls = [];
let invalidateNext = false;
let failTts = false;
const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) });

async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : null;
  const auth = init.headers?.Authorization || '';
  calls.push({ path: u.pathname, body, auth, host: u.host });
  if (u.host === 'deepseek.invalid') {
    const sse = ['资料里说', '需要 2 到 5 分钟。'].map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (u.pathname === '/api/uc/v1/access/api/token') return ok({ accessToken: `tok-${calls.length}`, expireTime: Date.now() + 8 * 3600000 });
  if (invalidateNext) { invalidateNext = false; return { ok: false, status: 401, text: async () => JSON.stringify({ code: 401, message: 'token invalid' }) }; }
  switch (u.pathname) {
    case '/api/voice/v3/tts/request':
      if (failTts) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 400123, message: '文本含不支持字符' }) };
      return ok({ taskId: 'tts-1' });
    case '/api/voice/v3/tts/result': return ok({ status: 5, audioUrl: 'https://cdn.invalid/a.mp3', duration: 6.2 });
    case '/api/2dvh/v1/material/single/image/video/create': return ok({ id: 7788 });
    case '/api/2dvh/v1/task/info': return ok([{ id: 7788, status: 5, productParam: JSON.stringify({ videoPath: 'https://cdn.invalid/v.mp4', duration: 6 }) }]);
    default: return { ok: false, status: 404, text: async () => '' };
  }
}

const ALL = ['video-image', 'voice-tts', 'nlp-chat', 'video-tts'];
let srv, s, sup;
before(async () => {
  srv = await startServer({
    fetchImpl: fakeFetch,
    env: { ...SUPER,
      RUYING_MOCK: 'false', RUYING_APP_ID: 'test-app', RUYING_APP_KEY: 'fake-key', RUYING_BASE_URL: 'https://ruying.invalid',
      RUYING_TTS_QID: 'qid-test', RUYING_AVATAR_IMAGE_URL: 'https://cdn.invalid/p.png', ALLOW_BILLABLE: 'true',
      DEEPSEEK_API_KEY: 'fake-ds', DEEPSEEK_BASE_URL: 'https://deepseek.invalid',
    },
  });
  sup = await superClient(srv);
  // 真实模式只对「开通了真实环境并分配了厂商凭据」的客户开放
  const t = await setupTenant(srv, sup, { modules: ALL, allowReal: true, allowBillable: true, vendorId: 'env' });
  await fund(sup, t.tenant.id);
  s = t.admin;
});
after(async () => { await srv.close(); });

test('duration 规整为整数秒且至少 5 秒', () => {
  assert.equal(normalizeDuration(3.2), 5);
  assert.equal(normalizeDuration(6.1), 7);
  assert.equal(normalizeDuration('12'), 12);
});

test('真实模式：访客不可用；客户 config 显示已分配；Token 仅超级管理员可见且已打码', async () => {
  assert.equal((await srv.get('/api/config', 'real')).code, 'REAL_LOGIN_REQUIRED');
  const c = await s.get('/api/config', 'real');
  assert.equal(c.data.mode, 'real'); assert.equal(c.data.ttsConfigured, true); assert.equal(c.data.llmConfigured, true);
  assert.equal(c.data.vendorManaged, true);
  assert.equal((await s.post('/api/token', {}, 'real')).data.applicable, false, '客户看不到 Token');
  const t = await sup.post('/api/token', {}, 'real');
  assert.equal(t.data.applicable, true); assert.equal(t.data.hasToken, true);
  assert.ok(t.data.tokenMasked.length <= 12 && !t.data.tokenMasked.startsWith('tok-1'.repeat(3)));
  assert.ok(t.data.expiresAt && t.data.refreshAt);
});

test('TTS 走 voice v3：request 带 qid，再轮询 result', async () => {
  calls.length = 0;
  const r = await s.post('/api/tts', { text: '欢迎体验如影数字人' }, 'real');
  assert.equal(r.code, 0, r.message);
  assert.equal(r.data.audio_url, 'https://cdn.invalid/a.mp3');
  assert.equal(r.data.duration_ms, 6200);
  const req = calls.find((c) => c.path === '/api/voice/v3/tts/request');
  assert.equal(req.body.qid, 'qid-test');
  assert.ok(calls.some((c) => c.path === '/api/voice/v3/tts/result'));
  assert.ok(!calls.some((c) => c.path.includes('/material/voice/tts')), '不应再调用已不存在的旧 TTS 路径');
});

test('图片数字人：带 videoName，param 是 JSON 字符串，duration 为整数且 ≥5；任务查询走 task/info {ids}', async () => {
  calls.length = 0;
  const c = await s.post('/api/avatar', { text: '欢迎体验', audioUrl: 'https://cdn.invalid/a.mp3', duration: 3.4 }, 'real');
  assert.equal(c.code, 0, c.message);
  const create = calls.find((x) => x.path === '/api/2dvh/v1/material/single/image/video/create');
  assert.ok(create.body.videoName);
  assert.equal(typeof create.body.param, 'string');
  assert.deepEqual(JSON.parse(create.body.param), { imageUrl: 'https://cdn.invalid/p.png', audioUrl: 'https://cdn.invalid/a.mp3', duration: 5 });
  assert.ok(!('text' in create.body), '不能原样转发 {text, audioUrl, duration}');
  const t = await pollUntilDone(s, '/api/task', c.data.taskId, 'real');
  assert.equal(t.data.status, 5); assert.equal(t.data.mode, 'real');
  assert.equal(t.data.result.videoUrl, 'https://cdn.invalid/v.mp4');
  const info = calls.find((x) => x.path === '/api/2dvh/v1/task/info');
  assert.deepEqual(info.body, { ids: [7788] });
});

test('Token 被平台提前作废：自动重取并重试一次，用户无感', async () => {
  calls.length = 0;
  invalidateNext = true;
  const r = await s.post('/api/tts', { text: '再试一次语音合成' }, 'real');
  assert.equal(r.code, 0, r.message);
  assert.equal(calls.filter((c) => c.path === '/api/uc/v1/access/api/token').length, 1, '应重新换取一次 Token');
  assert.equal(calls.filter((c) => c.path === '/api/voice/v3/tts/request').length, 2, '业务调用应重试一次');
});

test('平台报错：返回人话而不是原始错误码', async () => {
  failTts = true;
  const r = await s.post('/api/tts', { text: '这段文字会被平台拒绝' }, 'real');
  failTts = false;
  assert.equal(r.code, 'UPSTREAM_REJECTED');
  assert.match(r.message, /平台未接受这次请求/);
  assert.ok(r.hint); assert.equal(r.action, 'fix');
  assert.ok(!JSON.stringify(r).includes('400123'), '不把平台原始错误码甩给用户');
});

test('计费保护：未开启 ALLOW_BILLABLE 时拒绝计费接口', async () => {
  const guarded = await startServer({ fetchImpl: fakeFetch, env: { ...SUPER, RUYING_MOCK: 'false', RUYING_APP_ID: 'test-app', RUYING_APP_KEY: 'fake-key', RUYING_BASE_URL: 'https://ruying.invalid' } });
  try {
    const gs = await superClient(guarded);
    const gt = await setupTenant(guarded, gs, { modules: ALL, allowReal: true, allowBillable: true, vendorId: 'env' });
    await fund(gs, gt.tenant.id);
    const g = gt.admin;
    const r = await g.post('/api/capability/run', { id: 'video-image', params: { imageUrl: 'https://cdn.invalid/p.png', audioUrl: 'https://cdn.invalid/a.mp3', duration: 6 } }, 'real');
    assert.equal(r.code, 'BILLING_GUARDED'); assert.equal(r.action, 'config');
  } finally { await guarded.close(); }
});

test('网络不通：返回「连不上平台」的可读提示', async () => {
  const down = await startServer({ fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, env: { ...SUPER, RUYING_MOCK: 'false', RUYING_APP_ID: 'test-app', RUYING_APP_KEY: 'fake-key', RUYING_TTS_QID: 'q' } });
  try {
    const ds = await superClient(down);
    const dt = await setupTenant(down, ds, { modules: ALL, allowReal: true, vendorId: 'env' });
    await fund(ds, dt.tenant.id);
    const d = dt.admin;
    const r = await d.post('/api/tts', { text: '测试网络异常情况' }, 'real');
    assert.equal(r.code, 'UPSTREAM_UNREACHABLE'); assert.match(r.message, /连不上/); assert.equal(r.action, 'retry');
  } finally { await down.close(); }
});

test('知识库问答（真实模式）：命中时由 DeepSeek 流式作答，无命中时不调用大模型', async () => {
  await s.post('/api/kb/upload', { name: '手册.txt', content: KB_TEXT }, 'real');
  calls.length = 0;
  const hit = await s.sse('生成视频要多久？', 'real');
  assert.equal(hit.meta.engine, 'deepseek');
  assert.equal(hit.text, '资料里说需要 2 到 5 分钟。');
  const ds = calls.find((c) => c.host === 'deepseek.invalid');
  assert.match(ds.body.messages[1].content, /2 到 5 分钟/, '应把检索到的资料片段交给大模型');
  calls.length = 0;
  const miss = await s.sse('如何申请发票？', 'real');
  assert.equal(miss.meta.hit, false);
  assert.ok(!calls.some((c) => c.host === 'deepseek.invalid'), '无命中时不应调用大模型');
});
