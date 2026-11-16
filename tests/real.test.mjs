// real.test.mjs —— 真实模式的代码层验证：用假的平台（mock fetch）替代如影与 DeepSeek，
// 不使用任何真实密钥、不发出任何外网请求、不产生费用。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, pollUntilDone, KB_TEXT, SUPER, superClient, setupTenant, fund } from './helpers.mjs';
import { normalizeDuration } from '../server/lib/ruying.mjs';

const calls = [];
let invalidateNext = false;
let failTts = false;
let resourceResponse = { resourceConfig: {
  genVideoDurationTotalQty: 20, genVideoDurationUsageQty: 0.54,
  genImageVideoDurationTotalQty: 120, genImageVideoDurationUsageQty: 0,
  liveDurationTotalQty: 100, liveDurationUsageQty: 0,
  genTakeoverVideoDurationTotalQty: 100, genTakeoverVideoDurationUsageQty: 0,
  genCharModelTotalQty: 3, genCharModelUsageQty: 0,
  genTtsCharVoiceModelTotalQty: 3, genTtsCharVoiceModelUsageQty: 0,
  genVcModelTotalQty: 5, genVcModelUsageQty: 0,
  genEditImageTotalQty: 10, genEditImageUsageQty: 0,
  videoInteractiveLiveTotalQty: 1, videoInteractiveLiveUsageQty: 0,
} };
// 任务 id -> task/info 返回的记录（按平台口径：productParam 为 JSON 串）
const TASK_RESULTS = {
  7788: { id: 7788, status: 5, productParam: JSON.stringify({ videoPath: 'https://cdn.invalid/v.mp4', duration: 6 }) },
  66001: { id: 66001, status: 5, productParam: JSON.stringify({ videoPath: 'https://cdn.invalid/v2.mp4', duration: 8 }) },
  11890: { id: 11890, status: 5, productParam: JSON.stringify({ qid: 'qid_new_1' }) },
  17548: { id: 17548, status: 5, productParam: JSON.stringify({ faceFeatureId: 'ff_new_1' }) },
  7003001: { id: 7003001, status: 5, productParam: JSON.stringify({ modelId: 'ff_demo' }) },
  9101: { id: 9101, status: 5, productParam: JSON.stringify({ imagePath: 'https://cdn.invalid/e.jpg' }) },
  9201: { id: 9201, status: 5, productParam: JSON.stringify({ imagePath: 'https://cdn.invalid/green.jpg' }) },
};
const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) });

async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const body = init.body ? JSON.parse(init.body) : null;
  const auth = init.headers?.Authorization || '';
  calls.push({ path: u.pathname, body, auth, host: u.host });
  if (u.host === 'deepseek.invalid') {
    if (body && body.stream === false) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '改写后的口语文本：欢迎来到直播间，今天有三款好物。' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const sse = ['资料里说', '需要 2 到 5 分钟。'].map((c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (u.host === 'cdn.invalid' && u.pathname.endsWith('.md')) {
    return new Response('# 使用说明\n\n图片数字人视频最短 5 秒。\n', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  if (u.pathname === '/api/2dvh/v1/user/config/resource') return ok(resourceResponse);
  if (u.pathname === '/api/uc/v1/access/api/token') return ok({ accessToken: `tok-${calls.length}`, expireTime: Date.now() + 8 * 3600000, user: { id: 617 } });
  if (invalidateNext) { invalidateNext = false; return { ok: false, status: 401, text: async () => JSON.stringify({ code: 401, message: 'token invalid' }) }; }
  switch (u.pathname) {
    case '/api/voice/v3/tts/request':
      if (failTts) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 400123, message: '文本含不支持字符' }) };
      return ok({ taskId: 'tts-1' });
    case '/api/voice/v3/tts/result': return ok({ status: 5, audioUrl: 'https://cdn.invalid/a.mp3', duration: 6.2 });
    case '/api/2dvh/v3/material/tts/list': return ok({ result: [
      { id: 1, materialName: '女声-甜美-晓悦', extendParam: JSON.stringify({ qid: 'qid-a', voiceName: '晓悦', gender: 2 }) },
      { id: 2, materialName: '女声-甜美-晓悦', extendParam: JSON.stringify({ qid: 'qid-a', voiceName: '晓悦', gender: 2 }) },
      { id: 3, materialName: '男声-沉稳-云泽', extendParam: JSON.stringify({ qid: 'qid-b', voiceName: '云泽', gender: 1 }) },
    ] });
    case '/api/2dvh/v1/material/single/image/video/create': return ok({ id: 7788 });
    case '/api/2dvh/v1/material/video/create': return ok(66001);
    case '/api/2dvh/v1/material/voice/clone/qid/create': return ok(11890);
    case '/api/2dvh/v1/material/2davatar/model/multi/create': return ok({ taskId: 17548, result: [] });
    case '/api/2dvh/v1/material/2davatar/model/rebuilding/video': return ok(7003001);
    case '/api/2dvh/v1/material/single/image/edit': return ok(9101);
    case '/api/2dvh/v1/material/2davatar/model/green/segment/image/create': return ok(9201);
    case '/api/2dvh/v1/material/2davatar/model/green/segment/video/create': return ok(9202);
    case '/api/2dvh/v2/material/live/channel/create': return ok({ sessionId: 'sess_test_1', sessionToken: 'tok', status: 35, pullRtmpUrl: 'rtmp://cdn.invalid/live', pullFlvUrl: 'https://cdn.invalid/live.flv', pullHlsUrl: 'https://cdn.invalid/live.m3u8' });
    case '/api/2dvh/v1/multi-video-live/decoration-tasks': return ok(55001);
    case '/api/2dvh/v1/task/info': {
      const id = body?.ids?.[0];
      const rec = TASK_RESULTS[id] || { id, status: 5, productParam: JSON.stringify({}) };
      return ok([rec]);
    }
    default: return { ok: false, status: 404, text: async () => '' };
  }
}

const ALL = ['video-tts', 'video-image', 'video-script', 'voice-tts', 'voice-clone', 'voice-nlp', 'avatar-train', 'avatar-green', 'avatar-update', 'image-edit', 'nlp-kb', 'nlp-chat', 'live-script', 'live-pro', 'live-multi'];
let srv, s, sup;
before(async () => {
  srv = await startServer({
    fetchImpl: fakeFetch,
    env: { ...SUPER,
      RUYING_MOCK: 'false', RUYING_APP_ID: 'test-app', RUYING_APP_KEY: 'fake-key', RUYING_BASE_URL: 'https://ruying.invalid',
      RUYING_TTS_QID: 'qid-test', RUYING_AVATAR_IMAGE_URL: 'https://cdn.invalid/p.png', ALLOW_BILLABLE: 'true',
      DEEPSEEK_API_KEY: 'fake-ds', DEEPSEEK_BASE_URL: 'https://deepseek.invalid',
      RUYING_LIVE_FACE_FEATURE_ID: 'ff_test_1', RUYING_LIVE_FILE_ID: 'file_test_1',
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

test('TTS：选中的发音人 + 三滑块发给平台，越界值夹取到接口范围', async () => {
  calls.length = 0;
  const r = await s.post('/api/tts', { text: '欢迎体验如影数字人', qid: 'qid-custom', speedRatio: 3, volume: 500, pitchOffset: -99 }, 'real');
  assert.equal(r.code, 0, r.message);
  const req = calls.find((c) => c.path === '/api/voice/v3/tts/request');
  assert.equal(req.body.qid, 'qid-custom');
  assert.equal(req.body.speed_ratio, 2, '语速超过 2 应夹取到 2');
  assert.equal(req.body.volume, 400, '音量超过 400 应夹取到 400');
  assert.equal(req.body.pitch_offset, -60, '语调低于 -60 应夹取到 -60');
});

test('TTS：不传参数时不发三滑块，不动老调用的默认音色', async () => {
  calls.length = 0;
  await s.post('/api/tts', { text: '欢迎体验如影数字人' }, 'real');
  const req = calls.find((c) => c.path === '/api/voice/v3/tts/request');
  assert.equal(req.body.qid, 'qid-test');
  assert.ok(!('speed_ratio' in req.body) && !('volume' in req.body) && !('pitch_offset' in req.body), '未传参数时不应带三滑块');
});

test('发音人列表：GET /api/voice/list 返回规整去重后的列表', async () => {
  const r = await s.get('/api/voice/list', 'real');
  assert.equal(r.code, 0, r.message);
  assert.equal(r.data.voices.length, 2, '同一 qid 出现两次应去重为一条');
  assert.deepEqual(r.data.voices.map((v) => v.qid), ['qid-a', 'qid-b']);
  assert.equal(r.data.voices[0].materialName, '女声-甜美-晓悦');
  assert.equal(r.data.voices[1].voiceName, '云泽');
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

/* ---------- 2.6.0 真实链路：全部 15 项能力 ---------- */

test('文本驱动视频合成：真实模式走 TTS + 默认形象图，返回视频任务（不再原样 POST {text}）', async () => {
  calls.length = 0;
  const r = await s.post('/api/capability/run', { id: 'video-tts', params: { text: '新款智能手表今天上市，支持全天心率监测。' } }, 'real');
  assert.equal(r.code, 0, r.message);
  assert.equal(r.data.sync, false);
  assert.ok(r.data.taskId, '应返回异步任务编号');
  assert.ok(calls.some((c) => c.path === '/api/voice/v3/tts/request'), '应先调 TTS');
  const create = calls.find((c) => c.path === '/api/2dvh/v1/material/single/image/video/create');
  assert.ok(create, '应调图片数字人创建');
  assert.ok(create.body.videoName);
  assert.equal(JSON.parse(create.body.param).imageUrl, 'https://cdn.invalid/p.png', '用厂商默认形象图');
  assert.ok(!calls.some((c) => c.path === '/api/2dvh/v1/material/video/create'), '没有训练形象时不应走 video/create');
  const t = await pollUntilDone(s, '/api/capability/task', r.data.taskId, 'real');
  assert.equal(t.data.status, 5);
  assert.equal(t.data.result.output, 'video', '轮询结果须带 output，体验页才能渲染视频');
  assert.equal(t.data.result.videoUrl, 'https://cdn.invalid/v.mp4');
});

test('音色复刻：请求体按文档构造，轮询后返回 QID', async () => {
  calls.length = 0;
  const r = await s.post('/api/capability/run', { id: 'voice-clone', params: {
    audioUrl: 'https://cdn.invalid/v.mp3', audioLanguage: 'zh-CN', speakerName: '小王', companyName: '某某公司',
    voiceName: '品牌播报音', gender: '2', taskType: 'TTS8', trainMode: 'common', musicSep: '否',
  } }, 'real');
  assert.equal(r.code, 0, r.message);
  const req = calls.find((c) => c.path === '/api/2dvh/v1/material/voice/clone/qid/create');
  assert.ok(req, '应调音色复刻接口');
  assert.deepEqual(req.body.consent, { audioUrl: 'https://cdn.invalid/v.mp3', speakerName: '小王', companyName: '某某公司' });
  assert.deepEqual(req.body.voice, { name: '品牌播报音', gender: 2 });
  assert.equal(req.body.taskType, 'TTS8');
  assert.ok(!('model' in req.body), '不能原样转发表单的 model 字段');
  const t = await pollUntilDone(s, '/api/capability/task', r.data.taskId, 'real');
  assert.equal(t.data.status, 5);
  assert.equal(t.data.result.output, 'json');
  assert.equal(t.data.result.json.qid, 'qid_new_1');
});

test('拟人大模型：平台无接口，真实模式走 DeepSeek 按场景改写', async () => {
  calls.length = 0;
  const r = await s.post('/api/capability/run', { id: 'voice-nlp', params: { text: '本产品支持全天心率监测。', scene: '直播话术' } }, 'real');
  assert.equal(r.code, 0, r.message);
  assert.equal(r.data.sync, true);
  assert.equal(r.data.result.output, 'text');
  assert.match(r.data.result.text, /欢迎来到直播间/);
  const ds = calls.find((c) => c.host === 'deepseek.invalid');
  assert.ok(ds, '应调 DeepSeek');
  assert.equal(ds.body.stream, false, '改写用非流式调用');
  assert.match(ds.body.messages[0].content, /直播话术/);
  assert.ok(!calls.some((c) => c.path.includes('nlp')), '不应调不存在的平台 NLP 接口');
});

test('形象复刻：请求体按文档构造，轮询后返回 face_feature_id', async () => {
  calls.length = 0;
  const r = await s.post('/api/capability/run', { id: 'avatar-train', params: {
    videoUrl: 'https://cdn.invalid/src.mp4', avatarName: '张老师', avatarType: '0', segmentStyle: '1', videoCrfQuality: '23',
  } }, 'real');
  assert.equal(r.code, 0, r.message);
  const req = calls.find((c) => c.path === '/api/2dvh/v1/material/2davatar/model/multi/create');
  assert.ok(req);
  assert.equal(req.body.materialName, '张老师');
  const p = JSON.parse(req.body.param);
  assert.equal(p.personal.segmentStyle, 1);
  assert.equal(p.persistent.avatarType, 0, '表单的 0=普通数字人，不应再传旧的 2');
  assert.equal(p.persistent.dev.stage2.config, 0);
  const t = await pollUntilDone(s, '/api/capability/task', r.data.taskId, 'real');
  assert.equal(t.data.result.json.faceFeatureId, 'ff_new_1');
});

test('绿幕预览：图片走 image 接口，param 用 snake_case，轮询后返回图片', async () => {
  calls.length = 0;
  const r = await s.post('/api/capability/run', { id: 'avatar-green', params: { sourceUrl: 'https://cdn.invalid/g.png', materialName: '绿幕预览', threshold: '160', blur: '3' } }, 'real');
  assert.equal(r.code, 0, r.message);
  const req = calls.find((c) => c.path === '/api/2dvh/v1/material/2davatar/model/green/segment/image/create');
  assert.ok(req, '图片应走图片预览接口');
  const p = JSON.parse(req.body.param);
  assert.equal(p.green_params_refineth_h_bgr, 160);
  assert.equal(p.green_params_blur_ks, 3);
  const t = await pollUntilDone(s, '/api/capability/task', r.data.taskId, 'real');
  assert.equal(t.data.result.output, 'image');
  assert.equal(t.data.result.imageUrl, 'https://cdn.invalid/green.jpg');
});

test('模型更新：扁平字段提交，轮询后返回任务结果', async () => {
  calls.length = 0;
  const r = await s.post('/api/capability/run', { id: 'avatar-update', params: {
    materialName: '张老师', videoUrl: 'https://cdn.invalid/new.mp4', modelUrl: 'https://cdn.invalid/model.zip',
    avatarType: '0', segmentStyle: '1', dynamicRangeStart: '1', dynamicRangeEnd: '210',
  } }, 'real');
  assert.equal(r.code, 0, r.message);
  const req = calls.find((c) => c.path === '/api/2dvh/v1/material/2davatar/model/rebuilding/video');
  assert.ok(req);
  assert.equal(req.body.materialName, '张老师');
  assert.equal(req.body.modelUrl, 'https://cdn.invalid/model.zip');
  assert.equal(typeof req.body.param, 'undefined', '更新接口是扁平字段，不应包 param 字符串');
  const t = await pollUntilDone(s, '/api/capability/task', r.data.taskId, 'real');
  assert.equal(t.data.status, 5);
  assert.equal(t.data.result.output, 'json');
});

test('图片编辑：请求体按文档构造（imageName + param 串），轮询后返回图片', async () => {
  calls.length = 0;
  const r = await s.post('/api/capability/run', { id: 'image-edit', params: {
    imageName: '校园海报', images: 'https://cdn.invalid/a.jpg\nhttps://cdn.invalid/b.jpg', prompt: '并排放在一起', watermark: '开启',
  } }, 'real');
  assert.equal(r.code, 0, r.message);
  const req = calls.find((c) => c.path === '/api/2dvh/v1/material/single/image/edit');
  assert.ok(req);
  assert.equal(req.body.imageName, '校园海报');
  const p = JSON.parse(req.body.param);
  assert.deepEqual(p.images, ['https://cdn.invalid/a.jpg', 'https://cdn.invalid/b.jpg']);
  assert.deepEqual(p.watermark, { show: true, content: 'AI生成' });
  const t = await pollUntilDone(s, '/api/capability/task', r.data.taskId, 'real');
  assert.equal(t.data.result.output, 'image');
  assert.equal(t.data.result.imageUrl, 'https://cdn.invalid/e.jpg');
});

test('视频脚本：不填形象时返回文档级有效的 param JSON；填了形象时提交到平台生成', async () => {
  const r = await s.post('/api/capability/run', { id: 'video-script', params: {
    name: '第3章', lines: '大家好，欢迎来到本章课程。', subtitle: '底部白字',
  } }, 'real');
  assert.equal(r.code, 0, r.message);
  assert.equal(r.data.sync, true);
  const param = r.data.result.json;
  assert.equal(param.version, '0.0.17');
  assert.equal(param.digital_role.face_feature_id, 'your_face_feature_id', '未填形象时给占位，不提交');
  assert.equal(param.subtitle.font_size, 20);
  assert.match(param.watermark.content, /^[A-Za-z0-9]+$/, '水印文字不可用中文');
  assert.ok(!calls.some((c) => c.path === '/api/2dvh/v1/material/video/create'), '未填形象时不应提交');
  calls.length = 0;
  const r2 = await s.post('/api/capability/run', { id: 'video-script', params: {
    name: '第3章', lines: '大家好，欢迎来到本章课程。', subtitle: '底部白字',
    videoName: '第3章-高级效果', faceFeatureId: 'ff_123', modelUrl: 'https://cdn.invalid/avatar.zip',
  } }, 'real');
  assert.equal(r2.code, 0, r2.message);
  assert.equal(r2.data.sync, false, '填了形象时应提交并返回异步任务');
  const req = calls.find((c) => c.path === '/api/2dvh/v1/material/video/create');
  assert.ok(req);
  assert.equal(req.body.videoName, '第3章-高级效果');
  assert.equal(typeof req.body.param, 'string');
  const t = await pollUntilDone(s, '/api/capability/task', r2.data.taskId, 'real');
  assert.equal(t.data.result.output, 'video');
  assert.equal(t.data.result.videoUrl, 'https://cdn.invalid/v2.mp4');
});

test('知识库管理：真实模式下载文档存进服务端知识库，问答能命中', async () => {
  calls.length = 0;
  const r = await s.post('/api/capability/run', { id: 'nlp-kb', params: {
    name: '使用说明', docUrl: 'https://cdn.invalid/docs/guide.md', desc: '体验站说明',
  } }, 'real');
  assert.equal(r.code, 0, r.message);
  assert.equal(r.data.result.json.status, '已入库');
  assert.equal(r.data.result.json.name, '使用说明.md');
  assert.ok(calls.some((c) => c.host === 'cdn.invalid' && c.path.endsWith('.md')), '应下载文档地址');
  assert.ok(!calls.some((c) => c.path.includes('kb') && c.host === 'ruying.invalid'), '平台没有知识库接口，不应调平台');
  const hit = await s.sse('图片数字人视频最短多长？', 'real');
  assert.equal(hit.meta.hit, true, '新入库的文档应能被问答命中');
  const bad = await s.post('/api/capability/run', { id: 'nlp-kb', params: { name: '手册', docUrl: 'https://cdn.invalid/docs/manual.pdf', desc: '' } }, 'real');
  assert.equal(bad.code, 'UNSUPPORTED_DOC', 'PDF 应明确拒绝而不是静默失败');
});

test('流式问答助手：体验表单走真实 RAG，返回文本答案', async () => {
  const r = await s.post('/api/capability/run', { id: 'nlp-chat', params: { text: '生成视频要多久？' } }, 'real');
  assert.equal(r.code, 0, r.message);
  assert.equal(r.data.sync, true);
  assert.equal(r.data.result.output, 'chat');
  assert.match(r.data.result.text, /2 到 5 分钟/);
});

test('互动直播与超级直播间：创建直播间返回会话编号与拉流地址', async () => {
  calls.length = 0;
  const r = await s.post('/api/capability/run', { id: 'live-script', params: { name: '双十一专场', scene: '带货', script: '欢迎来到直播间，今天有三款好物。' } }, 'real');
  assert.equal(r.code, 0, r.message);
  const req = calls.find((c) => c.path === '/api/2dvh/v2/material/live/channel/create');
  assert.ok(req, '应调 v2 创建直播间');
  const p = JSON.parse(req.body.param);
  assert.equal(p.version, '0.0.1');
  assert.equal(p.sceneList[0].digital_role.face_feature_id, 'ff_test_1');
  assert.equal(p.sceneList[0].digital_role.fileId, 'file_test_1');
  assert.equal(r.data.result.json.sessionId, 'sess_test_1');
  assert.equal(r.data.result.json.pullHlsUrl, 'https://cdn.invalid/live.m3u8');
  assert.match(r.data.result.realModeNote, /尚未开播/);
  const pro = await s.post('/api/capability/run', { id: 'live-pro', params: { name: '品牌旗舰', avatarType: '5', script: '欢迎来到直播间。' } }, 'real');
  assert.equal(pro.code, 0, pro.message);
  assert.match(pro.data.result.json.controlApi, /super\/pro\/channel\/control/);
});

test('视频互动直播：创建装修任务返回父任务 id', async () => {
  calls.length = 0;
  const r = await s.post('/api/capability/run', { id: 'live-multi', params: { name: '产品发布会', script: '您好，欢迎来到直播间。' } }, 'real');
  assert.equal(r.code, 0, r.message);
  const req = calls.find((c) => c.path === '/api/2dvh/v1/multi-video-live/decoration-tasks');
  assert.ok(req);
  assert.equal(req.body.name, '产品发布会');
  assert.equal(JSON.parse(req.body.param)[0].tts_query.content, '您好，欢迎来到直播间。');
  assert.equal(r.data.result.json.decorationTaskId, '55001');
});

test('厂商额度预检：图片数字人额度超支时报明确的错，不再让平台回“系统内部错误”', async () => {
  resourceResponse = { resourceConfig: {
    genVideoDurationTotalQty: 20, genVideoDurationUsageQty: 0.54,
    genImageVideoDurationTotalQty: 120, genImageVideoDurationUsageQty: 149.4,
    genEditImageTotalQty: 0, genEditImageUsageQty: 0,
    genCharModelTotalQty: 3, genCharModelUsageQty: 0,
    genVcModelTotalQty: 5, genVcModelUsageQty: 0,
    liveDurationTotalQty: 100, liveDurationUsageQty: 0,
  } };
  try {
    const r = await s.post('/api/capability/run', { id: 'video-tts', params: { text: '新款智能手表今天上市，支持全天心率监测。' } }, 'real');
    assert.equal(r.code, 'VENDOR_QUOTA_EXHAUSTED');
    assert.match(r.message, /图片数字人额度不足/);
    assert.match(r.message, /剩余 -29.4/);
    assert.ok(r.hint);
    const e = await s.post('/api/capability/run', { id: 'image-edit', params: { imageName: '海报', images: 'https://cdn.invalid/a.jpg', prompt: '改一下', watermark: '开启' } }, 'real');
    assert.equal(e.code, 'VENDOR_NOT_OPENED');
    assert.match(e.message, /尚未开通/);
  } finally {
    resourceResponse = { resourceConfig: {
      genVideoDurationTotalQty: 20, genVideoDurationUsageQty: 0.54,
      genImageVideoDurationTotalQty: 120, genImageVideoDurationUsageQty: 0,
      liveDurationTotalQty: 100, liveDurationUsageQty: 0,
      genTakeoverVideoDurationTotalQty: 100, genTakeoverVideoDurationUsageQty: 0,
      genCharModelTotalQty: 3, genCharModelUsageQty: 0,
      genTtsCharVoiceModelTotalQty: 3, genTtsCharVoiceModelUsageQty: 0,
      genVcModelTotalQty: 5, genVcModelUsageQty: 0,
      genEditImageTotalQty: 10, genEditImageUsageQty: 0,
      videoInteractiveLiveTotalQty: 1, videoInteractiveLiveUsageQty: 0,
    } };
  }
});

test('直播未配置形象时报前置条件（不依赖平台）', async () => {
  const bare = await startServer({ fetchImpl: fakeFetch, env: { ...SUPER, RUYING_MOCK: 'false', RUYING_APP_ID: 'test-app', RUYING_APP_KEY: 'fake-key', RUYING_BASE_URL: 'https://ruying.invalid',
    RUYING_TTS_QID: 'qid-test', RUYING_AVATAR_IMAGE_URL: 'https://cdn.invalid/p.png', ALLOW_BILLABLE: 'true',
    DEEPSEEK_API_KEY: 'fake-ds', DEEPSEEK_BASE_URL: 'https://deepseek.invalid' } });
  try {
    const bs = await superClient(bare);
    const bt = await setupTenant(bare, bs, { modules: ALL, allowReal: true, allowBillable: true, vendorId: 'env' });
    await fund(bs, bt.tenant.id);
    const b = bt.admin;
    const r = await b.post('/api/capability/run', { id: 'live-script', params: { name: '专场', scene: '带货', script: '欢迎来到直播间。' } }, 'real');
    assert.equal(r.code, 'PREREQUISITE');
    assert.match(r.message, /已训练并预热/);
    assert.ok(r.hint);
  } finally { await bare.close(); }
});

/* ---------- 2.8.0 操作流程：自动获取 ---------- */

test('图片数字人：图片地址留空时用服务端默认形象图', async () => {
  calls.length = 0;
  const r = await s.post('/api/capability/run', { id: 'video-image', params: { imageUrl: '', audioUrl: 'https://cdn.invalid/a.mp3', duration: 6 } }, 'real');
  assert.equal(r.code, 0, r.message);
  const create = calls.find((x) => x.path === '/api/2dvh/v1/material/single/image/video/create');
  assert.ok(create, '应提交到平台');
  assert.deepEqual(JSON.parse(create.body.param), { imageUrl: 'https://cdn.invalid/p.png', audioUrl: 'https://cdn.invalid/a.mp3', duration: 6 });
});

test('图片数字人：没配默认形象图且图片留空时报明确的错', async () => {
  const noImg = await startServer({ fetchImpl: fakeFetch, env: { ...SUPER, RUYING_MOCK: 'false', RUYING_APP_ID: 'test-app', RUYING_APP_KEY: 'fake-key', RUYING_BASE_URL: 'https://ruying.invalid', RUYING_TTS_QID: 'qid-test', ALLOW_BILLABLE: 'true' } });
  try {
    const ns = await superClient(noImg);
    const nt = await setupTenant(noImg, ns, { modules: ALL, allowReal: true, allowBillable: true, vendorId: 'env' });
    await fund(ns, nt.tenant.id);
    const r = await nt.admin.post('/api/capability/run', { id: 'video-image', params: { imageUrl: '', audioUrl: 'https://cdn.invalid/a.mp3', duration: 6 } }, 'real');
    assert.equal(r.code, 'AVATAR_NOT_CONFIGURED');
    assert.equal(r.action, 'config');
    assert.ok(r.hint);
  } finally { await noImg.close(); }
});

test('视频脚本：服务端已配置形象时，表单留空也能提交（不再因请求体缺值抛错）', async () => {
  const withAvatar = await startServer({ fetchImpl: fakeFetch, env: { ...SUPER,
    RUYING_MOCK: 'false', RUYING_APP_ID: 'test-app', RUYING_APP_KEY: 'fake-key', RUYING_BASE_URL: 'https://ruying.invalid',
    RUYING_TTS_QID: 'qid-test', RUYING_AVATAR_IMAGE_URL: 'https://cdn.invalid/p.png', ALLOW_BILLABLE: 'true',
    RUYING_FACE_FEATURE_ID: 'ff_env_1', RUYING_AVATAR_MODEL_URL: 'https://cdn.invalid/avatar.zip',
    DEEPSEEK_API_KEY: 'fake-ds', DEEPSEEK_BASE_URL: 'https://deepseek.invalid',
  } });
  try {
    const ws = await superClient(withAvatar);
    const wt = await setupTenant(withAvatar, ws, { modules: ALL, allowReal: true, allowBillable: true, vendorId: 'env' });
    await fund(ws, wt.tenant.id);
    calls.length = 0;
    const r = await wt.admin.post('/api/capability/run', { id: 'video-script', params: {
      name: '第3章', lines: '大家好，欢迎来到本章课程。', subtitle: '底部白字', videoName: '第3章-高级效果',
    } }, 'real');
    assert.equal(r.code, 0, r.message);
    assert.equal(r.data.sync, false, '服务端已配置形象时应提交并返回异步任务');
    const req = calls.find((c) => c.path === '/api/2dvh/v1/material/video/create');
    assert.ok(req, '应提交到平台');
    const param = JSON.parse(req.body.param);
    assert.equal(param.digital_role.face_feature_id, 'ff_env_1', '应把服务端配置的形象带进请求体');
    assert.equal(param.digital_role.url, 'https://cdn.invalid/avatar.zip');
    // /api/config 应如实反映这三项的配置状态
    const cfg = await wt.admin.get('/api/config', 'real');
    assert.equal(cfg.data.faceFeatureConfigured, true);
    assert.equal(cfg.data.avatarModelConfigured, true);
    assert.equal(cfg.data.liveAvatarConfigured, false);
  } finally { await withAvatar.close(); }
});

test('配置状态：/api/config 返回前置资源的配置情况与默认形象图地址', async () => {
  const c = await s.get('/api/config', 'real');
  assert.equal(c.data.ttsConfigured, true);
  assert.equal(c.data.avatarImageConfigured, true);
  assert.equal(c.data.avatarImageUrl, 'https://cdn.invalid/p.png');
  assert.equal(c.data.faceFeatureConfigured, false, '主测试服务器未配 RUYING_FACE_FEATURE_ID');
  assert.equal(c.data.avatarModelConfigured, false);
  assert.equal(c.data.liveAvatarConfigured, true, '主测试服务器配了直播形象与预热素材');
  assert.ok(!JSON.stringify(c.data).includes('fake-key'), '配置接口不得泄露 APP_KEY');
});

test('任务中心：创建即入库，列表按状态刷新并支持筛选与搜索', async () => {
  calls.length = 0;
  const r = await s.post('/api/capability/run', { id: 'image-edit', params: {
    imageName: '校园海报', images: 'https://cdn.invalid/a.jpg', prompt: '并排放在一起', watermark: '开启',
  } }, 'real');
  assert.equal(r.code, 0, r.message);
  assert.equal(String(r.data.taskId), '9101');
  const list = await s.get('/api/tasks', 'real');
  assert.equal(list.code, 0, list.message);
  const row = (list.data.tasks || []).find((t) => String(t.id) === '9101');
  assert.ok(row, '创建的任务应在列表里');
  assert.equal(row.capability, 'image-edit');
  assert.equal(row.name, '校园海报', '任务名取自表单里的任务名');
  assert.equal(row.status, 5, '列表应把未完成任务向平台批量刷新为已完成');
  assert.equal(row.result?.output, 'image');
  assert.equal(row.result?.imageUrl, 'https://cdn.invalid/e.jpg');
  const failed = await s.get('/api/tasks?status=9', 'real');
  assert.equal((failed.data.tasks || []).length, 0, '失败筛选下不应有任务');
  const found = await s.get('/api/tasks?q=%E6%A0%A1%E5%9B%AD%E6%B5%B7%E6%8A%A5', 'real');
  assert.ok((found.data.tasks || []).some((t) => String(t.id) === '9101'), '按任务名搜索应找到');
  const other = await s.get('/api/tasks?capability=voice-tts', 'real');
  assert.ok(!(other.data.tasks || []).some((t) => String(t.id) === '9101'), '按能力筛选不应串能力');
});

test('任务中心：历史导入把浏览器存过的编号写进表，重复导入不重复', async () => {
  const imp = await s.post('/api/tasks/import', { ids: ['99001'] }, 'real');
  assert.equal(imp.code, 0, imp.message);
  assert.equal(imp.data.imported, 1, '新编号应导入 1 条');
  const list = await s.get('/api/tasks?q=99001', 'real');
  const row = (list.data.tasks || []).find((t) => String(t.id) === '99001');
  assert.ok(row, '导入的任务应在列表里');
  assert.equal(row.capabilityName, '历史任务', '导入的任务能力未知时标历史任务');
  assert.equal(row.status, 5);
  const again = await s.post('/api/tasks/import', { ids: ['99001'] }, 'real');
  assert.equal(again.data.imported, 0, '已登记的编号不再重复导入');
});

test('任务中心：演示环境列出演示任务', async () => {
  const r = await s.post('/api/capability/run', { id: 'image-edit', params: {
    imageName: '演示海报', images: 'https://cdn.invalid/a.jpg', prompt: '并排放在一起', watermark: '开启',
  } }, 'mock');
  assert.equal(r.code, 0, r.message);
  assert.ok(r.data.taskId, '演示环境应返回任务编号');
  const list = await s.get('/api/tasks', 'mock');
  assert.equal(list.code, 0, list.message);
  const row = (list.data.tasks || []).find((t) => String(t.id) === String(r.data.taskId));
  assert.ok(row, '演示任务应在演示列表里');
  assert.equal(row.capabilityName, 'AI 图片编辑');
});
