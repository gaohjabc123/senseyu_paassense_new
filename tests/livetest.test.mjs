// livetest.test.mjs —— v2.16.0 直播内测 / 视频互动直播测试 / 账单 / 脚本库集成测试
// 演示模式：进程内服务器 + 匿名客户端，不发外网请求、不扣额度；
// 真实模式：用假的平台（mock fetch）替代如影，不使用真实密钥、不产生费用。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, SUPER, superClient, setupTenant, fund } from './helpers.mjs';
import { liveTestView, multiTestView, billView, billUsageHtml, quotaLevel, liveScriptsView } from '../src/lib/views.js';

// 最小可用的直播脚本 JSON（控制台「导出直播脚本」的形状）
const LIVE_SCRIPT = JSON.stringify({
  version: '0.0.1', recycle: 0, stream_mode: true,
  sceneList: [{
    digital_role: { id: 167343, face_feature_id: 'ff_live_1', name: '芸馨_直播_站姿', url: 'https://cdn.invalid/model.zip', scale: 1 },
    tts_config: { name: '中文（中国）-女-直播-芸馨', qid: 'qid-live', language: '', pitch_offset: 0, speed_ratio: 1, volume: 100 },
    tts_query: { content: '欢迎来到直播间。', ssml: false },
    audios: [],
  }],
});

/* ================= 演示模式 ================= */
let mock;
before(async () => { mock = await startServer(); });
after(async () => { await mock.close(); });

test('演示模式：直播内测创建→开播→心跳→接管→替换→关播全流程走样例', async () => {
  const c = await mock.post('/api/live/test/create', { name: '直播内测', scriptJson: LIVE_SCRIPT }, 'mock');
  assert.equal(c.code, 0, c.message);
  assert.equal(c.data.mode, 'mock');
  assert.ok(c.data.sessionId.startsWith('sess_demo_'), '演示会话编号为样例');
  assert.ok(c.data.pullRtmpUrl, '演示拉流地址应给出');
  const sid = c.data.sessionId;
  const start = await mock.post('/api/live/test/start', { sessionId: sid }, 'mock');
  assert.equal(start.code, 0, start.message);
  assert.equal(start.data.ok, true);
  assert.ok(Number(start.data.startedAt) > 0, '开播返回开始时间戳');
  const hb = await mock.post('/api/live/test/heartbeat', { sessionId: sid }, 'mock');
  assert.equal(hb.data.ok, true);
  const cmd = await mock.post('/api/live/test/command', { sessionId: sid, content: '欢迎来到直播间，今天有三款好物。' }, 'mock');
  assert.equal(cmd.data.ok, true);
  const rep = await mock.post('/api/live/test/replace', { sessionId: sid, fgFileId: 'fg_1' }, 'mock');
  assert.equal(rep.data.ok, true);
  const close = await mock.post('/api/live/test/close', { sessionId: sid }, 'mock');
  assert.equal(close.data.ok, true);
  // 校验：不是直播脚本的 JSON 应被拒绝
  const bad = await mock.post('/api/live/test/create', { name: '坏脚本', scriptJson: '{"version":"0.0.1"}' }, 'mock');
  assert.notEqual(bad.code, 0, '缺少 sceneList 的 JSON 不应通过');
});

test('演示模式：麦克风接管 WS 地址不可用（没有真实直播间）', async () => {
  const r = await mock.get('/api/live/takeover-ws?sessionId=sess_demo_x', 'mock');
  assert.equal(r.code, 0, r.message);
  assert.equal(r.data.available, false);
  assert.match(r.data.reason, /真实环境/);
});

test('演示模式：视频互动直播测试创建→开播→接管队列→播放顺序→关播全流程走样例', async () => {
  const c = await mock.post('/api/live/multi/create', { name: '产品发布会', materialIds: 'mat_1, mat_2' }, 'mock');
  assert.equal(c.code, 0, c.message);
  assert.equal(c.data.mode, 'mock');
  assert.ok(c.data.sessionId.startsWith('msess_demo_'));
  const sid = c.data.sessionId;
  assert.equal((await mock.post('/api/live/multi/start', { sessionId: sid }, 'mock')).data.ok, true);
  assert.equal((await mock.post('/api/live/multi/heartbeat', { sessionId: sid }, 'mock')).data.ok, true);
  const q = await mock.post('/api/live/multi/queue', { sessionId: sid, type: 0, content: '现在介绍第二款。' }, 'mock');
  assert.equal(q.data.ok, true);
  assert.ok(q.data.commandTraceId, '入队返回 commandTraceId（幂等标识）');
  const ql = await mock.get(`/api/live/multi/queue?sessionId=${sid}`, 'mock');
  assert.equal(ql.data.queue.length, 2, '演示队列为样例');
  assert.equal(ql.data.queue[0].content, '欢迎来到直播间，今天为大家带来三款好物。');
  const pb = await mock.get(`/api/live/multi/playback?sessionId=${sid}`, 'mock');
  assert.equal(pb.data.materials.length, 2, '演示播放列表为样例');
  assert.equal(pb.data.materials[0].materialId, 'mat_demo_1');
  const put = await fetch(`${mock.base}/api/live/multi/play-materials`, { method: 'PUT', headers: mock.headers('mock'), body: JSON.stringify({ sessionId: sid, materialIds: ['mat_demo_2', 'mat_demo_1'] }) }).then((x) => x.json());
  assert.equal(put.code, 0, put.message);
  const sw = await mock.post('/api/live/multi/play-materials/switch', { sessionId: sid, materialId: 'mat_demo_2' }, 'mock');
  assert.equal(sw.data.ok, true);
  const st = await mock.get(`/api/live/multi/status?sessionId=${sid}`, 'mock');
  assert.equal(st.data.mode, 'mock');
  const close = await mock.post('/api/live/multi/close', { sessionId: sid }, 'mock');
  assert.equal(close.data.ok, true);
});

test('演示模式：账单 9 页签——视频合成/声音合成走样例行，图片编辑不调接口直接说明', async () => {
  const video = await mock.get('/api/bill?tab=video&from=2026-11-01&to=2026-11-17', 'mock');
  assert.equal(video.code, 0, video.message);
  assert.equal(video.data.tab, 'video');
  assert.equal(video.data.algoType, 14);
  assert.equal(video.data.algoGroup, 1, 'algoGroup 默认 1（第一轮探测 count 0 未定论）');
  assert.equal(video.data.rows.length, 1);
  assert.equal(video.data.rows[0].billingValue, 0.62, '演示视频账单行按控制台显示的 0.62min 形状');
  const tts = await mock.get('/api/bill?tab=tts&from=2026-11-09&to=2026-11-17&statRange=1', 'mock');
  assert.equal(tts.data.kind, 'voice');
  assert.equal(tts.data.algoType, 31);
  assert.equal(tts.data.rows[0].billingValue, 0.0108, '演示语音行按 2026-11-17 实测真值形状');
  assert.equal(tts.data.rows[0].algoSubType1, 'PAAS_HTTP');
  assert.equal(tts.data.rows[0].algoSubType2, 'TTS3');
  const edit = await mock.get('/api/bill?tab=image-edit&from=2026-11-01&to=2026-11-17', 'mock');
  assert.equal(edit.data.kind, 'none');
  assert.deepEqual(edit.data.rows, []);
  assert.match(edit.data.note, /没有.*独立 algoType|未开通/);
  const csv = await fetch(`${mock.base}/api/bill.csv?tab=video&from=2026-11-01&to=2026-11-17`, { headers: mock.headers('mock') });
  assert.ok(csv.headers.get('content-type').includes('text/csv'), 'CSV 真下载，不是假按钮');
  const text = await csv.text();
  assert.ok(text.includes('账单日期'), 'CSV 含表头');
  assert.ok(text.includes('0.62'), 'CSV 含演示账单行');
});

test('演示模式：脚本库 CRUD（本站存储）+ 会话列表初始为空并带说明', async () => {
  const created = await mock.post('/api/live-scripts', { name: '双十一专场', scriptJson: LIVE_SCRIPT, source: 'editor' }, 'mock');
  assert.equal(created.code, 0, created.message);
  const id = created.data.script.id;
  const list = await mock.get('/api/live-scripts', 'mock');
  assert.ok(list.data.scripts.some((x) => x.id === id && x.name === '双十一专场'));
  const one = await mock.get(`/api/live-scripts/${id}`, 'mock');
  assert.equal(JSON.parse(one.data.script.scriptJson).sceneList[0].tts_query.content, '欢迎来到直播间。');
  const renamed = await mock.patch(`/api/live-scripts/${id}`, { name: '双十一专场·改' }, 'mock');
  assert.equal(renamed.data.script.name, '双十一专场·改');
  const bad = await mock.post('/api/live-scripts', { name: '坏脚本', scriptJson: '{"version":"0.0.1"}' }, 'mock');
  assert.notEqual(bad.code, 0, '不是直播脚本的 JSON 不应存进脚本库');
  const del = await mock.del(`/api/live-scripts/${id}`, 'mock');
  assert.equal(del.code, 0, del.message);
  assert.equal((await mock.get(`/api/live-scripts/${id}`, 'mock')).code, 'NOT_FOUND');
  const sessions = await mock.get('/api/live-sessions', 'mock');
  assert.equal(sessions.code, 0, sessions.message);
  assert.deepEqual(sessions.data.sessions, [], '演示环境不产生真实会话，列表为空是正常的');
  assert.match(sessions.data.note, /只列本站创建过/);
});

/* ================= 真实模式（假平台） ================= */
const calls = [];
const resourceResponse = { resourceConfig: {
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
const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) });

async function fakeFetch(url, init = {}) {
  const u = new URL(url);
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ path: u.pathname, method, body, query: u.search });
  if (u.pathname === '/api/2dvh/v1/user/config/resource') return ok(resourceResponse);
  if (u.pathname === '/api/uc/v1/access/api/token') return ok({ accessToken: `tok-${calls.length}`, expireTime: Date.now() + 8 * 3600000, user: { id: 617 } });
  if (u.pathname === '/api/2dvh/v1/task/info') return ok([{ id: body?.ids?.[0], status: 5, productParam: JSON.stringify({}) }]);
  // 播放顺序查询 / 全量重排 / 切换（路径含会话编号）
  if (u.pathname.startsWith('/api/2dvh/v1/multi-video-live/channel/') && u.pathname.endsWith('/playback')) {
    return ok({ playMaterials: [
      { materialId: 'mat_1', name: '开场视频', type: '视频', status: '播放中' },
      { materialId: 'mat_2', name: '产品介绍', type: '视频', status: '等待播放' },
    ] });
  }
  if (u.pathname.startsWith('/api/2dvh/v1/multi-video-live/channel/') && u.pathname.endsWith('/play-materials') && method === 'PUT') return ok(true);
  if (u.pathname.startsWith('/api/2dvh/v1/multi-video-live/channel/') && u.pathname.endsWith('/play-materials/switch')) return ok(true);
  // 互动直播间状态（路径只有会话编号一段）
  if (u.pathname.startsWith('/api/2dvh/v1/live/video-interactive/channel/') && u.pathname.split('/').length === 8) {
    return ok({ sessionId: u.pathname.split('/').pop(), state: '直播中' });
  }
  switch (u.pathname) {
    case '/api/2dvh/v2/material/live/channel/create': return ok({ sessionId: 'sess_test_1', sessionToken: 'tok', status: 35, pullRtmpUrl: 'rtmp://cdn.invalid/live', pullFlvUrl: 'https://cdn.invalid/live.flv', pullHlsUrl: 'https://cdn.invalid/live.m3u8' });
    case '/api/2dvh/v1/material/live/channel/start': return ok(true);
    case '/api/2dvh/v1/material/live/channel/heartbeat': return ok(true);
    case '/api/2dvh/v1/material/live/channel/close': return ok(true);
    case '/api/2dvh/v2/material/live/channel/command': return ok({ isSuccess: true, commandTraceId: 'ct-1' });
    case '/api/2dvh/v1/material/live/super/pro/channel/control': return ok(true);
    case '/api/2dvh/v1/multi-video-live/channel/create': return ok({ sessionId: 'msess_test_1', status: 35, pullRtmpUrl: 'rtmp://cdn.invalid/multi', pullFlvUrl: 'https://cdn.invalid/multi.flv', pullHlsUrl: 'https://cdn.invalid/multi.m3u8' });
    case '/api/2dvh/v1/multi-video-live/channel/start': return ok(true);
    case '/api/2dvh/v1/live/video-interactive/channel/heartbeat': return ok(true);
    case '/api/2dvh/v1/live/video-interactive/channel/close': return ok(true);
    case '/api/2dvh/v1/live/video-interactive/channel/command/queue': return ok({ isSuccess: true, commandTraceId: body?.commandTraceId || 'ct-2' });
    case '/api/2dvh/v1/live/video-interactive/channel/command/queue/list': return ok({ queue: [{ type: 0, content: '现在介绍第二款。', status: '排队中', commandTraceId: 'ct-2' }] });
    case '/api/assist/bill/list': return ok({ pagination: { count: 0, pageNo: 1, pageSize: 50 }, result: [], usedSum: '0' });
    case '/api/assist/bill/voice/list': return ok({ pagination: { count: 1, pageNo: 1, pageSize: 50 }, result: [{ id: 'b1', billingDate: '2026-11-12', billingValue: 0.0108, billingUnit: 3, algoSubType1: 'PAAS_HTTP', algoSubType2: 'TTS3' }], usedSum: '0.0108' });
    default: return { ok: false, status: 404, text: async () => '' };
  }
}

const ALL = ['video-tts', 'video-image', 'video-script', 'voice-tts', 'voice-clone', 'voice-nlp', 'avatar-train', 'avatar-green', 'avatar-update', 'image-edit', 'nlp-kb', 'nlp-chat', 'live-script', 'live-pro', 'live-multi', 'live-wordbank', 'live-warming', 'live-transcode', 'live-decorate', 'live-transition', 'avatar-terminal'];
let srv, s, sup;
before(async () => {
  srv = await startServer({
    fetchImpl: fakeFetch,
    env: { ...SUPER,
      RUYING_MOCK: 'false', RUYING_APP_ID: 'test-app', RUYING_APP_KEY: 'fake-key', RUYING_BASE_URL: 'https://ruying.invalid',
      RUYING_TTS_QID: 'qid-test', RUYING_AVATAR_IMAGE_URL: 'https://cdn.invalid/p.png', ALLOW_BILLABLE: 'true',
      DEEPSEEK_API_KEY: 'fake-deepseek-key',
      RUYING_LIVE_FACE_FEATURE_ID: 'ff_test_1', RUYING_LIVE_FILE_ID: 'file_test_1',
    },
  });
  sup = await superClient(srv);
  const t = await setupTenant(srv, sup, { modules: ALL, allowReal: true, allowBillable: true, vendorId: 'env' });
  await fund(sup, t.tenant.id);
  s = t.admin;
});
after(async () => { await srv.close(); });

test('真实模式：直播内测创建走 createLiveChannel，脚本 JSON 里的文案与 qid 发给平台，会话登记进任务表', async () => {
  calls.length = 0;
  const c = await s.post('/api/live/test/create', { name: '直播内测', scriptJson: LIVE_SCRIPT }, 'real');
  assert.equal(c.code, 0, c.message);
  assert.equal(c.data.sessionId, 'sess_test_1');
  assert.equal(c.data.mode, 'real');
  assert.equal(c.data.pullHlsUrl, 'https://cdn.invalid/live.m3u8');
  const req = calls.find((x) => x.path === '/api/2dvh/v2/material/live/channel/create');
  assert.ok(req, '应调用直播创建接口');
  const param = JSON.parse(req.body.param);
  assert.equal(param.sceneList[0].tts_query.content, '欢迎来到直播间。', '上传脚本 JSON 里的文案发给平台');
  assert.equal(param.sceneList[0].tts_config.qid, 'qid-live', '脚本里的发音人优先');
  const sessions = await s.get('/api/live-sessions', 'real');
  const row = sessions.data.sessions.find((x) => x.sessionId === 'sess_test_1');
  assert.ok(row, '创建即登记进直播会话列表');
  assert.equal(row.status, 2, '创建即进行中');
  assert.equal(row.capability, 'live-script');
});

test('真实模式：直播内测开播→心跳→接管→替换→关播，关播只传 sessionId，关播后会话置已完成', async () => {
  calls.length = 0;
  assert.equal((await s.post('/api/live/test/start', { sessionId: 'sess_test_1' }, 'real')).data.ok, true);
  assert.deepEqual(calls.find((x) => x.path === '/api/2dvh/v1/material/live/channel/start').body, { sessionId: 'sess_test_1' });
  assert.equal((await s.post('/api/live/test/heartbeat', { sessionId: 'sess_test_1' }, 'real')).data.ok, true);
  assert.deepEqual(calls.find((x) => x.path === '/api/2dvh/v1/material/live/channel/heartbeat').body, { sessionId: 'sess_test_1' });
  const cmd = await s.post('/api/live/test/command', { sessionId: 'sess_test_1', content: '欢迎来到直播间，今天有三款好物。' }, 'real');
  assert.equal(cmd.data.ok, true);
  const cmdReq = calls.find((x) => x.path === '/api/2dvh/v2/material/live/channel/command');
  assert.equal(cmdReq.body.sessionId, 'sess_test_1');
  assert.equal(JSON.parse(cmdReq.body.param).tts_query.content, '欢迎来到直播间，今天有三款好物。');
  const rep = await s.post('/api/live/test/replace', { sessionId: 'sess_test_1', fgFileId: 'fg_1' }, 'real');
  assert.equal(rep.data.ok, true);
  const repReq = calls.find((x) => x.path === '/api/2dvh/v1/material/live/super/pro/channel/control');
  assert.equal(JSON.parse(repReq.body.param).foregrounds[0].file_id, 'fg_1');
  const close = await s.post('/api/live/test/close', { sessionId: 'sess_test_1' }, 'real');
  assert.equal(close.data.ok, true);
  assert.deepEqual(calls.find((x) => x.path === '/api/2dvh/v1/material/live/channel/close').body, { sessionId: 'sess_test_1' }, '直播关闭只传 sessionId');
  const sessions = await s.get('/api/live-sessions', 'real');
  const row = sessions.data.sessions.find((x) => x.sessionId === 'sess_test_1');
  assert.equal(row.status, 5, '关播后会话置已完成');
  assert.equal(row.endReason, '手动关闭');
  assert.ok(Number(row.durationSec) >= 0, '关播写直播时长');
});

test('真实模式：麦克风接管 WS 地址由服务端拼 Token，返回 wss 地址含会话编号', async () => {
  const r = await s.get('/api/live/takeover-ws?sessionId=sess_test_1', 'real');
  assert.equal(r.code, 0, r.message);
  assert.equal(r.data.available, true);
  assert.ok(r.data.wsUrl.startsWith('wss://ruying.invalid/api/live-takeover-cc/v1/material/live/channel/command/microphone?clientType=BROWSER&sessionId=sess_test_1&Authorization='), 'WS 地址按文档协议拼出');
});

test('真实模式：视频互动直播创建→开播→接管入队→队列/播放列表查询→全量重排→切换→关播', async () => {
  calls.length = 0;
  const c = await s.post('/api/live/multi/create', { name: '产品发布会', materialIds: 'mat_1, mat_2', callbackUrl: 'https://cdn.invalid/cb' }, 'real');
  assert.equal(c.code, 0, c.message);
  assert.equal(c.data.sessionId, 'msess_test_1');
  const createReq = calls.find((x) => x.path === '/api/2dvh/v1/multi-video-live/channel/create');
  assert.deepEqual(createReq.body.playMaterials, ['mat_1', 'mat_2']);
  assert.equal(createReq.body.callbackUrl, 'https://cdn.invalid/cb');
  assert.equal((await s.post('/api/live/multi/start', { sessionId: 'msess_test_1' }, 'real')).data.ok, true);
  assert.equal((await s.post('/api/live/multi/heartbeat', { sessionId: 'msess_test_1' }, 'real')).data.ok, true);
  const q = await s.post('/api/live/multi/queue', { sessionId: 'msess_test_1', type: 0, content: '现在介绍第二款。', priority: 5 }, 'real');
  assert.equal(q.data.ok, true);
  assert.ok(q.data.commandTraceId, '入队返回服务端生成的 commandTraceId');
  const qReq = calls.find((x) => x.path === '/api/2dvh/v1/live/video-interactive/channel/command/queue');
  assert.equal(qReq.body.type, 0);
  assert.equal(JSON.parse(qReq.body.param).tts_query.content, '现在介绍第二款。');
  assert.equal(qReq.body.priority, 5);
  assert.equal(qReq.body.commandTraceId, q.data.commandTraceId, '同一 traceId 用于幂等');
  const ql = await s.get('/api/live/multi/queue?sessionId=msess_test_1', 'real');
  assert.equal(ql.data.queue.length, 1);
  assert.equal(ql.data.queue[0].content, '现在介绍第二款。');
  const pb = await s.get('/api/live/multi/playback?sessionId=msess_test_1', 'real');
  assert.deepEqual(pb.data.materials.map((m) => m.materialId), ['mat_1', 'mat_2']);
  const put = await fetch(`${srv.base}/api/live/multi/play-materials`, { method: 'PUT', headers: s.headers('real'), body: JSON.stringify({ sessionId: 'msess_test_1', materialIds: ['mat_2', 'mat_1'] }) }).then((x) => x.json());
  assert.equal(put.code, 0, put.message);
  const putReq = calls.find((x) => x.path.endsWith('/play-materials') && x.method === 'PUT');
  assert.deepEqual(putReq.body, ['mat_2', 'mat_1'], '全量重排发素材 id 数组');
  const sw = await s.post('/api/live/multi/play-materials/switch', { sessionId: 'msess_test_1', materialId: 'mat_2' }, 'real');
  assert.equal(sw.data.ok, true);
  const swReq = calls.find((x) => x.path.endsWith('/play-materials/switch'));
  assert.deepEqual(swReq.body, { materialId: 'mat_2' }, '切换只发素材 id');
  const st = await s.get('/api/live/multi/status?sessionId=msess_test_1', 'real');
  assert.equal(st.data.status.state, '直播中');
  assert.equal((await s.post('/api/live/multi/close', { sessionId: 'msess_test_1' }, 'real')).data.ok, true);
  assert.deepEqual(calls.find((x) => x.path === '/api/2dvh/v1/live/video-interactive/channel/close').body, { sessionId: 'msess_test_1' }, '关播只传 sessionId');
});

test('真实模式：账单请求体 owner 取自 Token 的 userId（617），algoGroup 默认 1，语音只认 30/31', async () => {
  calls.length = 0;
  const video = await s.get('/api/bill?tab=video&from=2026-11-01&to=2026-11-17', 'real');
  assert.equal(video.code, 0, video.message);
  assert.deepEqual(video.data.rows, [], '假平台返回 0 条（与第一轮探测 algoGroup 1/2/0 的 count 0 同形，等第二轮定论）');
  const req = calls.find((x) => x.path === '/api/assist/bill/list');
  assert.equal(req.body.owner, 617, 'owner 为本账号 617');
  assert.equal(req.body.algoGroup, 1);
  assert.equal(req.body.algoType, 14);
  assert.equal(req.body.billStartTime, '2026-11-01 00:00:00');
  assert.equal(req.body.billEndTime, '2026-11-17 23:59:59');
  assert.ok(req.body.pageSize <= 1000, '单次最大 1000 条');
  const tts = await s.get('/api/bill?tab=tts&from=2026-11-09&to=2026-11-17&statRange=1', 'real');
  assert.equal(tts.data.rows.length, 1);
  assert.equal(tts.data.rows[0].billingValue, 0.0108, '语音账单行按实测真值形状返回');
  const vReq = calls.find((x) => x.path === '/api/assist/bill/voice/list');
  assert.equal(vReq.body.owner, 617);
  assert.equal(vReq.body.algoType, 31);
  assert.equal(vReq.body.statRange, 1, '1 为日账单');
  const edit = await s.get('/api/bill?tab=image-edit&from=2026-11-01&to=2026-11-17', 'real');
  assert.equal(edit.data.kind, 'none', '图片编辑真实环境也不调接口');
  assert.ok(!calls.some((x) => x.path === '/api/assist/bill/list' && x.body.algoType === null), '没有独立 algoType 就不发请求');
});

/* ================= 视图（纯函数）：按钮禁用状态按控制台原样 ================= */
const liveState = (over = {}) => ({
  mode: 'mock',
  livetest: {
    name: '直播内测', scriptJson: null, scriptFileName: '', scriptText: '',
    session: null, started: false, startedAt: 0, lastHeartbeatAt: 0, heartbeatError: null,
    takeoverKind: 'text', takeoverStream: 'nonstream', takeoverText: '', takeoverAudioUrl: '',
    queue: [], replaceFgFileId: '', replaceBgFileId: '',
    micActive: false, micStatus: '', busy: '', error: null, ...over,
  },
});
const multiState = (over = {}) => ({
  mode: 'mock',
  multitest: {
    name: '产品发布会互动直播', scriptJson: null, scriptFileName: '',
    materialIds: '', rtmpUrl: '', callbackUrl: '',
    session: null, started: false, startedAt: 0, lastHeartbeatAt: 0, heartbeatError: null,
    queueType: '0', queueText: '', queueAudioUrl: '', queueScript: '', queueMaterialId: '', queuePriority: 0,
    queue: [], materials: [], conflict: 'force', busy: '', error: null, ...over,
  },
});

test('视图：直播内测按钮按控制台原样禁用——未传脚本不许点创建，未建会话不许开播/接管', () => {
  const noScript = liveTestView(liveState());
  assert.match(noScript, /data-action="livetest-create"[^>]*disabled/, '未上传脚本 JSON 时「点击创建」须禁用');
  assert.match(noScript, /data-action="livetest-start"[^>]*disabled/, '未创建会话时「点击开始」须禁用');
  assert.match(noScript, /data-action="livetest-mic-toggle"[^>]*disabled/, '未开播时麦克风接管须禁用');
  assert.match(noScript, /data-action="livetest-close"[^>]*disabled/, '未创建会话时「点击退出」须禁用');
  const withScript = liveTestView(liveState({ scriptJson: '{"version":"0.0.1"}', scriptFileName: 'liveScript_x.json' }));
  assert.doesNotMatch(withScript, /data-action="livetest-create"[^>]*disabled/, '传了脚本后「点击创建」须可用');
  assert.match(withScript, /data-action="livetest-start"[^>]*disabled/, '有脚本但未创建会话时「点击开始」仍须禁用');
  const withSession = liveTestView(liveState({
    scriptJson: '{"version":"0.0.1"}',
    session: { sessionId: 'sess_demo_1', statusText: '视频流创建完成、可开播', pullRtmpUrl: 'rtmp://demo.live/live', pullFlvUrl: '', pullHlsUrl: '' },
  }));
  assert.doesNotMatch(withSession, /data-action="livetest-start"[^>]*disabled/, '建好会话后「点击开始」须可用');
  assert.doesNotMatch(withSession, /data-action="livetest-close"[^>]*disabled/, '建好会话后「点击退出」须可用');
});

test('视图：视频互动直播测试按钮按控制台原样禁用——未填素材 ID 不许点开始创建', () => {
  const empty = multiTestView(multiState());
  assert.match(empty, /data-action="multitest-create"[^>]*disabled/, '未填播放列表素材 ID 时「开始创建」须禁用');
  assert.match(empty, /data-action="multitest-start"[^>]*disabled/, '未创建会话时「开始直播」须禁用');
  const withMaterials = multiTestView(multiState({ materialIds: 'mat_1' }));
  assert.doesNotMatch(withMaterials, /data-action="multitest-create"[^>]*disabled/, '填了素材 ID 后「开始创建」须可用');
  assert.match(withMaterials, /data-action="multitest-start"[^>]*disabled/, '有素材但未创建会话时「开始直播」仍须禁用');
});

test('视图：账单页 9 个页签齐全，展示当前 algoGroup（探测未定论，不藏着）', () => {
  const html = billView({
    mode: 'mock',
    bill: { tab: 'video', from: '2026-11-01', to: '2026-11-17', statRange: '1', algoSubType1: '', algoSubType2: '', rows: [], usedSum: null, pagination: null, note: '', algoGroup: 1, loading: false, error: null, loaded: true },
  });
  for (const label of ['人物形象模型生成', '视频合成', '互动直播', '视频互动直播', '声音合成', 'ASR合成', '个人音色模型生成', '图片数字人', '图片编辑']) {
    assert.ok(html.includes(label), `账单缺页签 ${label}`);
  }
  assert.ok(html.includes('algoGroup'), '账单页须展示当前 algoGroup');
  assert.ok(html.includes('本地导出 CSV'), '账单须有本地导出 CSV 按钮');
  assert.ok(html.includes('发送邮箱'), '账单须有发送邮箱按钮');
});

const billState = (tab = 'video', over = {}) => ({
  mode: 'mock',
  me: null,
  bill: { tab, from: '2026-11-01', to: '2026-11-17', statRange: '1', algoSubType1: '', algoSubType2: '', rows: [], usedSum: null, pagination: null, note: '', algoGroup: 1, loading: false, error: null, loaded: true, ...over },
});

test('用量档位：剩余 ≥25% 绿、10%–25% 黄、<10% 或已超 红，总量 0 不分档', () => {
  assert.equal(quotaLevel(0.62, 20), 'ok', '视频合成 0.62/20 剩余 96.9% 应为绿');
  assert.equal(quotaLevel(15, 20), 'ok', '剩余正好 25% 应为绿');
  assert.equal(quotaLevel(15.1, 20), 'warn', '剩余 24.5% 应为黄');
  assert.equal(quotaLevel(18, 20), 'warn', '剩余正好 10% 应为黄');
  assert.equal(quotaLevel(18.1, 20), 'low', '剩余 9.5% 应为红');
  assert.equal(quotaLevel(149.4, 120), 'low', '图片数字人 149.4/120 已超应为红');
  assert.equal(quotaLevel(0, 0), 'none', '总量 0 不分档');
});

test('视图：账单查询加载态不闪烁——按钮文案永远是“查询”，有旧行留旧行，无行只一行小字', () => {
  const rows = [{ id: 'bill_demo_1', billingDate: '2026-11-17', taskName: '演示账单行（样例）', algoType: 14, algoSubType1: '', algoSubType2: '', billingValue: 0.62, billingUnit: 1, startTime: '2026-10-19 10:00:00', endTime: '2026-10-19 10:00:37', status: 5 }];
  const loadingWithRows = billView(billState('video', { loading: true, rows }));
  assert.match(loadingWithRows, /data-action="bill-query"[^>]*disabled/, '加载中查询按钮须禁用');
  assert.ok(loadingWithRows.includes('查询</button>'), '按钮文案永远是“查询”');
  assert.ok(!loadingWithRows.includes('查询中…</button>'), '按钮文案不得变成“查询中…”');
  assert.ok(loadingWithRows.includes('class="spinner"'), '加载态按钮里用 spinner 表现');
  assert.ok(loadingWithRows.includes('bill_demo_1'), '加载中有旧行时留着旧行，不闪白');
  assert.ok(!loadingWithRows.includes('正在查询账单'), '不得整块换成 loadingBlock');
  const loadingEmpty = billView(billState('video', { loading: true }));
  assert.ok(loadingEmpty.includes('data-bill-status'), '无行加载时表区上方有一行查询中小字');
  assert.ok(loadingEmpty.includes('查询中…'), '无行加载时显示“查询中…”');
  assert.ok(!loadingEmpty.includes('正在查询账单'), '无行加载时也不换成 loadingBlock');
  const idle = billView(billState());
  assert.ok(idle.includes('查询</button>'), '空闲时按钮文案也是“查询”');
  assert.ok(!idle.includes('class="spinner"'), '空闲时按钮里没有 spinner');
});

test('视图：账单用量条——演示环境只用实测样例数字并标样例，无口径页签不编条', () => {
  const video = billUsageHtml(billState());
  assert.ok(video.includes('quota-row--ok'), '视频合成 0.62/20 剩余充足应为绿');
  assert.ok(video.includes('已用 0.62 / 共 20 分钟'), '视频合成用量按实测样例展示');
  assert.ok(video.includes('剩余 <b>19.38</b> 分钟'), '视频合成剩余 19.38 分钟');
  assert.ok(video.includes('样例数据'), '演示用量条须标样例');
  const img = billUsageHtml(billState('image-avatar'));
  assert.ok(img.includes('quota-row--low'), '图片数字人 149.4/120 已超应为红');
  assert.ok(img.includes('已用 149.4 / 共 120 秒'), '图片数字人用量按实测样例展示');
  assert.ok(img.includes('已超量'), '已超量须明示');
  const edit = billUsageHtml(billState('image-edit'));
  assert.ok(edit.includes('未开通'), '图片编辑总量 0 显示未开通');
  assert.ok(!edit.includes('quota-bar'), '未开通不画进度条');
  const tts = billUsageHtml(billState('tts'));
  assert.ok(!tts.includes('quota-row'), '声音合成无总量口径，不编用量条');
  assert.ok(tts.includes('按调用计费，无总量口径'), '声音合成如实说明无总量口径');
  const multi = billUsageHtml(billState('multi'));
  assert.ok(!multi.includes('quota-row'), '视频互动直播无实测样例数字，不编用量条');
});

test('视图：账单用量条——真实环境按 quota 来源展示，租户映射不到的页签如实写没有', () => {
  const vendor = billState('video', {});
  vendor.mode = 'real';
  vendor.me = { user: { id: 'u1' }, quota: { kind: 'vendor', items: [
    { key: 'genVideoDuration', label: '视频合成', unit: '分钟', allocated: 20, used: 16, remaining: 4 },
    { key: 'genImageVideoDuration', label: '图片数字人', unit: '秒', allocated: 120, used: 149.4, remaining: -29.4 },
  ], low: ['genImageVideoDuration'] } };
  const vHtml = billUsageHtml(vendor);
  assert.ok(vHtml.includes('quota-row--warn'), '厂商视频合成剩余 20% 应为黄');
  assert.ok(vHtml.includes('数据来源：厂商实时额度'), '真实环境须注明厂商实时额度');
  vendor.bill.tab = 'tts';
  assert.ok(!billUsageHtml(vendor).includes('quota-row'), '厂商声音合成也没有总量口径');
  const tenant = billState('video', {});
  tenant.mode = 'real';
  tenant.me = { user: { id: 'u2' }, quota: { kind: 'tenant', items: {
    video_seconds: { allocated: 3600, used: 900, remaining: 2700 },
    tts_chars: { allocated: 10000, used: 9500, remaining: 500 },
    api_calls: { allocated: 100, used: 10, remaining: 90 },
  }, low: ['tts_chars'] } };
  const tHtml = billUsageHtml(tenant);
  assert.ok(tHtml.includes('quota-row--ok'), '租户视频时长剩余 75% 应为绿');
  assert.ok(tHtml.includes('数据来源：内部台账'), '租户须注明内部台账');
  tenant.bill.tab = 'tts';
  const ttsHtml = billUsageHtml(tenant);
  assert.ok(ttsHtml.includes('quota-row--low'), '租户语音合成剩余 5% 应为红');
  tenant.bill.tab = 'avatar';
  const noMap = billUsageHtml(tenant);
  assert.ok(!noMap.includes('quota-row'), '租户映射不到的页签不硬凑用量条');
  assert.ok(noMap.includes('内部台账只有视频时长'), '租户映射不到的页签如实说明只有三项计量');
  const noQuota = billState('video', {});
  noQuota.mode = 'real';
  noQuota.me = { user: { id: 'u3' }, quota: null };
  assert.ok(billUsageHtml(noQuota).includes('暂时无法获取额度信息'), '真实环境拿不到额度时如实提示，不拿样例充数');
});

test('视图：互动直播管理两个页签齐全，脚本库空态说明“文档里没有脚本接口”', () => {
  const html = liveScriptsView({
    mode: 'mock',
    livescripts: { tab: 'scripts', scripts: [], sessions: [], note: '平台没有直播会话列表接口，这里只列本站创建过的直播会话。', loading: false, error: null },
  });
  assert.ok(html.includes('脚本库'), '缺脚本库页签');
  assert.ok(html.includes('直播会话'), '缺直播会话页签');
  assert.ok(html.includes('上传脚本 JSON'), '脚本库须有上传入口');
  assert.ok(html.includes('没有互动直播脚本的创建'), '脚本库空态须如实说明文档里没有脚本接口');
});
