// capabilities.test.mjs —— 操作流程数据完整性：前置条件、上手顺序、上传字段、下一步链路互相引用不出错
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, GUIDED_PATH, capById } from '../src/lib/capabilities.js';
import { NEXT_STEPS } from '../src/lib/experience.js';

test('前置条件：每条都有说明，cap 引用都真实存在', () => {
  for (const c of CAPABILITIES) {
    for (const r of c.experience?.requires || []) {
      assert.ok(typeof r.text === 'string' && r.text.length > 0, `${c.id} 的前置条件缺少说明`);
      if (r.cap) assert.ok(capById(r.cap), `${c.id} 的前置条件引用了不存在的能力 ${r.cap}`);
    }
  }
});

test('推荐上手顺序：5 步、能力都存在、无重复', () => {
  assert.equal(GUIDED_PATH.length, 5);
  const ids = GUIDED_PATH.map((s) => s.cap);
  assert.equal(new Set(ids).size, ids.length, '上手顺序里有重复的能力');
  for (const s of GUIDED_PATH) {
    assert.ok(capById(s.cap), `上手顺序引用了不存在的能力 ${s.cap}`);
    assert.ok(typeof s.why === 'string' && s.why.length > 0, `${s.cap} 的上手说明为空`);
  }
  assert.equal(GUIDED_PATH[0].cap, 'video-tts', '第一步应为零前置的文本驱动视频合成');
});

test('上传字段的类型都在服务端白名单里', async () => {
  const { MEDIA_KINDS } = await import('../server/lib/media.mjs');
  let count = 0;
  for (const c of CAPABILITIES) {
    for (const f of c.experience?.fields || []) {
      if (!f.upload) continue;
      count += 1;
      assert.ok(MEDIA_KINDS[f.upload], `${c.id}.${f.key} 的上传类型 ${f.upload} 不在服务端白名单里`);
    }
  }
  assert.ok(count >= 6, `可上传字段只有 ${count} 个，预期至少 6 个`);
});

test('前置条件的服务端配置状态：config 键名都在 /api/config 的返回字段里', () => {
  const KNOWN_CONFIG_KEYS = ['ttsConfigured', 'avatarImageConfigured', 'faceFeatureConfigured', 'avatarModelConfigured', 'liveAvatarConfigured', 'llmConfigured'];
  let count = 0;
  for (const c of CAPABILITIES) {
    for (const r of c.experience?.requires || []) {
      if (!r.config) continue;
      count += 1;
      assert.ok(KNOWN_CONFIG_KEYS.includes(r.config), `${c.id} 的前置条件引用了未知的配置键 ${r.config}`);
    }
  }
  assert.ok(count >= 5, `带服务端配置状态的前置条件只有 ${count} 条，预期至少 5 条`);
});

test('前置条件备注：每条都以「真实模式」开头，写清真实链路再写获取办法', () => {
  let count = 0;
  for (const c of CAPABILITIES) {
    for (const r of c.experience?.requires || []) {
      count += 1;
      assert.ok(typeof r.note === 'string' && r.note.length > 0, `${c.id} 的前置条件 ${r.text} 缺少备注`);
      assert.ok(r.note.startsWith('真实模式'), `${c.id} 的前置条件 ${r.text} 备注未以「真实模式」开头：${r.note}`);
    }
  }
  assert.ok(count >= 20, `前置条件只有 ${count} 条，预期至少 20 条`);
  // 没有前置条件的能力，字段提示须写清真实/演示行为（拟人大模型 NLP10 只有这一处可写）
  const nlp = capById('voice-nlp');
  assert.ok((nlp.experience?.fields || []).some((f) => f.hint?.includes('真实模式')), 'voice-nlp 没有前置条件，字段提示须写清真实模式行为');
});

test('能力矩阵「需要准备」列：有前置条件的都列得出，无前置条件的显示为空', () => {
  for (const c of CAPABILITIES) {
    const reqs = c.experience?.requires || [];
    assert.ok(Array.isArray(reqs), `${c.id} 的 requires 不是数组`);
    for (const r of reqs) assert.ok(r.text.length > 0, `${c.id} 有空的前置条件`);
  }
  const withReqs = CAPABILITIES.filter((c) => (c.experience?.requires || []).length > 0);
  assert.ok(withReqs.length >= 8, `有前置条件的能力只有 ${withReqs.length} 项，预期至少 8 项`);
  assert.ok(CAPABILITIES.some((c) => !(c.experience?.requires || []).length), '应至少有一项能力无前置条件（矩阵列显示为空）');
});

test('下一步链路：来源与目标都存在，参数函数能产出非空值', () => {
  const fakeResults = {
    'voice-tts': { audioUrl: 'https://cdn.invalid/a.mp3' },
    'avatar-train': { json: { faceFeatureId: 'ff_1' } },
    'nlp-kb': {},
  };
  for (const [from, steps] of Object.entries(NEXT_STEPS)) {
    assert.ok(capById(from), `下一步来源 ${from} 不存在`);
    for (const step of steps) {
      assert.ok(capById(step.cap), `${from} 的下一步指向不存在的 ${step.cap}`);
      assert.notEqual(step.cap, from, '下一步不应指向自己');
      const params = step.params(fakeResults[from] || {});
      for (const [k, v] of Object.entries(params)) {
        assert.ok(typeof v === 'string' && v.length > 0, `${from}→${step.cap} 的参数 ${k} 为空`);
        assert.ok((capById(step.cap).experience?.fields || []).some((f) => f.key === k), `${step.cap} 没有 ${k} 这个字段，接不上`);
      }
    }
  }
});

test('图片编辑：控制台弹窗规格（任务名 20 字、3 图上传、提示词必填、水印开关、取消/确定）', () => {
  const cap = capById('image-edit');
  assert.ok(cap, '找不到 image-edit');
  const ex = cap.experience;
  assert.equal(ex.dialogTitle, '图片编辑信息');
  assert.equal(ex.submit, '确定');
  const byKey = Object.fromEntries((ex.fields || []).map((f) => [f.key, f]));
  assert.equal(byKey.imageName.label, '任务名');
  assert.equal(byKey.imageName.maxLength, 20);
  assert.equal(byKey.imageName.required, true);
  assert.equal(byKey.images.type, 'images');
  assert.equal(byKey.images.maxItems, 3);
  assert.equal(byKey.images.required, true);
  assert.ok(String(byKey.images.accept || '').includes('image/webp'), '上传框须接受 WEBP');
  assert.ok(String(byKey.images.accept || '').includes('image/png'), '上传框须接受 PNG');
  assert.equal(byKey.prompt.label, '文本提示词');
  assert.equal(byKey.prompt.required, true);
  assert.equal(byKey.watermark.type, 'toggle');
  assert.equal(byKey.watermark.default, '开启');
  // 请求体口径不变：字段 key 与服务端 buildImageEditBody 的入参一致
  for (const k of ['imageName', 'images', 'prompt', 'watermark']) assert.ok(byKey[k], `缺少字段 ${k}`);
});

test('图片编辑：渲染出弹窗字段、上传框、水印开关与取消/确定按钮', async () => {
  const { experienceView } = await import('../src/lib/experience.js');
  const cap = capById('image-edit');
  const s = { exp: { running: false, params: {}, error: null, result: null }, recent: {}, config: {} };
  const html = experienceView(s, cap);
  for (const needle of ['图片编辑信息', '任务名', '上传图片', '文本提示词', '图片水印', '取消', '确定']) {
    assert.ok(html.includes(needle), `渲染缺失：${needle}`);
  }
  assert.ok(html.includes('img-upload-box'), '须有图片上传框');
  assert.ok(html.includes('multiple'), '上传框须支持多选');
  assert.ok(html.includes('image/webp'), '上传框须接受 WEBP');
  assert.ok(html.includes('maxlength="20"'), '任务名须限 20 字');
  assert.ok(html.includes('type="checkbox"'), '水印须是开关');
  assert.ok(html.includes('data-action="nav-back"'), '取消须走返回');
  assert.ok(!html.includes('data-field="resolution"'), '分辨率没有接口参数，不做假控件');
  assert.ok(html.includes('没有对应的接口参数'), '须在页面上说明分辨率为什么没有控件');
  // 有一张图时出现缩略图与移除按钮
  const s2 = { exp: { running: false, params: { images: 'https://cdn.invalid/a.jpg' }, error: null, result: null }, recent: {}, config: {} };
  const html2 = experienceView(s2, cap);
  assert.ok(html2.includes('img-thumb'), '有一张图时须显示缩略图');
  assert.ok(html2.includes('data-action="exp-images-remove"'), '缩略图须能移除');
});

test('语音合成 TTS：控制台 voiceTest 规格（发音人下拉、直接输 QID、2000 字、三滑块）', () => {
  const cap = capById('voice-tts');
  assert.ok(cap, '找不到 voice-tts');
  const byKey = Object.fromEntries((cap.experience.fields || []).map((f) => [f.key, f]));
  assert.equal(byKey.qid.type, 'select');
  assert.equal(byKey.qid.optionsFrom, 'voiceList');
  assert.equal(byKey.qidInput.type, 'text');
  assert.equal(byKey.text.maxLength, 2000);
  assert.equal(byKey.text.required, true);
  // 三个滑块与控制台一致：语速 0.5～2 默认 1.25（越大越慢）、音量 1～400 默认 200.5、语调 -60～60 默认 0
  assert.equal(byKey.speed.type, 'slider');
  assert.deepEqual([byKey.speed.min, byKey.speed.max, byKey.speed.step, byKey.speed.default], [0.5, 2, 0.05, 1.25]);
  assert.equal(byKey.volume.type, 'slider');
  assert.deepEqual([byKey.volume.min, byKey.volume.max, byKey.volume.step, byKey.volume.default], [1, 400, 1, 200.5]);
  assert.equal(byKey.pitch.type, 'slider');
  assert.deepEqual([byKey.pitch.min, byKey.pitch.max, byKey.pitch.step, byKey.pitch.default], [-60, 60, 1, 0]);
  assert.ok(String(cap.experience.notes || '').includes('speed_ratio'), '备注须写清三滑块对应的接口参数');
});

test('语音合成 TTS：渲染出发音人下拉、三个滑块与 2000 字上限', async () => {
  const { experienceView } = await import('../src/lib/experience.js');
  const cap = capById('voice-tts');
  const voices = [
    { qid: 'qid-a', voiceName: '晓悦', materialName: '女声-甜美-晓悦', gender: 2 },
    { qid: 'qid-b', voiceName: '云泽', materialName: '男声-沉稳-云泽', gender: 1 },
  ];
  const s = { exp: { running: false, params: {}, error: null, result: null }, recent: {}, config: {}, voiceOptions: voices };
  const html = experienceView(s, cap);
  for (const needle of ['发音人', '默认音色（晓悦）', '女声-甜美-晓悦', '男声-沉稳-云泽', '或直接输入 QID', '语速', '音量', '语调', 'maxlength="2000"']) {
    assert.ok(html.includes(needle), `渲染缺失：${needle}`);
  }
  assert.equal((html.match(/type="range"/g) || []).length, 3, '须有三个滑块');
  assert.ok(html.includes('class="range-row"'), '滑块须有范围行样式');
  assert.ok(html.includes('value="1.25"'), '语速默认 1.25');
  assert.ok(html.includes('value="200.5"'), '音量默认 200.5');
  // 列表未加载时显示占位，不空着
  const s2 = { exp: { running: false, params: {}, error: null, result: null }, recent: {}, config: {}, voiceOptions: null };
  assert.ok(experienceView(s2, cap).includes('正在加载发音人列表'), '列表未加载时须显示占位');
});

test('音色复刻：同意音频独立上传（留空时复用训练音频）', () => {
  const cap = capById('voice-clone');
  assert.ok(cap, '找不到 voice-clone');
  const byKey = Object.fromEntries((cap.experience.fields || []).map((f) => [f.key, f]));
  assert.equal(byKey.consentAudioUrl.type, 'text');
  assert.equal(byKey.consentAudioUrl.upload, 'audio');
  assert.ok(String(byKey.consentAudioUrl.hint || '').includes('留空'), '同意音频须说明留空时的兜底');
});

test('任务中心：列表页含状态/能力筛选、搜索、结果链接与保存按钮', async () => {
  const { taskCenterView } = await import('../src/lib/views.js');
  const now = Date.now();
  const s = { taskCenter: { status: 'all', cap: 'all', q: '', list: [
    { id: '9101', capability: 'image-edit', capabilityName: 'AI 图片编辑', name: '校园海报', status: 5, statusText: '已完成', output: 'image', result: { output: 'image', imageUrl: 'https://cdn.invalid/e.jpg', mode: 'real' }, createdAt: now, updatedAt: now },
    { id: '7788', capability: 'video-image', capabilityName: '图片数字人', name: '口播新款智能手表', status: 2, statusText: '生成中', output: 'video', result: null, createdAt: now, updatedAt: now },
  ], total: 2, loading: false, error: null, imported: true } };
  const html = taskCenterView(s);
  assert.ok(html.includes('data-bind="taskCenter.status"'), '须有状态筛选');
  assert.ok(html.includes('data-bind="taskCenter.cap"'), '须有能力筛选');
  assert.ok(html.includes('data-bind="taskCenter.q"'), '须有搜索框');
  assert.ok(html.includes('校园海报'), '须显示任务名');
  assert.ok(html.includes('已完成') && html.includes('生成中'), '须显示状态');
  assert.ok(html.includes('查看图片'), '图片结果须有查看链接');
  assert.ok(html.includes('data-action="taskcenter-save"'), '已完成任务须有保存到作品按钮');
  assert.equal((html.match(/data-action="taskcenter-save"/g) || []).length, 1, '未完成的任务不应出现保存按钮');
});

test('去重：能力矩阵是唯一浏览入口（推荐顺序并进来），创作中心不再重复列胶囊', async () => {
  const { capabilitiesView, createView, sidenav } = await import('../src/lib/views.js');
  const matrix = capabilitiesView({ capFilter: 'all' });
  assert.ok(matrix.includes('推荐上手顺序'), '推荐上手顺序应并进能力矩阵');
  assert.ok(matrix.includes('cap-table') && matrix.includes('能力矩阵'), '能力矩阵须有完整表格');
  assert.ok(!capabilitiesView({ capFilter: 'video' }).includes('推荐上手顺序'), '按大类筛选时不显示推荐顺序');
  const create = createView({}); // 无可用快捷入口，走空态分支
  assert.ok(!create.includes('cap-pill'), '创作中心不应再重复列全部能力胶囊');
  assert.ok(create.includes('href="#capabilities"'), '创作中心应链向能力矩阵');
  const nav = sidenav({ view: 'home', me: null, works: [] });
  assert.ok(nav.includes('data-view="capabilities"') && !nav.includes('data-view="catalog"'), '侧边栏只留能力矩阵，不留能力目录');
});

test('创作中心五个快捷入口：后两个嵌通用体验器（与能力矩阵同一套表单）', async () => {
  const { createView } = await import('../src/lib/views.js');
  const freshExp = (capId) => ({ capId, params: {}, running: false, stage: '', queued: false, startedAt: 0, taskId: null, error: null, result: null, abort: null });
  const base = { me: { access: { modules: ['video-image', 'voice-tts', 'nlp-chat', 'video-tts', 'video-script'] } }, voiceOptions: [], config: null, recent: {} };
  const html = createView({ ...base, createTab: 'textvideo', exp: freshExp('video-tts') });
  assert.equal((html.match(/data-create="/g) || []).length, 5, '快捷入口应为五个');
  assert.ok(html.includes('data-create="textvideo"') && html.includes('data-create="script"'), '须有文本驱动视频与视频脚本编辑两个新入口');
  assert.ok(html.includes('口播文案') && html.includes('生成视频'), '文本驱动视频页应嵌 video-tts 的表单');
  assert.ok(!html.includes('exp-crumb'), '嵌在标签页里时不应重复显示面包屑');
  const script = createView({ ...base, createTab: 'script', exp: freshExp('video-script') });
  assert.ok(script.includes('脚本名称') && script.includes('生成脚本 JSON'), '视频脚本编辑页应嵌 video-script 的表单');
  assert.ok(script.includes('上面五个是常用的快捷入口'), '全部能力卡的文案应与入口数一致');
});
