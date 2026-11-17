// realcap.test.mjs —— 真实链路纯函数单测：请求体构造、任务结果提取、厂商额度预检
// 不发外网请求、不使用真实密钥。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVoiceCloneBody, buildAvatarTrainBody, buildAvatarRebuildBody, buildImageEditBody,
  buildGreenPreviewBody, buildVideoCreateParam, buildLiveScriptParam, buildLiveChannelParam,
  buildSuperProChannelParam, buildSuperProControlParam, buildDecorationTaskBody,
  buildLiveCommandParam, buildMultiChannelCreateBody, buildMultiCommandQueueBody,
  buildBillListBody, buildBillVoiceListBody, billRange, billTabOf, normalizeBillRow,
  BILL_ALGO_GROUP_DEFAULT, parseTransitionTaskIds, parseWarmingFileIds,
  extractTaskResult, assertVendorQuota,
} from '../server/lib/realcap.mjs';

test('音色复刻：请求体按文档必填字段构造，TTS10 等非法模型被纠正', () => {
  const b = buildVoiceCloneBody({
    audioUrl: 'https://cdn.invalid/v.mp3', audioLanguage: 'zh-CN',
    speakerName: '小王', companyName: '某某公司', voiceName: '品牌播报音', gender: '2',
    taskType: 'TTS10', trainMode: 'common', musicSep: '否',
  });
  assert.equal(b.audioUrl, 'https://cdn.invalid/v.mp3');
  assert.deepEqual(b.consent, { audioUrl: 'https://cdn.invalid/v.mp3', speakerName: '小王', companyName: '某某公司' });
  assert.equal(b.taskType, 'TTS8', '不在文档列表里的模型应回落到 TTS8');
  assert.deepEqual(b.voice, { name: '品牌播报音', gender: 2 });
  assert.equal(b.musicSep, false);
  assert.equal(b.trainMode, 'common');
  assert.throws(() => buildVoiceCloneBody({ audioUrl: 'https://cdn.invalid/v.mp3' }), /发言人姓名/);
  assert.throws(() => buildVoiceCloneBody({ audioUrl: 'not-a-url', speakerName: '小王', companyName: '某公司', voiceName: '音' }), /http/);
});

test('形象复刻：param 为 JSON 串，含 personal.segmentStyle 与 persistent 必填项', () => {
  const b = buildAvatarTrainBody({ videoUrl: 'https://cdn.invalid/src.mp4', avatarName: '张老师', avatarType: '0', segmentStyle: '1', videoCrfQuality: '23' });
  assert.equal(b.materialName, '张老师');
  assert.equal(b.videoUrl, 'https://cdn.invalid/src.mp4');
  const p = JSON.parse(b.param);
  assert.equal(p.personal.segmentStyle, 1);
  assert.equal(p.personal.greenParamsRefinethBgr, 160);
  assert.equal(p.personal.greenParamsSamplePointBgr.join(','), '0,255,0');
  assert.equal(p.persistent.avatarType, 0);
  assert.equal(p.persistent.videoCrfQuality, 23);
  assert.deepEqual(p.persistent.stage1Config, [0, 1]);
  assert.equal(p.persistent.dev.stage2.config, 0, '默认 2k；直播只支持 2k');
  assert.throws(() => buildAvatarTrainBody({ avatarName: '张老师' }), /采集视频地址/);
});

test('模型更新：扁平字段，含 dynamicRange 默认值与绿幕参数', () => {
  const b = buildAvatarRebuildBody({ materialName: '张老师', videoUrl: 'https://cdn.invalid/new.mp4', modelUrl: 'https://cdn.invalid/model.zip', avatarType: '5', segmentStyle: '1' });
  assert.equal(b.materialName, '张老师');
  assert.equal(b.modelUrl, 'https://cdn.invalid/model.zip');
  assert.equal(b.avatarType, 5);
  assert.equal(b.dynamicRangeStart, 1, '默认说话第一秒');
  assert.equal(b.dynamicRangeEnd, 210, '默认到 3 分半');
  assert.equal(b.greenParamsRefinethBgr, 160);
  assert.throws(() => buildAvatarRebuildBody({ materialName: '张老师', videoUrl: 'https://cdn.invalid/new.mp4' }), /原模型文件地址/);
});

test('图片编辑：images 按行拆成 1~3 个地址，watermark 转为对象', () => {
  const b = buildImageEditBody({ imageName: '校园海报', images: 'https://cdn.invalid/a.jpg\nhttps://cdn.invalid/b.jpg\n', prompt: '并排放在一起', watermark: '开启' });
  assert.equal(b.imageName, '校园海报');
  const p = JSON.parse(b.param);
  assert.deepEqual(p.images, ['https://cdn.invalid/a.jpg', 'https://cdn.invalid/b.jpg']);
  assert.equal(p.prompt, '并排放在一起');
  assert.deepEqual(p.watermark, { show: true, content: 'AI生成' });
  assert.throws(() => buildImageEditBody({ images: '', prompt: 'x' }), /1~3 张/);
  assert.throws(() => buildImageEditBody({ images: 'a\nb\nc\nd', prompt: 'x' }), /1~3 张/);
});

test('绿幕预览：图片与视频分流，param 用 snake_case，视频阈值范围不同', () => {
  const img = buildGreenPreviewBody({ sourceUrl: 'https://cdn.invalid/g.png', threshold: '160', blur: '3' });
  assert.equal(img.kind, 'image');
  assert.deepEqual(JSON.parse(img.param).green_params_sample_point_bgr, [0, 255, 0]);
  const vid = buildGreenPreviewBody({ sourceUrl: 'https://cdn.invalid/g.mp4', threshold: '300', blur: '3' });
  assert.equal(vid.kind, 'video');
  assert.equal(JSON.parse(vid.param).green_params_refineth_h_bgr, 220, '视频阈值上限 220');
  assert.equal(JSON.parse(vid.param).green_params_blur_ks, 3);
});

test('视频合成 param：控制台导出形状（digital_role 同级字段、TTS 默认 1/100/0、字幕全字段）', () => {
  const { videoName, param } = buildVideoCreateParam({
    name: '第3章', videoName: '第3章-高级效果', lines: '大家好，欢迎来到本章课程。', subtitle: '底部白字',
    faceFeatureId: 'ff_123', modelUrl: 'https://cdn.invalid/avatar.zip',
  }, { qid: 'qid-test', voice: { name: '亲和', id: 3777224 }, avatarId: 4255826, avatarName: '子沫_校园_站姿' });
  assert.equal(videoName, '第3章-高级效果');
  const p = JSON.parse(param);
  assert.equal(p.version, '0.0.17');
  assert.ok(!('bit_rate' in p), '导出 JSON 无 bit_rate');
  assert.ok(!('language' in p.tts_config), '导出 JSON 的 tts_config 无 language');
  // digital_role：position 只含 x/y；scale/rotation/volume/z_position 同级（缺 z_position 平台会报 88103006）
  assert.deepEqual(p.digital_role.position, { x: 0, y: 0 });
  assert.equal(p.digital_role.scale, 1);
  assert.equal(p.digital_role.rotation, 0);
  assert.equal(p.digital_role.volume, 100);
  assert.equal(p.digital_role.z_position, 1);
  assert.equal(p.digital_role.id, 4255826);
  assert.equal(p.digital_role.name, '子沫_校园_站姿');
  assert.equal(p.digital_role.face_feature_id, 'ff_123');
  assert.equal(p.digital_role.url, 'https://cdn.invalid/avatar.zip');
  assert.equal(p.tts_config.qid, 'qid-test');
  assert.equal(p.tts_config.name, '亲和');
  assert.equal(p.tts_config.id, 3777224);
  assert.equal(p.tts_config.speed_ratio, 1);
  assert.equal(p.tts_config.volume, 100);
  assert.equal(p.tts_config.pitch_offset, 0);
  assert.equal(p.tts_config.use_action, false);
  assert.equal(p.tts_query.content, '大家好，欢迎来到本章课程。');
  assert.equal(p.tts_query.use_action, true);
  assert.deepEqual(p.audios, []);
  assert.deepEqual(p.subtitle.urls, [], '无字幕文件时 urls 是空数组');
  assert.equal(p.subtitle.font_size, 20);
  assert.equal(p.subtitle.font_family, 'Noto Sans S Chinese Black');
  assert.equal(p.subtitle.subtitle_max_len, 0);
  assert.equal(p.subtitle.sub_to_canvas_width_ratio, 1);
  assert.equal(p.watermark.content, '', '水印内容默认留空（控制台导出默认就是空串）');
  const pMark = JSON.parse(buildVideoCreateParam({ name: '第3章', lines: '大家好，欢迎来到本章课程。', faceFeatureId: 'ff', modelUrl: 'https://cdn.invalid/a.zip', watermarkContent: 'MyMark1' }, {}).param);
  assert.equal(pMark.watermark.content, 'MyMark1', '非空水印内容原样带入');
  assert.ok(!('foregrounds' in p) && !('backgrounds' in p) && !('background-musics' in p), '装饰未填时不出现');
  assert.ok(!('title' in p) && !('foreground-texts' in p) && !('effects' in p), '标题/前景文字/美颜未动时不出现');
  assert.throws(() => buildVideoCreateParam({ lines: '太短', faceFeatureId: 'ff', modelUrl: 'https://cdn.invalid/a.zip' }), /至少 10 个字/);
  assert.throws(() => buildVideoCreateParam({ lines: '这是一段足够长的台词内容。', modelUrl: 'https://cdn.invalid/a.zip' }), /face_feature_id/);
});

test('视频合成 param：装饰/标题/前景文字/美颜按第二份导出 JSON', () => {
  const { param } = buildVideoCreateParam({
    name: '第3章', videoName: '第3章-高级效果',
    lines: '大家好，欢迎来到本章课程。', subtitle: '底部白字', subtitleUrls: 'https://cdn.invalid/sub.srt',
    faceFeatureId: 'ff_123', modelUrl: 'https://cdn.invalid/avatar.zip',
    foregroundUrl: 'https://cdn.invalid/fg.png', fgW: 1024, fgH: 1024,
    bgUrl: 'https://cdn.invalid/bg.png', bgmUrl: 'https://cdn.invalid/bgm.mp3',
    titleText: '测试标题', fgText: '前景文字测试', whitenStrength: 0.5,
  });
  const p = JSON.parse(param);
  assert.equal(p.subtitle.urls, 'https://cdn.invalid/sub.srt', '有 1 个字幕链接时 urls 是字符串');
  assert.equal(p.foregrounds[0].name, '前景');
  assert.equal(p.foregrounds[0].type, 0);
  assert.deepEqual(p.foregrounds[0].rect, [0, 0, 1024, 1024]);
  assert.equal(p.foregrounds[0].z_position, 2);
  assert.equal(p.foregrounds[0].duration, -1);
  assert.deepEqual(p.backgrounds[0].rect, [0, 0, 1080, 1920]);
  assert.equal(p.backgrounds[0].name, '背景');
  assert.equal(p['background-musics'][0].url, 'https://cdn.invalid/bgm.mp3');
  assert.equal(p['background-musics'][0].volume, 100);
  assert.equal(p['background-musics'][0].cycle, true);
  assert.equal(p.title.text, '测试标题');
  assert.equal(p['foreground-texts'][0].text, '前景文字测试');
  assert.equal(p['foreground-texts'][0].z_position, 3);
  assert.equal(p.effects.version, '1.0');
  assert.equal(p.effects.beautify.whitenStrength, 0.5);
  assert.equal(p.effects.beautify.reddenStrength, 0.36, '未动的美颜项取控制台默认值');
  assert.equal(p.effects.beautify.smoothStrength, 0.74);
  assert.equal(p.effects.beautify.whiten_mode, 0);
  assert.equal(p.effects.beautify.smooth_mode, 0);
  assert.equal(Object.keys(p.effects.beautify).length, 40, '38 项 + whiten_mode + smooth_mode');
  // 前景宽高留空时不写 rect（平台按图片原始尺寸）
  const p2 = JSON.parse(buildVideoCreateParam({ name: '第3章', lines: '这是一段足够长的台词内容。', faceFeatureId: 'ff', modelUrl: 'https://cdn.invalid/a.zip', foregroundUrl: 'https://cdn.invalid/fg.png' }).param);
  assert.ok(!('rect' in p2.foregrounds[0]), '前景宽高留空时不写 rect');
});

test('直播脚本 param：控制台导出形状（version 0.0.1、sceneList、digital_role 无 position）', () => {
  const { name, param } = buildLiveScriptParam({
    name: '双十一专场脚本', script: '欢迎来到直播间，今天为大家带来三款好物。',
    faceFeatureId: 'ff_123', modelUrl: 'https://cdn.invalid/avatar.zip',
    foregroundUrl: 'https://cdn.invalid/fg.png', bgUrl: 'https://cdn.invalid/bg.png',
    whitenStrength: 0.5,
  }, { qid: 'qid-test', voice: { name: '中文（中国）-女-直播-芸馨' }, avatarId: 167343, avatarName: '芸馨_直播_站姿' });
  assert.equal(name, '双十一专场脚本');
  const p = JSON.parse(param);
  assert.equal(p.version, '0.0.1');
  assert.equal(p.recycle, 0);
  assert.equal(p.stream_mode, true);
  assert.equal(p.sceneList.length, 1);
  assert.ok(!('video_format' in p) && !('watermark' in p) && !('subtitle' in p) && !('title' in p));
  const s = p.sceneList[0];
  assert.equal(s.digital_role.id, 167343);
  assert.equal(s.digital_role.face_feature_id, 'ff_123');
  assert.equal(s.digital_role.name, '芸馨_直播_站姿');
  assert.equal(s.digital_role.url, 'https://cdn.invalid/avatar.zip');
  assert.equal(s.digital_role.scale, 1);
  assert.ok(!('position' in s.digital_role) && !('rotation' in s.digital_role) && !('volume' in s.digital_role) && !('z_position' in s.digital_role), '直播 digital_role 无 position/rotation/volume/z_position');
  assert.equal(s.tts_config.name, '中文（中国）-女-直播-芸馨');
  assert.equal(s.tts_config.qid, 'qid-test');
  assert.equal(s.tts_config.language, '', '直播 tts_config.language 是空串');
  assert.equal(s.tts_config.speed_ratio, 1);
  assert.equal(s.tts_config.volume, 100);
  assert.ok(!('use_action' in s.tts_config) && !('id' in s.tts_config));
  assert.equal(s.tts_query.content, '欢迎来到直播间，今天为大家带来三款好物。');
  assert.equal(s.tts_query.ssml, false);
  assert.ok(!('use_action' in s.tts_query));
  assert.deepEqual(s.audios, []);
  assert.equal(s.foregrounds[0].type, 0);
  assert.equal(s.foregrounds[0].name, 'fg.png');
  assert.deepEqual(s.foregrounds[0].rect, [0, 0, 300, 300], '前景 rect 默认 300x300');
  assert.equal(s.foregrounds[0].duration, -1);
  assert.ok(!('rotation' in s.foregrounds[0]) && !('cycle' in s.foregrounds[0]) && !('z_position' in s.foregrounds[0]));
  assert.deepEqual(s.backgrounds[0].rect, [0, 0, 1080, 1920]);
  assert.equal(s.backgrounds[0].cycle, true, '背景 cycle 固定 true（视频是 false）');
  assert.equal(s.effects.version, '1.0');
  assert.equal(s.effects.beautify.whitenStrength, 0.5);
  assert.equal(s.effects.beautify.reddenStrength, 0.36, '未动的美颜项取控制台默认值');
  assert.equal(Object.keys(s.effects.beautify).length, 40, '38 项 + whiten_mode + smooth_mode');
  assert.ok(!('title' in s) && !('foreground-texts' in s) && !('background-musics' in s), '直播无标题/前景文字/背景音乐');
  // 全默认时无装饰、无美颜
  const p2 = JSON.parse(buildLiveScriptParam({ name: 'x', script: '欢迎来到直播间，今天为大家带来三款好物。', faceFeatureId: 'ff', modelUrl: 'https://cdn.invalid/a.zip' }, { qid: 'q' }).param);
  assert.ok(!('foregrounds' in p2.sceneList[0]) && !('backgrounds' in p2.sceneList[0]) && !('effects' in p2.sceneList[0]));
  // 发音人留空时 qid 省略（与视频脚本一致；真实模式创建直播间时用服务端默认音色兜底）
  const p3 = JSON.parse(buildLiveScriptParam({ name: 'x', script: '欢迎来到直播间，今天为大家带来三款好物。', faceFeatureId: 'ff', modelUrl: 'https://cdn.invalid/a.zip' }, {}).param);
  assert.ok(!('qid' in p3.sceneList[0].tts_config));
});

test('直播：未配置形象时报前置条件，不让平台报含糊的错', () => {
  assert.throws(() => buildLiveChannelParam({ script: '欢迎来到直播间。' }, {}), /已训练并预热/);
  const b = buildLiveChannelParam({ script: '欢迎来到直播间。' }, { qid: 'qid-test', faceFeatureId: 'ff_1', fileId: 'file_9' });
  const p = JSON.parse(b.param);
  assert.equal(p.version, '0.0.1');
  assert.equal(p.sceneList[0].digital_role.face_feature_id, 'ff_1');
  assert.equal(p.sceneList[0].digital_role.fileId, 'file_9');
  assert.equal(p.sceneList[0].tts_query.content, '欢迎来到直播间。');
  assert.throws(() => buildDecorationTaskBody({ name: '发布会', script: '你好。' }, {}), /face_feature_id/);
  const d = buildDecorationTaskBody({ name: '发布会', script: '你好。', qid: 'qid-test', roleUrl: 'https://cdn.invalid/role.zip' }, { faceFeatureId: 'ff_1' });
  assert.equal(d.name, '发布会');
  const dScene = JSON.parse(d.param)[0].sceneList[0];
  assert.equal(dScene.tts_query.content, '你好。');
  assert.equal(dScene.digital_role.face_feature_id, 'ff_1');
  assert.equal(dScene.digital_role.url, 'https://cdn.invalid/role.zip');
  assert.equal(dScene.tts_config.qid, 'qid-test');
  assert.throws(() => buildDecorationTaskBody({ name: '发布会', script: '你好。', roleUrl: 'https://cdn.invalid/role.zip' }, { faceFeatureId: 'ff_1' }), /发音人/);
});

test('超级直播间 Pro 创建：digital_role 用模型 zip 地址 url，avatarType 不是创建参数', () => {
  assert.throws(() => buildSuperProChannelParam({ name: 'x', script: '欢迎来到直播间。' }, {}), /已训练的数字人形象/);
  assert.throws(() => buildSuperProChannelParam({ name: 'x', script: '欢迎来到直播间。' }, { faceFeatureId: 'ff_1', modelUrl: 'not-a-url' }), /http/);
  const b = buildSuperProChannelParam({ name: '旗舰直播间', script: '欢迎来到直播间。' }, { qid: 'qid-test', avatarId: '167343', avatarName: '芸馨_直播_站姿', faceFeatureId: 'ff_1', modelUrl: 'https://cdn.invalid/role.zip' });
  const p = JSON.parse(b.param);
  assert.equal(b.name, '旗舰直播间');
  assert.equal(p.version, '0.0.1');
  assert.equal(p.recycle, 0);
  assert.equal(p.stream_mode, true);
  const dr = p.sceneList[0].digital_role;
  assert.equal(dr.id, 167343);
  assert.equal(dr.face_feature_id, 'ff_1');
  assert.equal(dr.name, '芸馨_直播_站姿');
  assert.equal(dr.url, 'https://cdn.invalid/role.zip');
  assert.ok(!('fileId' in dr), '超级直播间创建不用预热素材 fileId');
  assert.deepEqual(dr.position, { x: 0, y: 0 });
  assert.equal(dr.scale, 1, 'scale 与 position 同级');
  assert.equal(p.sceneList[0].tts_config.qid, 'qid-test');
  assert.equal(p.sceneList[0].tts_query.content, '欢迎来到直播间。');
  assert.ok(!JSON.stringify(b).includes('avatarType'), '请求体里没有 avatarType');
});

test('超级直播间接管控制：只发文档样例字段，控制台扩展字段填了才发', () => {
  assert.throws(() => buildSuperProControlParam({}), /sessionId/);
  assert.throws(() => buildSuperProControlParam({ sessionId: 'sess_1' }), /至少填一项/);
  const b = buildSuperProControlParam({
    sessionId: 'sess_1', roleId: 'role_9',
    bgFileId: 'bg_1', bgRoleFileId: 'role_9', bgX: 0, bgY: 0, bgW: 1080, bgH: 1920, bgStart: 0, bgDuration: -1, bgVolume: 50,
    fgFileId: 'fg_1', fgRoleFileId: 'role_9', fgX: 0, fgY: 0, fgW: 310, fgH: 88, fgStart: 0, fgDuration: 100, fgExtend: '是', fgVolume: 50,
  });
  assert.equal(b.sessionId, 'sess_1');
  const p = JSON.parse(b.param);
  assert.equal(p.digital_role, 'role_9');
  assert.equal(p.backgrounds.file_id, 'bg_1');
  assert.equal(p.backgrounds.digital_role_file_id, 'role_9');
  assert.deepEqual(p.backgrounds.rect, [0, 0, 1080, 1920]);
  assert.equal(p.backgrounds.volume, 50);
  assert.ok(!('start_trace_id' in p.backgrounds) && !('change_bit_rate' in p.backgrounds), '未填的控制台扩展字段不发送');
  assert.equal(p.foregrounds[0].file_id, 'fg_1');
  assert.deepEqual(p.foregrounds[0].rect, [0, 0, 310, 88]);
  assert.equal(p.foregrounds[0].delay, true, '允许延展到下一个接管映射为 delay');
  assert.ok(!('z_pos' in p.foregrounds[0]) && !('fade_frames' in p.foregrounds[0]), '未填的控制台扩展字段不发送');
  const b2 = buildSuperProControlParam({ sessionId: 'sess_1', fgFileId: 'fg_1', fgZPos: '2', fgFadeFrames: '12', bgFileId: 'bg_1', bgTraceId: 'trace_1', bgBitRate: '5' });
  const p2 = JSON.parse(b2.param);
  assert.equal(p2.foregrounds[0].z_pos, 2);
  assert.equal(p2.foregrounds[0].fade_frames, 12);
  assert.equal(p2.backgrounds.start_trace_id, 'trace_1');
  assert.equal(p2.backgrounds.change_bit_rate, 5);
});

test('任务结果提取：视频带 output，图片提 imageUrl，复刻提 QID，未完成返回 null', () => {
  const videoTask = { id: '7788', status: 5, raw: { videoPath: 'https://cdn.invalid/v.mp4', duration: 6000 }, result: { videoUrl: 'https://cdn.invalid/v.mp4', thumbUrl: '', duration: 6, watermark: 'AI生成' } };
  const v = extractTaskResult('video-image', videoTask);
  assert.equal(v.output, 'video');
  assert.equal(v.videoUrl, 'https://cdn.invalid/v.mp4');
  const imgTask = { id: '9101', status: 5, raw: { imagePath: 'https://cdn.invalid/e.jpg' }, result: null };
  const im = extractTaskResult('image-edit', imgTask);
  assert.equal(im.output, 'image');
  assert.equal(im.imageUrl, 'https://cdn.invalid/e.jpg');
  const cloneTask = { id: '11890', status: 5, raw: { qid: 'qid_new_1' }, result: null };
  const cl = extractTaskResult('voice-clone', cloneTask);
  assert.equal(cl.output, 'json');
  assert.equal(cl.json.qid, 'qid_new_1');
  assert.match(cl.jsonText, /qid_new_1/);
  const trainTask = { id: '17548', status: 5, raw: { faceFeatureId: 'ff_new' }, result: null };
  assert.equal(extractTaskResult('avatar-train', trainTask).json.faceFeatureId, 'ff_new');
  assert.equal(extractTaskResult('video-tts', { id: '1', status: 2, raw: {}, result: null }), null, '未完成时继续轮询');
  const noUrl = extractTaskResult('video-image', { id: '2', status: 5, raw: { foo: 1 }, result: null });
  assert.equal(noUrl.output, 'json', '完成但无视频地址时给 JSON 而不是空结果');
});

test('厂商额度预检：未开通与不足时给明确的错，resource 失败时放行', async () => {
  const client = { resource: async () => ([
    { key: 'genImageVideoDuration', label: '图片数字人', unit: '秒', allocated: 120, used: 149.4, remaining: -29.4 },
    { key: 'genEditImage', label: 'AI 图片编辑', unit: '个', allocated: 0, used: 0, remaining: 0 },
    { key: 'genCharModel', label: '人物形象模型', unit: '个', allocated: 3, used: 0, remaining: 3 },
  ]) };
  await assert.rejects(() => assertVendorQuota(client, 'genImageVideoDuration', 5, '图片数字人'), (e) => e.code === 'VENDOR_QUOTA_EXHAUSTED' && /剩余 -29.4/.test(e.message));
  await assert.rejects(() => assertVendorQuota(client, 'genEditImage', 1, 'AI 图片编辑'), (e) => e.code === 'VENDOR_NOT_OPENED' && /尚未开通/.test(e.message));
  await assertVendorQuota(client, 'genCharModel', 1, '人物形象模型');
  const down = { resource: async () => { throw new Error('boom'); } };
  await assertVendorQuota(down, 'genImageVideoDuration', 5, '图片数字人');
});

// ---- v2.16.0 直播内测 / 视频互动直播测试 / 账单 ----

test('Stream Name：普通直播与超级直播间 Pro 都透传，超 50 字符截断，未填不发', () => {
  const live = buildLiveChannelParam({ script: '你好，欢迎来到直播间。', streamName: '双十一专场' }, { faceFeatureId: 'ff_1', fileId: 'file_1' });
  assert.equal(live.streamName, '双十一专场');
  const long = buildLiveChannelParam({ script: '你好。', streamName: 'x'.repeat(60) }, { faceFeatureId: 'ff_1', fileId: 'file_1' });
  assert.equal(long.streamName.length, 50, 'Stream Name 最多 50 字符');
  const none = buildLiveChannelParam({ script: '你好。' }, { faceFeatureId: 'ff_1', fileId: 'file_1' });
  assert.equal(none.streamName, undefined, '未填不发 streamName');
  const pro = buildSuperProChannelParam({ name: '品牌旗舰', script: '你好。', streamName: '旗舰店专场' }, { faceFeatureId: 'ff_1', modelUrl: 'https://cdn.invalid/model.zip' });
  assert.equal(pro.streamName, '旗舰店专场');
  const proLong = buildSuperProChannelParam({ name: '品牌旗舰', script: '你好。', streamName: 'y'.repeat(60) }, { faceFeatureId: 'ff_1', modelUrl: 'https://cdn.invalid/model.zip' });
  assert.equal(proLong.streamName.length, 50);
  assert.equal('avatarType' in JSON.parse(pro.param), false, '创建参数里不应有臆测的 avatarType');
});

test('直播接管：param 为 JSON 串，内含 tts_query.content；空文案/缺 sessionId 报错', () => {
  const b = buildLiveCommandParam({ sessionId: 'sess_1', content: '欢迎来到直播间。' });
  assert.equal(b.sessionId, 'sess_1');
  assert.deepEqual(JSON.parse(b.param), { tts_query: { content: '欢迎来到直播间。', ssml: false } });
  assert.throws(() => buildLiveCommandParam({ sessionId: 'sess_1', content: '  ' }), /接管文案/);
  assert.throws(() => buildLiveCommandParam({ content: '你好' }), /sessionId/);
});

test('视频互动直播创建：素材 id 按逗号/换行拆分，脚本放 param，rtmp 与 callbackUrl 校验', () => {
  const b = buildMultiChannelCreateBody({
    name: '产品发布会', materialIds: 'mat_1, mat_2\nmat_3，mat_4',
    scriptJson: JSON.stringify({ version: '0.0.1', sceneList: [] }),
    rtmpUrl: 'rtmp://push.invalid/live', callbackUrl: 'https://cdn.invalid/cb',
  });
  assert.equal(b.name, '产品发布会');
  assert.deepEqual(b.playMaterials, ['mat_1', 'mat_2', 'mat_3', 'mat_4']);
  assert.equal(typeof b.param, 'string', '脚本 JSON 按装修任务同款口径放进 param（JSON 串）');
  assert.equal(b.rtmpUrl, 'rtmp://push.invalid/live');
  assert.equal(b.callbackUrl, 'https://cdn.invalid/cb');
  const minimal = buildMultiChannelCreateBody({ name: '发布会', materialIds: 'mat_1' });
  assert.equal(minimal.param, undefined, '不传脚本就不发 param');
  assert.equal(minimal.rtmpUrl, undefined, '不传推流地址就不发 rtmpUrl');
  assert.throws(() => buildMultiChannelCreateBody({ name: '发布会', materialIds: '' }), /素材 ID/);
  assert.throws(() => buildMultiChannelCreateBody({ name: '发布会', materialIds: 'mat_1', rtmpUrl: 'https://cdn.invalid/live' }), /rtmp/);
  assert.throws(() => buildMultiChannelCreateBody({ name: '发布会', materialIds: 'mat_1', callbackUrl: 'not-a-url' }), /http/);
});

test('视频互动直播接管入队：三分支 param 形状各异，priority 夹取 0~100，traceId 服务端生成', () => {
  const t0 = buildMultiCommandQueueBody({ sessionId: 'ms_1', type: 0, content: '现在介绍第二款。', priority: 5 });
  assert.equal(t0.type, 0);
  assert.deepEqual(JSON.parse(t0.param), { tts_query: { content: '现在介绍第二款。', ssml: false } });
  assert.equal(t0.priority, 5);
  assert.ok(t0.commandTraceId, 'commandTraceId 由服务端生成');
  const t0mat = buildMultiCommandQueueBody({ sessionId: 'ms_1', type: 0, content: '你好。', materialId: 'mat_9' });
  assert.equal(JSON.parse(t0mat.param).materialId, 'mat_9', '数字人素材 ID 随 param 一并发送');
  const t1 = buildMultiCommandQueueBody({ sessionId: 'ms_1', type: 1, audioUrl: 'https://cdn.invalid/q.mp3', priority: 150 });
  assert.deepEqual(JSON.parse(t1.param), { audioUrl: 'https://cdn.invalid/q.mp3' });
  assert.equal(t1.priority, 100, 'priority 超出 100 夹取到 100');
  const t2 = buildMultiCommandQueueBody({ sessionId: 'ms_1', type: 2, scriptJson: '{"version":"0.0.1","sceneList":[]}', priority: -3 });
  assert.deepEqual(JSON.parse(t2.param), { version: '0.0.1', sceneList: [] });
  assert.equal(t2.priority, 0, 'priority 低于 0 夹取到 0');
  assert.throws(() => buildMultiCommandQueueBody({ sessionId: 'ms_1', type: 3, content: 'x' }), /只能是 0/);
  assert.throws(() => buildMultiCommandQueueBody({ sessionId: 'ms_1', type: 1, audioUrl: 'not-a-url' }), /http/);
  assert.throws(() => buildMultiCommandQueueBody({ sessionId: 'ms_1', type: 2, scriptJson: '{bad' }), /合法的 JSON/);
  assert.throws(() => buildMultiCommandQueueBody({ sessionId: 'ms_1', type: 0, content: '' }), /播报文案/);
});

test('账单：页签映射 9 个齐全，图片编辑 kind none 不调接口，未知页签回落视频合成', () => {
  assert.equal(billTabOf('avatar').algoType, 12);
  assert.equal(billTabOf('video').algoType, 14);
  assert.equal(billTabOf('live').algoType, 17);
  assert.equal(billTabOf('multi').algoType, 44);
  assert.equal(billTabOf('tts').algoType, 31);
  assert.equal(billTabOf('tts').kind, 'voice');
  assert.equal(billTabOf('asr').algoType, 30);
  assert.equal(billTabOf('voice-model').algoType, 11);
  assert.equal(billTabOf('image-avatar').algoType, 14, '图片数字人没有独立 algoType，用视频合成 14 查询并标注');
  assert.ok(billTabOf('image-avatar').note, '图片数字人页签须带说明');
  assert.equal(billTabOf('image-edit').kind, 'none');
  assert.equal(billTabOf('image-edit').algoType, null);
  assert.equal(billTabOf('nope').id, 'video', '未知页签回落到视频合成');
  assert.equal(BILL_ALGO_GROUP_DEFAULT, 1, 'algoGroup 默认 1（第一轮探测 count 0 未定论，等第二轮）');
});

test('账单日期：起止转 "YYYY-MM-DD HH:MM:SS"，开始晚于结束或格式不对报错', () => {
  assert.deepEqual(billRange('2026-11-01', '2026-11-17'), { billStartTime: '2026-11-01 00:00:00', billEndTime: '2026-11-17 23:59:59' });
  assert.throws(() => billRange('2026-11-17', '2026-11-01'), /不能晚于/);
  assert.throws(() => billRange('2026/11/01', '2026-11-17'), /YYYY-MM-DD/);
  assert.throws(() => billRange('', '2026-11-17'), /YYYY-MM-DD/);
});

test('账单请求体：非语音带 owner/algoGroup/algoType，pageSize 上限 1000；语音只认 30/31', () => {
  const b = buildBillListBody({ owner: 617, algoType: 14, from: '2026-11-01', to: '2026-11-17', pageSize: 5000 });
  assert.equal(b.owner, 617);
  assert.equal(b.algoGroup, 1);
  assert.equal(b.algoType, 14);
  assert.equal(b.billStartTime, '2026-11-01 00:00:00');
  assert.equal(b.billEndTime, '2026-11-17 23:59:59');
  assert.equal(b.pageSize, 1000, '单次最大 1000 条');
  const v = buildBillVoiceListBody({ owner: 617, algoType: 31, from: '2026-11-09', to: '2026-11-17', algoSubType1: 'PAAS_HTTP', algoSubType2: 'TTS3', statRange: 2 });
  assert.equal(v.algoType, 31);
  assert.equal(v.statRange, 2, '2 为月账单');
  assert.equal(v.algoSubType1, 'PAAS_HTTP');
  assert.equal(v.algoSubType2, 'TTS3');
  assert.equal('algoGroup' in v, false, '语音账单体里没有 algoGroup');
  const v2 = buildBillVoiceListBody({ owner: 617, algoType: 30, from: '2026-11-01', to: '2026-11-17' });
  assert.equal(v2.statRange, 1, '默认日账单');
  assert.equal(v2.algoSubType1, undefined, '不填的筛选不发');
  assert.throws(() => buildBillVoiceListBody({ owner: 617, algoType: 14, from: '2026-11-01', to: '2026-11-17' }), /只能是 30/);
});

test('账单行规整：只取平台原字段，2026-11-17 实测的 TTS 真值形状原样保留', () => {
  const r = normalizeBillRow({ id: 'b1', algoType: 31, billingDate: '2026-11-12', billingValue: 0.0108, billingUnit: 3, algoSubType1: 'PAAS_HTTP', algoSubType2: 'TTS3' });
  assert.equal(r.billingDate, '2026-11-12');
  assert.equal(r.billingValue, 0.0108);
  assert.equal(r.billingUnit, 3, 'billingUnit 原值保留，不猜单位含义');
  assert.equal(r.algoSubType1, 'PAAS_HTTP');
  assert.equal(r.algoSubType2, 'TTS3');
});

test('过渡视频任务编号解析：换行/逗号/中文逗号分隔，去重，上限 10 个', () => {
  assert.deepEqual(parseTransitionTaskIds('123\n456, 789，123'), ['123', '456', '789']);
  assert.deepEqual(parseTransitionTaskIds(['a', 'b', 'a']), ['a', 'b']);
  assert.throws(() => parseTransitionTaskIds(''), /至少填一个/);
  assert.throws(() => parseTransitionTaskIds('   \n , '), /至少填一个/);
  assert.throws(() => parseTransitionTaskIds(Array.from({ length: 11 }, (_, i) => `t${i}`).join(',')), /最多查 \/ 删 10 个/);
});

test('预热素材 fileId 解析：换行/逗号/中文逗号分隔，去重，上限 10 个', () => {
  assert.deepEqual(parseWarmingFileIds('file_1\nfile_2, file_3，file_1'), ['file_1', 'file_2', 'file_3']);
  assert.deepEqual(parseWarmingFileIds(['f1', 'f2']), ['f1', 'f2']);
  assert.throws(() => parseWarmingFileIds(''), /至少填一个/);
  assert.throws(() => parseWarmingFileIds(Array.from({ length: 11 }, (_, i) => `f${i}`).join('\n')), /最多查 \/ 删 10 个/);
});
