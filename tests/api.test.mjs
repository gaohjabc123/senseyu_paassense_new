// api.test.mjs —— 后端冒烟测试（演示模式，不需要任何平台密钥）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer, pollUntilDone, KB_TEXT } from './helpers.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
let s;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); });

test('安全：写请求缺少 X-Requested-With 头时被拒绝（防跨站伪造）', async () => {
  const r = await fetch(s.base + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '欢迎体验如影数字人' }) }).then((x) => x.json());
  assert.equal(r.code, 'FORBIDDEN');
});

test('health：返回服务名与 package.json 中的版本号（单一来源）', async () => {
  const j = await s.get('/api/health');
  assert.equal(j.code, 0);
  assert.equal(j.data.status, 'ok');
  assert.equal(j.data.version, pkg.version);
  assert.equal(j.data.defaultMode, 'mock');
  assert.equal(j.data.capabilities, 15);
  assert.match(j.data.version, /^\d+\.\d+\.\d+$/);
});

test('config：不下发任何密钥字段；未配置凭据时真实环境不可用', async () => {
  const j = await s.get('/api/config');
  assert.equal(j.code, 0);
  assert.equal(j.data.mode, 'mock');
  assert.equal(j.data.realAvailable, false);
  const text = JSON.stringify(j.data);
  for (const k of ['appKey', 'APP_KEY', 'deepseekKey', 'accessToken']) assert.ok(!text.includes(k), `不应出现 ${k}`);
});

test('mode：访客切换真实环境被拒绝，并返回可读的原因与下一步', async () => {
  const j = await s.post('/api/mode', { mode: 'real' });
  assert.equal(j.code, 'REAL_LOGIN_REQUIRED');
  assert.ok(j.message && j.hint && j.action, '错误必须包含 message / hint / action');
  assert.equal((await s.post('/api/mode', { mode: 'hack' })).code, 'INVALID_INPUT');
  assert.equal((await s.get('/api/config', 'real')).code, 'REAL_LOGIN_REQUIRED', '请求头声明 real 也不能绕过');
});

test('额度：不再提供写死的 /api/quota 假数据', async () => {
  const j = await s.get('/api/quota');
  assert.equal(j.status, 404);
});

test('capabilities：15 项能力、6 大类，与前端共用同一数据源', async () => {
  const j = await s.get('/api/capabilities');
  assert.equal(j.data.total, 15);
  assert.equal(j.data.groups, 6);
  assert.equal(j.data.total, j.data.stats.capabilities);
});

test('capability/run：全部 15 项能力在演示模式下都能跑通，结果标注为演示', async () => {
  const list = (await s.get('/api/capabilities')).data.list;
  for (const c of list) {
    const detail = await s.get('/api/capability?id=' + c.id);
    const params = Object.fromEntries(detail.data.experience.fields.map((f) => [f.key, f.default ?? '']));
    const r = await s.post('/api/capability/run', { id: c.id, params });
    assert.equal(r.code, 0, `${c.id}：${r.message}`);
    let result = r.data.result;
    if (!r.data.sync) {
      const t = await pollUntilDone(s, '/api/capability/task', r.data.taskId);
      assert.equal(t.data.status, 5, `${c.id} 任务未完成`);
      result = t.data.result;
    }
    assert.equal(result.capabilityId, c.id);
    assert.equal(result.mode, 'mock', `${c.id} 结果必须标注为演示`);
  }
});

test('capability/run：未知能力与过短文案返回可读错误', async () => {
  const a = await s.post('/api/capability/run', { id: 'nope', params: {} });
  assert.equal(a.code, 'NOT_FOUND'); assert.ok(a.hint);
  const b = await s.post('/api/tts', { text: '短' });
  assert.equal(b.code, 'INVALID_INPUT'); assert.match(b.message, /至少 4 个字/);
});

test('视频口播链路：TTS → 图片数字人 → 任务 1→5，素材为相对路径', async () => {
  const tts = await s.post('/api/tts', { text: '欢迎体验如影数字人' });
  assert.equal(tts.code, 0);
  assert.match(tts.data.audio_url, /^files\/mock_tts\.mp3$/);
  const c = await s.post('/api/avatar', { text: '欢迎体验', audioUrl: tts.data.audio_url, duration: 3 });
  assert.equal(c.code, 0);
  const first = await s.post('/api/task', { id: c.data.taskId });
  assert.equal(first.data.status, 1);
  assert.ok(first.data.statusText.includes('未开始'));
  const t = await pollUntilDone(s, '/api/task', c.data.taskId);
  assert.equal(t.data.status, 5);
  assert.match(t.data.result.videoUrl, /^files\//);
  assert.equal((await s.post('/api/task', { id: '999999' })).code, 'NOT_FOUND');
});

test('知识库：空库 → 上传 → 重复提示 → 命中 / 无命中 → 删除', async () => {
  let r = await s.sse('生成视频要多久？');
  assert.equal(r.meta.hit, false); assert.equal(r.meta.reason, 'empty-kb');
  assert.match(r.text, /知识库还是空的/);

  const up = await s.post('/api/kb/upload', { name: '手册.txt', content: KB_TEXT });
  assert.equal(up.code, 0); assert.equal(up.data.docs.length, 1);
  assert.equal((await s.post('/api/kb/upload', { name: '副本.txt', content: KB_TEXT })).code, 'KB_DUPLICATE');
  assert.equal((await s.post('/api/kb/upload', { name: '手册.txt', content: '另一份内容，与原文件不同。' })).code, 'KB_SAME_NAME');
  assert.equal((await s.post('/api/kb/upload', { name: 'a.pdf', content: 'x' })).code, 'KB_BAD_TYPE');

  r = await s.sse('生成视频要多久？');
  assert.equal(r.meta.hit, true);
  assert.equal(r.meta.engine, 'extract', '演示环境不调用大模型');
  assert.match(r.text, /2 到 5 分钟/);
  assert.ok(r.done);

  r = await s.sse('如何申请发票？');
  assert.equal(r.meta.hit, false);
  assert.match(r.text, /没有找到/);

  const id = up.data.doc.id;
  assert.equal((await s.del('/api/kb?id=' + id)).data.docs.length, 0);
  assert.equal((await s.del('/api/kb?id=' + id)).code, 'NOT_FOUND');
});

test('知识库：按工作区隔离，缺少工作区标识被拒绝', async () => {
  await s.post('/api/kb/upload', { name: '隔离.txt', content: KB_TEXT });
  const other = await s.client('', 'another-visitor-01').get('/api/kb');
  assert.equal(other.data.docs.length, 0);
  const none = await fetch(s.base + '/api/kb').then((r) => r.json());
  assert.equal(none.code, 'BAD_WORKSPACE');
});

test('请求体过大返回 413 与可读提示', async () => {
  const r = await fetch(s.base + '/api/kb/upload', { method: 'POST', headers: s.client().headers(), body: JSON.stringify({ name: 'big.txt', content: 'a'.repeat(2 * 1024 * 1024) }) });
  assert.equal(r.status, 413);
  assert.equal((await r.json()).code, 'PAYLOAD_TOO_LARGE');
});

test('静态资源：带哈希资源长缓存、首页不缓存、SPA 回退、路径穿越被拦截', { skip: !fs.existsSync(new URL('../dist/index.html', import.meta.url)) && '未构建 dist/，跳过（先运行 npm run build）' }, async () => {
  const home = await fetch(s.base + '/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  const html = await home.text();
  const asset = html.match(/\.\/(assets\/[^"]+\.js)/)?.[1];
  assert.ok(asset, '构建产物应使用相对路径（支持子路径部署）');
  const a = await fetch(`${s.base}/${asset}`);
  assert.match(a.headers.get('cache-control'), /immutable/);
  assert.equal((await fetch(s.base + '/some/deep/link')).status, 200);
  assert.equal((await fetch(s.base + '/assets/missing.js')).status, 404);
  assert.notEqual((await fetch(s.base + '/files/..%2f..%2fpackage.json')).status, 200);
});
