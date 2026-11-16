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

test('视频合成 param：文档级有效结构，水印文字仅限英文数字', () => {
  const { videoName, param } = buildVideoCreateParam({
    name: '第3章', videoName: '第3章-高级效果', lines: '大家好，欢迎来到本章课程。', subtitle: '底部白字',
    faceFeatureId: 'ff_123', modelUrl: 'https://cdn.invalid/avatar.zip',
  }, { qid: 'qid-test' });
  assert.equal(videoName, '第3章-高级效果');
  const p = JSON.parse(param);
  assert.equal(p.version, '0.0.17');
  assert.equal(p.digital_role.face_feature_id, 'ff_123');
  assert.equal(p.digital_role.url, 'https://cdn.invalid/avatar.zip');
  assert.equal(p.tts_config.qid, 'qid-test');
  assert.equal(p.tts_query.content, '大家好，欢迎来到本章课程。');
  assert.equal(p.subtitle.font_size, 20);
  assert.equal(p.subtitle.font_family, 'Noto Sans S Chinese Black');
  assert.match(p.watermark.content, /^[A-Za-z0-9]+$/);
  assert.throws(() => buildVideoCreateParam({ lines: '太短', faceFeatureId: 'ff', modelUrl: 'https://cdn.invalid/a.zip' }), /至少 10 个字/);
  assert.throws(() => buildVideoCreateParam({ lines: '这是一段足够长的台词内容。', modelUrl: 'https://cdn.invalid/a.zip' }), /face_feature_id/);
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
