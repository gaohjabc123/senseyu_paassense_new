// realcap.test.mjs —— 真实链路纯函数单测：请求体构造、任务结果提取、厂商额度预检
// 不发外网请求、不使用真实密钥。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVoiceCloneBody, buildAvatarTrainBody, buildAvatarRebuildBody, buildImageEditBody,
  buildGreenPreviewBody, buildVideoCreateParam, buildLiveChannelParam, buildDecorationTaskBody,
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
