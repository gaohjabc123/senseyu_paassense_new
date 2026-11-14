// realcap.mjs —— 真实链路：各能力的平台请求体构造、任务结果提取、厂商额度预检
//
// 口径依据：飞书《如影数字人 PaaS 产品文档》（2026-11-14 浏览器逐页核对）与
// ~/workspace/softsugar-real-integration/API_NOTES.md。
//   · 视频合成 video/create：videoName 必填 + param JSON 串；digital_role.face_feature_id 必填、
//     url（形象 zip）必填；tts_query.content 不得小于 10 字；subtitle 需 rgba/font_size/font_family。
//   · 音色复刻 clone/qid/create：audioUrl、audioLanguage、consent{audioUrl,speakerName,companyName}、
//     taskType、voice{name,gender} 均必填；data 为任务 id（整数）。
//   · 形象复刻 multi/create：materialName、videoUrl（≥6min）、param JSON 串必填；
//     personal.segmentStyle 必填；persistent.videoCrfQuality、stage1Config、dev.stage2.config 必填。
//   · 模型更新 rebuilding/video：扁平字段，materialName、videoUrl、modelUrl 必填；
//     dynamicRangeStart/End 表中必填（样例缺失，按文档“默认说话第一秒到 3 分半”取 1 / 210）。
//   · 图片编辑 single/image/edit：imageName、param{images[1-3], prompt, watermark} 必填；异步任务，data 为任务 id。
//   · 绿幕预览 green/segment/{image|video}/create：materialName、url、param（snake_case）必填；
//     图片阈值范围 0-255，视频 70-220。
//   · 直播 channel/create（v2）：param JSON 串必填（version 0.0.1 + sceneList）；创建即开始计时；
//     digital_role 直播场景必传预热素材 fileId；心跳 60 秒，丢失超阈值被动关闭。
//   · 视频互动直播：先创建装修任务 decoration-tasks（name + param JSON 数组串），子素材 FINISHED 后
//     才能创建直播；channel/create 需 rtmpUrl + playMaterials。
//   · 平台没有知识库问答 / 流式对话 / NLP10 接口（文档逐篇核查），问答与拟人改写走自建 DeepSeek。
//
// 本文件只含纯函数（除 assertVendorQuota 与 DeepSeek 调用外），可单测。
import { AppError } from './errors.mjs';
import { pick } from './ruying.mjs';

const fail = (code, message, hint = '', action = 'fix') => new AppError({ code, message, hint, action });
const words = (t) => [...String(t || '').replace(/\s/g, '')].length;
const nonEmpty = (v, what) => {
  const s = String(v ?? '').trim();
  if (!s) throw fail('INVALID_INPUT', `${what}不能为空。`);
  return s;
};
const clampInt = (v, dflt, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const clampNum = (v, dflt, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};
const isHttpUrl = (u) => /^https?:\/\//.test(String(u || '').trim());

/** 绿幕分割默认参数（训练接口用驼峰命名；预览接口用 snake_case，见 buildGreenPreviewBody） */
export const GREEN_DEFAULTS = {
  refinethBgr: 160, refinethLBgr: 40, blurKs: 3, colorbalance: 100, spillByalpha: 0.5, samplePointBgr: [0, 255, 0],
};

/** 音色复刻请求体（POST /api/2dvh/v1/material/voice/clone/qid/create） */
export function buildVoiceCloneBody(p = {}) {
  const audioUrl = nonEmpty(p.audioUrl, '训练音频地址');
  if (!isHttpUrl(audioUrl)) throw fail('INVALID_INPUT', '训练音频地址需为 http(s) 地址。');
  const taskType = ['TTS3', 'TTS6', 'TTS7', 'TTS8', 'TTS101'].includes(String(p.taskType || '').toUpperCase())
    ? String(p.taskType).toUpperCase() : 'TTS8';
  const body = {
    audioUrl,
    audioLanguage: String(p.audioLanguage || 'zh-CN').trim() || 'zh-CN',
    consent: {
      audioUrl: nonEmpty(p.consentAudioUrl || audioUrl, '同意音频地址'),
      speakerName: nonEmpty(p.speakerName, '发言人姓名').slice(0, 64),
      companyName: nonEmpty(p.companyName, '公司名称').slice(0, 64),
    },
    taskType,
    voice: {
      name: nonEmpty(p.voiceName, '音色名称').slice(0, 64),
      gender: Number(p.gender) === 1 ? 1 : 2,
    },
    musicSep: p.musicSep === true || p.musicSep === '是',
  };
  if (taskType === 'TTS8' && p.trainMode) body.trainMode = p.trainMode === 'backend_only' ? 'backend_only' : 'common';
  return body;
}

/** 形象复刻请求体（POST /api/2dvh/v1/material/2davatar/model/multi/create） */
export function buildAvatarTrainBody(p = {}) {
  const videoUrl = nonEmpty(p.videoUrl, '采集视频地址');
  if (!isHttpUrl(videoUrl)) throw fail('INVALID_INPUT', '采集视频地址需为 http(s) 地址。');
  const segmentStyle = clampInt(p.segmentStyle, 1, 0, 3);
  const personal = { segmentStyle, assetScale: 1.0 };
  if (segmentStyle === 1 || segmentStyle === 3) {
    Object.assign(personal, {
      greenParamsRefinethBgr: GREEN_DEFAULTS.refinethBgr,
      greenParamsRefinethLBgr: GREEN_DEFAULTS.refinethLBgr,
      greenParamsBlurKs: GREEN_DEFAULTS.blurKs,
      greenParamsColorbalance: GREEN_DEFAULTS.colorbalance,
      greenParamsSpillByalpha: GREEN_DEFAULTS.spillByalpha,
      greenParamsSamplePointBgr: GREEN_DEFAULTS.samplePointBgr,
    });
  }
  if (segmentStyle === 2) personal.removeGreenEdge = false;
  const persistent = {
    avatarType: clampInt(p.avatarType, 0, 0, 5),
    videoCrfQuality: clampInt(p.videoCrfQuality, 23, 0, 51),
    stage1Config: [0, 1],
    dev: { stage2: { config: 0 } }, // 0=2k；直播 / 超级直播间 Pro 只支持 2k
  };
  return {
    materialName: nonEmpty(p.avatarName, '形象名称'),
    videoUrl,
    param: JSON.stringify({ personal, persistent }),
  };
}

/** 人物模型更新请求体（POST /api/2dvh/v1/material/2davatar/model/rebuilding/video，扁平字段） */
export function buildAvatarRebuildBody(p = {}) {
  const segmentStyle = clampInt(p.segmentStyle, 1, 0, 4);
  const body = {
    materialName: nonEmpty(p.materialName, '模型名称'),
    videoUrl: nonEmpty(p.videoUrl, '新素材视频地址'),
    modelUrl: nonEmpty(p.modelUrl, '原模型文件地址'),
    avatarType: [0, 1, 2, 4, 5].includes(Number(p.avatarType)) ? Number(p.avatarType) : 0,
    segmentStyle,
    greenParamsRefinethBgr: GREEN_DEFAULTS.refinethBgr,
    greenParamsRefinethLBgr: GREEN_DEFAULTS.refinethLBgr,
    greenParamsBlurKs: GREEN_DEFAULTS.blurKs,
    greenParamsColorbalance: GREEN_DEFAULTS.colorbalance,
    greenParamsSpillByalpha: GREEN_DEFAULTS.spillByalpha,
    greenParamsSamplePointBgr: GREEN_DEFAULTS.samplePointBgr,
    assetScale: 1.0,
    videoCrfQuality: clampInt(p.videoCrfQuality, 21, 0, 51),
    dynamicRangeStart: Number(p.dynamicRangeStart ?? 1),
    dynamicRangeEnd: Number(p.dynamicRangeEnd ?? 210),
  };
  if (!isHttpUrl(body.videoUrl)) throw fail('INVALID_INPUT', '新素材视频地址需为 http(s) 地址。');
  if (!isHttpUrl(body.modelUrl)) throw fail('INVALID_INPUT', '原模型文件地址需为 http(s) 地址。');
  return body;
}

/** AI 图片编辑请求体（POST /api/2dvh/v1/material/single/image/edit） */
export function buildImageEditBody(p = {}) {
  const images = String(p.images || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!images.length || images.length > 3) throw fail('INVALID_INPUT', '素材图片 1~3 张，每行一个地址。');
  for (const u of images) if (!isHttpUrl(u)) throw fail('INVALID_INPUT', '素材图片地址需为 http(s) 地址。');
  return {
    imageName: nonEmpty(p.imageName || 'AI 编辑图片', '图片名称').slice(0, 64),
    param: JSON.stringify({
      images,
      prompt: nonEmpty(p.prompt, '编辑提示词'),
      watermark: { show: p.watermark !== '关闭', content: 'AI生成' },
    }),
  };
}

/** 绿幕分割效果预览请求体（POST /api/2dvh/v1/material/2davatar/model/green/segment/{image|video}/create） */
export function buildGreenPreviewBody(p = {}) {
  const url = nonEmpty(p.sourceUrl, '图片/视频地址');
  if (!isHttpUrl(url)) throw fail('INVALID_INPUT', '图片/视频地址需为 http(s) 地址。');
  const isVideo = /\.(mp4|mov|webm|avi)(\?|#|$)/i.test(url);
  const param = {
    green_params_refineth_h_bgr: clampInt(p.threshold, 160, isVideo ? 70 : 0, isVideo ? 220 : 255),
    green_params_refineth_l_bgr: 40,
    green_params_blur_ks: clampInt(p.blur, 3, 1, 24),
    green_params_colorbalance: clampInt(p.colorbalance, 100, 0, 100),
    green_params_spill_byalpha: clampNum(p.spill, 0.5, -1, 1),
    green_params_sample_point_bgr: [0, 255, 0],
    green_params_sample_background: { color: [0, 255, 0] },
  };
  return {
    kind: isVideo ? 'video' : 'image',
    materialName: nonEmpty(p.materialName || '绿幕预览', '任务名称').slice(0, 64),
    url,
    param: JSON.stringify(param),
  };
}

/**
 * 视频合成 param（POST /api/2dvh/v1/material/video/create 的 param 字段，JSON 串）。
 * 依据文档参数表：version 最新 0.0.17；digital_role.face_feature_id 与 url 必填；
 * tts_query.content 不得小于 10 字；subtitle 需 rgba/font_size/font_family；水印文字仅限英文数字。
 */
export function buildVideoCreateParam(p = {}, { qid = '' } = {}) {
  const lines = nonEmpty(p.lines, '台词内容');
  if (words(lines) < 10) throw fail('INVALID_INPUT', '视频合成的台词至少 10 个字。');
  const subtitleStyle = String(p.subtitle || '底部白字');
  const param = {
    version: '0.0.17',
    video_format: 'mp4',
    resolution: [1080, 1920],
    bit_rate: 8,
    frame_rate: 25,
    watermark: { show: true, content: 'AIGenerated' },
    digital_role: {
      face_feature_id: nonEmpty(p.faceFeatureId, '形象 face_feature_id'),
      name: String(p.faceFeatureId || '').trim(),
      url: nonEmpty(p.modelUrl, '数字人形象 zip 包地址'),
      position: { x: 0, y: 0, scale: 1.0 },
    },
    tts_config: { language: 'zh-CN', pitch_offset: 0, speed_ratio: 1, volume: 100, ...(qid ? { qid } : {}) },
    tts_query: { content: lines, ssml: false },
  };
  if (subtitleStyle !== '无字幕') {
    param.subtitle = {
      scale: 1,
      rgba: [255, 255, 255, 255],
      font_size: 20,
      font_family: 'Noto Sans S Chinese Black',
      ...(subtitleStyle === '顶部标题' ? { position: { x: 540, y: 120 } } : {}),
    };
  }
  return {
    videoName: nonEmpty(p.videoName || p.name, '视频名称').slice(0, 40),
    param: JSON.stringify(param),
  };
}

/**
 * 直播间创建 param（POST /api/2dvh/v2/material/live/channel/create）。
 * 直播场景 digital_role 必传预热素材 fileId；未配置时直接报前置条件，不让平台报含糊的错。
 */
export function buildLiveChannelParam(p = {}, { qid = '', faceFeatureId = '', fileId = '' } = {}) {
  if (!faceFeatureId || !fileId) {
    throw fail('PREREQUISITE',
      '直播需要已训练并预热的数字人形象（face_feature_id 与预热素材 fileId），当前未配置。',
      '先用「形象复刻」训练形象并在平台预热，拿到 face_feature_id 与 fileId 后由管理员配到服务端；演示环境不受影响。', 'config');
  }
  const param = {
    version: '0.0.1',
    sceneList: [{
      digital_role: { face_feature_id: faceFeatureId, fileId, position: { x: 0, y: 0, scale: 1.0 } },
      tts_config: { language: 'zh-CN', pitch_offset: 0, speed_ratio: 1, volume: 100, ...(qid ? { qid } : {}) },
      tts_query: { content: nonEmpty(p.script, '直播脚本文案'), ssml: false },
    }],
  };
  const body = { param: JSON.stringify(param) };
  if (p.pushMode) body.pushMode = p.pushMode;
  if (p.streamName) body.streamName = String(p.streamName).slice(0, 50);
  return body;
}

/** 视频互动直播装修任务（POST /api/2dvh/v1/multi-video-live/decoration-tasks） */
export function buildDecorationTaskBody(p = {}, { faceFeatureId = '', fileId = '' } = {}) {
  if (!faceFeatureId) {
    throw fail('PREREQUISITE',
      '装修任务需要已训练的数字人形象（face_feature_id），当前未配置。',
      '先用「形象复刻」训练形象，拿到 face_feature_id 后由管理员配到服务端；演示环境不受影响。', 'config');
  }
  const script = {
    version: '0.0.1',
    digital_role: { face_feature_id: faceFeatureId, ...(fileId ? { fileId } : {}) },
    tts_query: { content: nonEmpty(p.script, '装修脚本文案'), ssml: false },
  };
  return { name: nonEmpty(p.name, '会话名称').slice(0, 64), param: JSON.stringify([script]) };
}

/**
 * 把平台任务记录规整成前端体验页可直接渲染的结果。
 * t 为 ruying.mjs normalizeTask 的返回值（含 raw：解析后的 productParam）。
 * 未完成时返回 null（继续轮询）；完成时返回带 output 的结果对象。
 */
export function extractTaskResult(capabilityId, t) {
  if (!t || t.status !== 5) return null;
  const raw = (t.raw && typeof t.raw === 'object') ? t.raw : {};
  const title = t.title || capabilityId;
  if (capabilityId === 'video-image' || capabilityId === 'video-tts' || capabilityId === 'video-script') {
    if (!t.result?.videoUrl) return { output: 'json', title, json: { taskId: t.id, ...raw }, jsonText: JSON.stringify({ taskId: t.id, ...raw }, null, 2), mode: 'real', realModeNote: '任务已完成，但平台未返回视频地址，请在平台控制台查看。' };
    return { output: 'video', title, videoUrl: t.result.videoUrl, thumbUrl: t.result.thumbUrl || '', duration: t.result.duration ?? null, watermark: t.result.watermark || 'AI生成', mode: 'real' };
  }
  if (capabilityId === 'image-edit' || capabilityId === 'avatar-green') {
    const imageUrl = pick(raw, ['imagePath', 'imageUrl', 'url', 'fileUrl']) || pick(t, ['imageUrl', 'imagePath']);
    if (!imageUrl) return { output: 'json', title, json: { taskId: t.id, ...raw }, jsonText: JSON.stringify({ taskId: t.id, ...raw }, null, 2), mode: 'real', realModeNote: '任务已完成，但平台未返回图片地址，请在平台控制台查看。' };
    return { output: 'image', title, imageUrl, mode: 'real' };
  }
  if (capabilityId === 'voice-clone') {
    const qid = pick(raw, ['qid', 'voiceId', 'voice_id', 'id']);
    const json = { taskId: t.id, ...(qid ? { qid } : {}), ...(Object.keys(raw).length ? raw : {}) };
    return { output: 'json', title, json, jsonText: JSON.stringify(json, null, 2), mode: 'real', realModeNote: qid ? '音色已生成，QID 可用于 TTS 配音。' : '训练任务已完成，QID 请在平台控制台查看。' };
  }
  if (capabilityId === 'avatar-train') {
    const ffid = pick(raw, ['faceFeatureId', 'face_feature_id', 'modelId', 'id']);
    const json = { taskId: t.id, ...(ffid ? { faceFeatureId: ffid } : {}), ...(Object.keys(raw).length ? raw : {}) };
    return { output: 'json', title, json, jsonText: JSON.stringify(json, null, 2), mode: 'real', realModeNote: ffid ? '形象已训练完成，face_feature_id 可用于视频合成与直播。' : '训练任务已完成，face_feature_id 请在平台控制台查看。' };
  }
  if (capabilityId === 'avatar-update') {
    const json = { taskId: t.id, ...(Object.keys(raw).length ? raw : {}) };
    return { output: 'json', title, json, jsonText: JSON.stringify(json, null, 2), mode: 'real' };
  }
  const json = { taskId: t.id, ...(Object.keys(raw).length ? raw : {}) };
  return { output: 'json', title, json, jsonText: JSON.stringify(json, null, 2), mode: 'real' };
}

/**
 * 厂商额度预检：调用前查一次平台 resource 接口，额度不足或未开通时给出明确的错，
 * 而不是让平台回含糊的“系统内部错误”（code 99999999）。
 * resource 接口本身失败时放行（不挡调用，让平台自己回答）。
 */
export async function assertVendorQuota(client, key, needed, label) {
  let items;
  try { items = await client.resource(); } catch { return; }
  const item = (items || []).find((x) => x.key === key);
  if (!item) return;
  if (item.allocated <= 0) {
    throw fail('VENDOR_NOT_OPENED', `${label}尚未开通（平台总量为 0）。`,
      '请联系商予科技申请开通该能力额度；演示环境不受影响，可以继续体验。', 'contact');
  }
  if (item.remaining < needed) {
    throw fail('VENDOR_QUOTA_EXHAUSTED', `${label}额度不足：本次需要约 ${needed} ${item.unit}，平台剩余 ${item.remaining} ${item.unit}。`,
      '请联系商予科技追加额度；演示环境不消耗额度，可以继续体验。', 'contact');
  }
}
