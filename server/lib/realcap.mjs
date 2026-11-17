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
import { pick, isLocalUrl } from './ruying.mjs';

export { isLocalUrl };

/** 本机地址平台下载不到，提前拦住（课程 ch5 asr.js 的 isLocalUrl；builder 只在真实模式调用，不走演示路径） */
function assertPublicUrl(url, label) {
  if (isLocalUrl(url)) throw fail('INVALID_INPUT', `${label}是本机地址，平台下载不到，请用本站上传或公网地址。`);
}

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
  assertPublicUrl(audioUrl, '训练音频地址');
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
  assertPublicUrl(videoUrl, '采集视频地址');
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
  assertPublicUrl(body.videoUrl, '新素材视频地址');
  assertPublicUrl(body.modelUrl, '原模型文件地址');
  return body;
}

/** AI 图片编辑请求体（POST /api/2dvh/v1/material/single/image/edit） */
export function buildImageEditBody(p = {}) {
  const images = String(p.images || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!images.length || images.length > 3) throw fail('INVALID_INPUT', '素材图片 1~3 张，每行一个地址。');
  for (const u of images) { if (!isHttpUrl(u)) throw fail('INVALID_INPUT', '素材图片地址需为 http(s) 地址。'); assertPublicUrl(u, '素材图片地址'); }
  return {
    imageName: nonEmpty(p.imageName || 'AI 编辑图片', '图片名称').slice(0, 64),
    param: JSON.stringify({
      images,
      prompt: nonEmpty(p.prompt, '编辑提示词'),
      watermark: { show: p.watermark !== '关闭', content: 'AI生成' },
    }),
  };
}

/** 绿幕分割效果预览请求体（POST /api/2dvh/v1/material/2davatar/model/green/segment/{image|video}/create）
 * 低阈值默认 40（课程 ch3 green.js GREEN_FIELDS：低 10–80 默认 40、高 70–220 默认 160、blur 1–24 默认 3 奇数步长 2、
 * 去绿 0–100 默认 100、色彩平衡 -1–1 默认 0.5）；低阈值 ≥ 高阈值时报 INVALID_INPUT。
 * BlurKs 奇数问题：API_NOTES.md 里无绿幕/blur 内容，文档参数表写 1–24、错误码 84999920 说明写“须为奇数”
 * 的说法只见于课程注释、未对飞书文档原文核实，因此本站只做前端提示（见 capabilities.js blur 字段 hint），不硬拦。 */
export function buildGreenPreviewBody(p = {}) {
  const url = nonEmpty(p.sourceUrl, '图片/视频地址');
  if (!isHttpUrl(url)) throw fail('INVALID_INPUT', '图片/视频地址需为 http(s) 地址。');
  assertPublicUrl(url, '图片/视频地址');
  const isVideo = /\.(mp4|mov|webm|avi)(\?|#|$)/i.test(url);
  const high = clampInt(p.threshold, 160, isVideo ? 70 : 0, isVideo ? 220 : 255);
  const low = clampInt(p.lowThreshold, 40, 10, 80);
  if (low >= high) throw fail('INVALID_INPUT', `绿幕低阈值（${low}）应小于高阈值（${high}），请调小低阈值或调大高阈值。`);
  // 蓝幕分支（课程 buildGreenParam）：采样色 [255,0,0]；色彩平衡未填时默认 0（绿幕默认 0.5）
  const blue = String(p.screen || 'green') === 'blue';
  const sample = blue ? [255, 0, 0] : [0, 255, 0];
  const spill = (p.spill === undefined || p.spill === '') ? (blue ? 0 : 0.5) : clampNum(p.spill, 0.5, -1, 1);
  const param = {
    green_params_refineth_h_bgr: high,
    green_params_refineth_l_bgr: low,
    green_params_blur_ks: clampInt(p.blur, 3, 1, 24),
    green_params_colorbalance: clampInt(p.colorbalance, 100, 0, 100),
    green_params_spill_byalpha: spill,
    green_params_sample_point_bgr: sample,
    green_params_sample_background: { color: sample },
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
 * 键名与结构以 2026-11-17 控制台「视频脚本编辑」导出 JSON（videoScript_2026-11-17_14_23_17.json，
 * 子沫_校园_站姿 + 发音人「亲和」）为准：
 *   · 无 bit_rate、tts_config 无 language；digital_role.position 只含 x/y，
 *     scale/rotation/volume/z_position 与 position 同级；
 *   · tts_config 默认 speed_ratio 1、volume 100、pitch_offset 0，use_action 固定 false；
 *     tts_query.use_action 固定 true；audios 固定 []；
 *   · subtitle 全字段（urls/scale/rgba/font_size/font_family/stroke_width/stroke_rgba/
 *     background_rgba/opacity/subtitle_max_len/subtitle_cut_by_punc/auto_font_size/
 *     sub_to_canvas_width_ratio）；无字幕时整个 subtitle 省略；urls 有 1 个时是字符串、无时是 []。
 *   · 装饰（第二份导出 videoScript_2026-11-17_14_55_34.json 为准）：
 *     foregrounds/backgrounds/background-musics 均为数组、只在填了链接时出现；
 *     title 只在文字非空时出现；foreground-texts 只在文字非空时出现；
 *     effects 只在任一美颜值偏离默认值时出现（38 项 beautify 全量 + whiten_mode/smooth_mode）。
 * videoName 必填；digital_role.face_feature_id 与 url 必填；tts_query.content 不得小于 10 字；
 * 水印文字仅限英文数字。
 */
/** 美颜 38 项：[表单 key（= 平台 beautify 键名）, 默认值]；下巴长短范围 -1~1，其余 0~1 */
export const BEAUTY_DEFAULTS = [
  ['whitenStrength', 0.3], ['reddenStrength', 0.36], ['smoothStrength', 0.74],
  ['shrinkRatio', 0.11], ['enlargeRatio', 0], ['smallRatio', 0.1],
  ['narrowFace', 0], ['roundEyesRatio', 0], ['thinFaceShapeRatio', 0],
  ['chinLength', 0], ['hairlineHeightRatio', 0], ['appleMusle', 0],
  ['narrowNoseRatio', 0], ['noseLengthRatio', 0], ['profileRhinoplasty', 0],
  ['mouthSize', 0], ['philtrumLengthRatio', 0], ['eyeDistanceRatio', 0],
  ['eyeAngleRatio', 0], ['openCanthus', 0], ['brightEyeStrength', 0],
  ['removeDarkCircleStrength', 0], ['removeNasolabialFoldsStrength', 0],
  ['whiteTeeth', 0], ['shrinkCheekbone', 0], ['thinnerHead', 0],
  ['openExternalCanthus', 0], ['shrinkJawbone', 0], ['shrinkRoundFace', 0],
  ['shrinkLongFace', 0], ['shrinkGoddessFace', 0], ['shrinkNaturalFace', 0],
  ['shrinkWholeHead', 0], ['contrastStrength', 0.05], ['saturationStrength', 0.1],
  ['sharpen', 0], ['clear', 0], ['bokehStrength', 0],
];
/** 视频画面的图层 z_position 校验（课程 ch3 layers.js checkZ 等价）：
 * 数字人、前景图、前景文字的 z_position 必填且不可重复；背景与字幕/标题不参与（无 z_position）。
 * 只适用于 video-script：live-script 的 digital_role 按控制台导出无 z_position，不可照搬。 */
export function checkVideoLayers(param) {
  const layers = [];
  if (param.digital_role) layers.push({ kind: '数字人', name: param.digital_role.name || String(param.digital_role.id || ''), z: param.digital_role.z_position });
  (param.foregrounds || []).forEach((f, i) => layers.push({ kind: '前景', name: f.name || `前景${i + 1}`, z: f.z_position }));
  (param['foreground-texts'] || []).forEach((t) => layers.push({ kind: '前景文字', name: t.text, z: t.z_position }));
  const errs = [];
  for (const l of layers) if (!Number.isInteger(l.z)) errs.push(`${l.kind}「${l.name}」缺少 z_position`);
  const seen = new Map();
  for (const l of layers) {
    if (!Number.isInteger(l.z)) continue;
    if (seen.has(l.z)) errs.push(`z_position=${l.z} 重复：${seen.get(l.z)} 与 ${l.kind}「${l.name}」`);
    else seen.set(l.z, `${l.kind}「${l.name}」`);
  }
  return errs;
}
export function buildVideoCreateParam(p = {}, { qid = '', voice = null, avatarId = null, avatarName = '' } = {}) {
  const lines = nonEmpty(p.lines, '台词内容');
  if (words(lines) < 10) throw fail('INVALID_INPUT', '视频合成的台词至少 10 个字。');
  assertPublicUrl(String(p.modelUrl || ''), '数字人形象 zip 包地址');
  const subtitleStyle = String(p.subtitle || '底部白字');
  const videoFormat = String(p.videoFormat || 'mp4').toLowerCase() === 'webm' ? 'webm' : 'mp4';
  const watermarkContent = String(p.watermarkContent || '').trim();
  if (watermarkContent && !/^[A-Za-z0-9]+$/.test(watermarkContent)) throw fail('INVALID_INPUT', '水印内容仅限英文数字。');
  const subtitleUrls = String(p.subtitleUrls || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
  for (const u of subtitleUrls) assertPublicUrl(u, '字幕文件地址');
  const param = {
    version: '0.0.17',
    video_format: videoFormat,
    resolution: [1080, 1920],
    frame_rate: 25,
    watermark: { show: p.watermark !== '关闭', content: watermarkContent },
    digital_role: {
      ...(avatarId ? { id: avatarId } : {}),
      face_feature_id: nonEmpty(p.faceFeatureId, '形象 face_feature_id'),
      name: String(avatarName || '').trim() || String(p.faceFeatureId || '').trim(),
      url: nonEmpty(p.modelUrl, '数字人形象 zip 包地址'),
      position: { x: clampNum(p.roleX, 0, -10000, 10000), y: clampNum(p.roleY, 0, -10000, 10000) },
      scale: clampNum(p.roleScale, 1, 0.5, 2),
      rotation: clampNum(p.roleRotate, 0, 0, 360),
      volume: clampNum(p.roleVolume, 100, 0, 100),
      z_position: clampInt(p.roleLayer, 1, 0, 100),
    },
    tts_config: {
      ...(qid ? { qid } : {}),
      ...(voice?.name ? { name: voice.name } : {}),
      pitch_offset: clampNum(p.pitch, 0, -60, 60),
      speed_ratio: clampNum(p.speed, 1, 0.5, 2),
      volume: clampNum(p.volume, 100, 1, 400),
      ...(voice?.id ? { id: voice.id } : {}),
      use_action: false,
    },
    tts_query: { content: lines, ssml: false, use_action: true },
    audios: [],
  };
  if (subtitleStyle !== '无字幕') {
    param.subtitle = {
      // 控制台导出：无字幕文件时 urls 是 []，有 1 个时是字符串（不是数组）
      urls: subtitleUrls.length === 1 ? subtitleUrls[0] : subtitleUrls,
      scale: clampNum(p.subtitleScale, 1, 0.5, 2),
      rgba: [255, 255, 255, 255],
      font_size: clampInt(p.subtitleFontSize, 20, 1, 200),
      font_family: 'Noto Sans S Chinese Black',
      stroke_width: clampNum(p.subtitleStrokeWidth, 0, 0, 100),
      stroke_rgba: [255, 255, 255, 255],
      background_rgba: [255, 255, 255, 0],
      opacity: clampNum(p.subtitleOpacity, 1, 0, 1),
      subtitle_max_len: clampInt(p.subtitleMaxLen, 0, 0, 10000),
      subtitle_cut_by_punc: p.subtitleCutByPunc === '开启',
      auto_font_size: p.subtitleAutoFontSize === '开启',
      sub_to_canvas_width_ratio: clampNum(p.subtitleCanvasRatio, 1, 0, 2),
      ...(subtitleStyle === '顶部标题' ? { position: { x: 540, y: 120 } } : {}),
    };
  }
  // 装饰：前景图 / 背景图 / 背景音乐（只在填了链接时出现）
  const fgUrl = String(p.foregroundUrl || '').trim();
  if (isHttpUrl(fgUrl)) {
    assertPublicUrl(fgUrl, '前景图地址');
    const fg = {
      name: '前景', type: 0, url: fgUrl,
      rotation: clampNum(p.fgRotate, 0, 0, 360),
      z_position: 2, cycle: false,
      start: clampInt(p.fgStart, 0, 0, 3600000),
      duration: clampInt(p.fgDuration, -1, -1, 3600000),
    };
    const fw = Number(p.fgW), fh = Number(p.fgH);
    if (Number.isFinite(fw) && fw > 0 && Number.isFinite(fh) && fh > 0) {
      fg.rect = [clampNum(p.fgX, 0, -10000, 10000), clampNum(p.fgY, 0, -10000, 10000), Math.round(fw), Math.round(fh)];
    }
    param.foregrounds = [fg];
  }
  const bgUrl = String(p.bgUrl || '').trim();
  if (isHttpUrl(bgUrl)) {
    assertPublicUrl(bgUrl, '背景图地址');
    param.backgrounds = [{
      name: '背景', type: 0, url: bgUrl, rect: [0, 0, 1080, 1920],
      cycle: false, start: clampInt(p.bgStart, 0, 0, 3600000), duration: clampInt(p.bgDuration, -1, -1, 3600000),
    }];
  }
  const bgmUrl = String(p.bgmUrl || '').trim();
  if (isHttpUrl(bgmUrl)) {
    assertPublicUrl(bgmUrl, '背景音乐地址');
    param['background-musics'] = [{ url: bgmUrl, volume: clampNum(p.bgmVolume, 100, 0, 100), cycle: p.bgmCycle !== '关闭' }];
  }
  // 文字：标题 / 前景文字（只在文字非空时出现）
  const textStyle = (text, scaleKey, xKey, yKey, rotKey, sizeKey, opKey) => ({
    text, scale: clampNum(p[scaleKey], 1, 0.5, 2),
    position: { x: clampNum(p[xKey], 0, -10000, 10000), y: clampNum(p[yKey], 0, -10000, 10000) },
    rotation: clampNum(p[rotKey], 0, 0, 360),
    rgba: [255, 255, 255, 255], font_size: clampInt(p[sizeKey], 20, 1, 200),
    font_family: 'Noto Sans S Chinese Black', stroke_width: 0,
    stroke_rgba: [255, 255, 255, 255], background_rgba: [255, 255, 255, 0],
    opacity: clampNum(p[opKey], 1, 0, 1),
  });
  const titleText = String(p.titleText || '').trim();
  if (titleText) param.title = textStyle(titleText, 'titleScale', 'titleX', 'titleY', 'titleRotate', 'titleFontSize', 'titleOpacity');
  const fgText = String(p.fgText || '').trim();
  if (fgText) param['foreground-texts'] = [{ ...textStyle(fgText, 'fgTextScale', 'fgTextX', 'fgTextY', 'fgTextRotate', 'fgTextFontSize', 'fgTextOpacity'), z_position: 3 }];
  // 美颜：任一值偏离默认值才出现 effects（与控制台导出一致：全默认时无 effects 键）
  const beautify = {};
  let beautyTouched = false;
  for (const [key, dflt] of BEAUTY_DEFAULTS) {
    const v = clampNum(p[key], dflt, key === 'chinLength' ? -1 : 0, 1);
    beautify[key] = v;
    if (v !== dflt) beautyTouched = true;
  }
  const whitenMode = clampInt(p.whitenMode, 0, 0, 1);
  const smoothMode = clampInt(p.smoothMode, 0, 0, 1);
  if (whitenMode !== 0 || smoothMode !== 0) beautyTouched = true;
  if (beautyTouched) {
    const ordered = {};
    for (const [key] of BEAUTY_DEFAULTS) {
      ordered[key] = beautify[key];
      if (key === 'whitenStrength') ordered.whiten_mode = whitenMode;
      if (key === 'smoothStrength') ordered.smooth_mode = smoothMode;
    }
    param.effects = { version: '1.0', beautify: ordered };
  }
  // 图层 z_position 校验：人物层与前景图（2）/前景文字（3）不可重复，冲突时指明双方
  const zErrs = checkVideoLayers(param);
  if (zErrs.length) throw fail('INVALID_INPUT', zErrs.join('；'));
  return {
    videoName: nonEmpty(p.videoName || p.name, '视频名称').slice(0, 40),
    param: JSON.stringify(param),
  };
}

/**
 * 直播脚本 param（控制台「直播脚本编辑」导出 JSON，liveScript_2026-11-17_15_18_12.json，
 * 芸馨_直播_站姿 + 发音人「中文（中国）-女-直播-芸馨」为准）：
 *   · 顶层 version "0.0.1"、recycle 0、stream_mode true、sceneList（1 个场景）；
 *     无 video_format/resolution/frame_rate/watermark/subtitle/title；
 *   · digital_role 只有 id/face_feature_id/name/url/scale（无 position/rotation/volume/z_position，
 *     scale 固定 1）；tts_config 有 name/qid/language ""/pitch_offset/speed_ratio/volume
 *     （language 是空串、不是 zh-CN；无 id/use_action）；tts_query 无 use_action；audios 固定 []；
 *   · 装饰只在填了图时出现：foregrounds rect 默认 [0,0,300,300]、无 rotation/z_position/cycle；
 *     backgrounds rect 固定 [0,0,1080,1920]、cycle 固定 true；name 取链接的文件名；
 *   · effects 只在任一美颜值偏离默认值时出现（38 项 beautify 全量 + whiten_mode/smooth_mode，
 *     顺序与视频导出一致：whiten_mode 紧跟 whitenStrength、smooth_mode 紧跟 smoothStrength）；
 *   · 无 title/foreground-texts/background-musics（直播编辑器无标题、前景文字、背景音乐）。
 * 发音人 qid 留空时省略（真实模式创建直播间时用服务端默认音色兜底）；形象 face_feature_id 与模型 zip 地址必填；脚本文案必填。
 */
export function buildLiveScriptParam(p = {}, { qid = '', voice = null, avatarId = null, avatarName = '' } = {}) {
  const script = nonEmpty(p.script, '直播脚本文案');
  const faceFeatureId = nonEmpty(p.faceFeatureId, '形象 face_feature_id');
  const modelUrl = nonEmpty(p.modelUrl, '形象模型地址');
  if (!isHttpUrl(modelUrl)) throw fail('INVALID_INPUT', '形象模型地址需为 http(s) 地址。');
  const scriptQid = String(qid || '').trim();
  // 发音人留空时 qid 省略（与视频脚本一致；真实模式创建直播间时用服务端默认音色兜底）
  const scene = {
    digital_role: {
      ...(avatarId ? { id: avatarId } : {}),
      face_feature_id: faceFeatureId,
      ...(String(avatarName || '').trim() ? { name: String(avatarName).trim() } : {}),
      url: modelUrl,
      scale: 1,
    },
    tts_config: {
      ...(voice?.name ? { name: voice.name } : {}),
      ...(scriptQid ? { qid: scriptQid } : {}),
      language: '',
      pitch_offset: clampNum(p.pitch, 0, -60, 60),
      speed_ratio: clampNum(p.speed, 1, 0.5, 2),
      volume: clampNum(p.volume, 100, 1, 400),
    },
    tts_query: { content: script, ssml: false },
    audios: [],
  };
  const urlName = (u) => { try { const s = decodeURIComponent(String(u).split('?')[0].split('/').pop() || ''); return s || 'image.png'; } catch { return 'image.png'; } };
  const fgUrl = String(p.foregroundUrl || '').trim();
  if (fgUrl) {
    if (!isHttpUrl(fgUrl)) throw fail('INVALID_INPUT', '前景图地址需为 http(s) 地址。');
    scene.foregrounds = [{
      type: 0, name: urlName(fgUrl), url: fgUrl,
      rect: [clampNum(p.fgX, 0, -10000, 10000), clampNum(p.fgY, 0, -10000, 10000),
        clampNum(p.fgW, 300, 1, 10000), clampNum(p.fgH, 300, 1, 10000)],
      start: clampInt(p.fgStart, 0, 0, 3600000),
      duration: clampInt(p.fgDuration, -1, -1, 3600000),
    }];
  }
  const bgUrl = String(p.bgUrl || '').trim();
  if (bgUrl) {
    if (!isHttpUrl(bgUrl)) throw fail('INVALID_INPUT', '背景图地址需为 http(s) 地址。');
    scene.backgrounds = [{
      type: 0, name: urlName(bgUrl), url: bgUrl, rect: [0, 0, 1080, 1920], cycle: true,
      start: clampInt(p.bgStart, 0, 0, 3600000),
      duration: clampInt(p.bgDuration, -1, -1, 3600000),
    }];
  }
  const beautify = {};
  let beautyTouched = false;
  for (const [key, dflt] of BEAUTY_DEFAULTS) {
    const v = clampNum(p[key], dflt, key === 'chinLength' ? -1 : 0, 1);
    beautify[key] = v;
    if (v !== dflt) beautyTouched = true;
  }
  const whitenMode = clampInt(p.whitenMode, 0, 0, 1);
  const smoothMode = clampInt(p.smoothMode, 0, 0, 1);
  if (whitenMode !== 0 || smoothMode !== 0) beautyTouched = true;
  if (beautyTouched) {
    const ordered = {};
    for (const [key] of BEAUTY_DEFAULTS) {
      ordered[key] = beautify[key];
      if (key === 'whitenStrength') ordered.whiten_mode = whitenMode;
      if (key === 'smoothStrength') ordered.smooth_mode = smoothMode;
    }
    scene.effects = { version: '1.0', beautify: ordered };
  }
  return { name: nonEmpty(p.name, '脚本名称').slice(0, 64), param: JSON.stringify({ version: '0.0.1', recycle: 0, stream_mode: true, sceneList: [scene] }) };
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
      // scale 与 position 同级（视频导出与超级直播间 Pro 文档样例均如此；旧版把 scale 塞进 position 是错的）
      digital_role: { face_feature_id: faceFeatureId, fileId, position: { x: 0, y: 0 }, scale: 1 },
      tts_config: { language: 'zh-CN', pitch_offset: 0, speed_ratio: 1, volume: 100, ...(qid ? { qid } : {}) },
      tts_query: { content: nonEmpty(p.script, '直播脚本文案'), ssml: false },
    }],
  };
  const body = { param: JSON.stringify(param) };
  if (p.pushMode) body.pushMode = p.pushMode;
  if (p.streamName) body.streamName = String(p.streamName).slice(0, 50);
  return body;
}

/**
 * 超级直播间 Pro 创建 param（POST /api/2dvh/v2/material/live/channel/create，与普通直播共用接口）。
 * 口径以 2026-11-17 飞书文档核查为准（文档 V1.5.2，2026-10-27，超级直播间 Pro“新建直播间”样例）：
 * digital_role 用模型 zip 地址 url（不是预热素材 fileId），含 id/name/position/scale；
 * avatarType 不是创建参数——avatarType=5 只出现在训练任务的 persistent.avatarType 里（复刻训练参数），
 * 旧版 live-pro 表单的 avatarType 字段是臆测，已删除。
 */
export function buildSuperProChannelParam(p = {}, { qid = '', avatarId = '', avatarName = '', faceFeatureId = '', modelUrl = '' } = {}) {
  if (!faceFeatureId || !modelUrl) {
    throw fail('PREREQUISITE',
      '超级直播间需要已训练的数字人形象（face_feature_id 与模型 zip 地址），当前未配置。',
      '先用「形象复刻」训练形象，拿到 face_feature_id 与 zip 包地址后由管理员配到服务端；演示环境不受影响。', 'config');
  }
  if (!isHttpUrl(modelUrl)) throw fail('INVALID_INPUT', '数字人模型 zip 地址需为 http(s) 地址。');
  const param = {
    version: '0.0.1', recycle: 0, stream_mode: true,
    sceneList: [{
      digital_role: {
        ...(avatarId ? { id: Number(avatarId) } : {}),
        face_feature_id: faceFeatureId,
        ...(avatarName ? { name: avatarName } : {}),
        url: modelUrl, position: { x: 0, y: 0 }, scale: 1,
      },
      tts_config: { language: 'zh-CN', pitch_offset: 0, speed_ratio: 1, volume: 100, ...(qid ? { qid } : {}) },
      tts_query: { content: nonEmpty(p.script, '开播脚本文案'), ssml: false },
      audios: [],
    }],
  };
  const body = { name: nonEmpty(p.name, '直播间名称').slice(0, 64), param: JSON.stringify(param) };
  // 控制台超级直播间 RTMP 托管页的 Stream Name（可选，0/50 字符）；带上时平台会用
  if (String(p.streamName || '').trim()) body.streamName = String(p.streamName).trim().slice(0, 50);
  return body;
}

/**
 * 超级直播间接管控制 param（POST /api/2dvh/v1/material/live/super/pro/channel/control）。
 * 口径以 2026-11-17 飞书文档核查为准：请求体 {sessionId, param}，param 为 JSON 串；
 * 切换数字人传 digital_role=数字人标识，切换背景传 backgrounds={file_id, digital_role_file_id, rect, start, duration, volume}，
 * 切换前景传 foregrounds=[{file_id, digital_role_file_id, rect, start, duration, delay, volume}]；
 * 响应只表示接收成功/失败，满足触发条件后自动触发。
 * 控制台一页有两组相同表单（两个接管位）；本站按一组提交，两组可分两次提交。
 * 控制台的 z_pos / start_trace_id / fade_frames / change_bit_rate / 允许延展（delay）不在文档样例里，
 * 填了才随 param 一并发送，未填不发送。
 */
export function buildSuperProControlParam(p = {}) {
  const sessionId = String(p.sessionId || '').trim();
  if (!sessionId) throw fail('INVALID_INPUT', '接管控制需要先创建直播间，拿到 sessionId。');
  const num = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt; };
  const param = {};
  if (String(p.roleId || '').trim()) param.digital_role = String(p.roleId).trim();
  if (String(p.bgFileId || '').trim()) {
    param.backgrounds = {
      file_id: String(p.bgFileId).trim(),
      ...(String(p.bgRoleFileId || '').trim() ? { digital_role_file_id: String(p.bgRoleFileId).trim() } : {}),
      rect: [num(p.bgX, 0), num(p.bgY, 0), num(p.bgW, 1080), num(p.bgH, 1920)],
      start: num(p.bgStart, 0), duration: num(p.bgDuration, -1), volume: num(p.bgVolume, 100),
      ...(String(p.bgTraceId || '').trim() ? { start_trace_id: String(p.bgTraceId).trim() } : {}),
      ...(String(p.bgBitRate || '').trim() ? { change_bit_rate: num(p.bgBitRate, 5) } : {}),
    };
  }
  if (String(p.fgFileId || '').trim()) {
    param.foregrounds = [{
      file_id: String(p.fgFileId).trim(),
      ...(String(p.fgRoleFileId || '').trim() ? { digital_role_file_id: String(p.fgRoleFileId).trim() } : {}),
      rect: [num(p.fgX, 0), num(p.fgY, 0), num(p.fgW, 310), num(p.fgH, 88)],
      start: num(p.fgStart, 0), duration: num(p.fgDuration, 100), delay: String(p.fgExtend || '') === '是',
      volume: num(p.fgVolume, 100),
      ...(String(p.fgZPos || '').trim() ? { z_pos: num(p.fgZPos, 0) } : {}),
      ...(String(p.fgTraceId || '').trim() ? { start_trace_id: String(p.fgTraceId).trim() } : {}),
      ...(String(p.fgFadeFrames || '').trim() ? { fade_frames: num(p.fgFadeFrames, 0) } : {}),
    }];
  }
  if (!Object.keys(param).length) throw fail('INVALID_INPUT', '请至少填一项要切换的内容（数字人、背景或前景）。');
  return { sessionId, param: JSON.stringify(param) };
}

/** 视频互动直播装修任务（POST /api/2dvh/v1/multi-video-live/decoration-tasks） */
/**
 * 直播接管 param（POST /api/2dvh/v2/material/live/channel/command）。
 * 口径见 API_NOTES §直播：体 sessionId + param JSON 串，串内 tts_query.content 为播报文案。
 */
export function buildLiveCommandParam(p = {}) {
  const sessionId = String(p.sessionId || '').trim();
  if (!sessionId) throw fail('INVALID_INPUT', '接管需要先创建直播间，拿到 sessionId。');
  const content = nonEmpty(p.content, '接管文案');
  return { sessionId, param: JSON.stringify({ tts_query: { content, ssml: false } }) };
}

/**
 * 视频互动直播创建请求体（POST /api/2dvh/v1/multi-video-live/channel/create）。
 * 口径以 2026-11-17 飞书文档核查为准：创建需播放列表素材（playMaterials，装修任务产出的
 * materialId）与推流 RTMP 地址（rtmpUrl）；callbackUrl 可选，平台创建成功后按任务回调。
 * 上传的脚本 JSON（控制台第一步上传的 JSON）按装修任务同款口径放进 param（JSON 串）。
 * 注意：param 键名是按装修任务的同款模式推断的，文档原文只给了端点与必填字段，
 * 真实创建前建议对照文档再核一次。
 */
export function buildMultiChannelCreateBody(p = {}) {
  const materialIds = String(p.materialIds || p.playMaterials || '').split(/[\r\n,，]+/).map((s) => s.trim()).filter(Boolean);
  if (!materialIds.length) throw fail('INVALID_INPUT', '请至少填一个播放列表素材 ID（装修任务产出的 materialId）。');
  const body = {
    name: nonEmpty(p.name, '直播间名称').slice(0, 64),
    playMaterials: materialIds,
  };
  const scriptJson = p.scriptJson ?? p.script;
  if (scriptJson !== undefined && String(scriptJson).trim()) {
    body.param = typeof scriptJson === 'string' ? String(scriptJson).trim() : JSON.stringify(scriptJson);
  }
  const rtmpUrl = String(p.rtmpUrl || '').trim();
  if (rtmpUrl) {
    if (!/^rtmp:\/\//i.test(rtmpUrl)) throw fail('INVALID_INPUT', '推流地址需为 rtmp:// 开头的地址。');
    body.rtmpUrl = rtmpUrl;
  }
  const callbackUrl = String(p.callbackUrl || '').trim();
  if (callbackUrl) {
    if (!isHttpUrl(callbackUrl)) throw fail('INVALID_INPUT', '回调地址需为 http(s) 地址。');
    body.callbackUrl = callbackUrl;
  }
  return body;
}

/**
 * 视频互动直播接管入队请求体（POST /api/2dvh/v1/live/video-interactive/channel/command/queue）。
 * 口径以 2026-11-17 飞书文档核查为准（文档 V1.5.2）：体 {sessionId, type, param（JSON 串）,
 * commandTraceId（幂等，同一 traceId 60 秒内重复视为同一条）, priority（0-100，默认 0）}。
 * type：0 语音播报（param 内 tts_query.content，与直播接管同款）/ 1 语音输入（param 内 audioUrl，
 * 一段可公网访问的音频地址）/ 2 接管脚本（param 为接管脚本 JSON 串）。
 * commandTraceId 由服务端生成（调用方不传时用随机串），不要用同一值重复提交不同内容。
 */
export function buildMultiCommandQueueBody(p = {}) {
  const sessionId = String(p.sessionId || '').trim();
  if (!sessionId) throw fail('INVALID_INPUT', '接管入队需要先创建直播间，拿到 sessionId。');
  const type = Number(p.type);
  if (![0, 1, 2].includes(type)) throw fail('INVALID_INPUT', '接管类型只能是 0 语音播报、1 语音输入、2 接管脚本。');
  let param;
  if (type === 0) {
    param = { tts_query: { content: nonEmpty(p.content, '播报文案'), ssml: false } };
  } else if (type === 1) {
    const audioUrl = nonEmpty(p.audioUrl, '语音输入的音频地址');
    if (!isHttpUrl(audioUrl)) throw fail('INVALID_INPUT', '语音输入的音频地址需为 http(s) 地址。');
    assertPublicUrl(audioUrl, '语音输入的音频地址');
    param = { audioUrl };
  } else {
    const script = p.scriptJson ?? p.script;
    if (script === undefined || !String(script).trim()) throw fail('INVALID_INPUT', '接管脚本不能为空（粘贴脚本 JSON 或上传脚本文件）。');
    if (typeof script === 'string') {
      try { param = JSON.parse(script); } catch { throw fail('INVALID_INPUT', '接管脚本不是合法的 JSON，请检查后再提交。'); }
    } else param = script;
  }
  // 控制台接管队列表单含「数字人素材 ID」框；文档 command/queue 体未列出该字段的落点，
  // 本站随 param 一并发送（未填不发送），平台侧按素材标识处理。
  if (String(p.materialId || '').trim()) param.materialId = String(p.materialId).trim();
  return {
    sessionId,
    type,
    param: JSON.stringify(param),
    commandTraceId: String(p.commandTraceId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`),
    priority: clampInt(p.priority, 0, 0, 100),
  };
}

/**
 * 账单查询请求体（POST /api/assist/bill/list，非语音任务明细）。
 * 口径以 2026-11-17 飞书文档核查为准（文档 V1.5.2）：体 {owner（Long，本账号 617）,
 * algoGroup（Integer）, algoType, billStartTime/billEndTime（"YYYY-MM-DD HH:MM:SS"）,
 * pageSize/pageNo/sortName/sortValue}，单次最大 1000 条；返回 {pagination, result, usedSum}。
 * algoGroup 取值尚在探测（第一轮 algoGroup 1/2/0 查视频合成均为 count 0，与控制台显示的
 * 0.62min/7 条对不上，很可能取值不对）：服务端用可配置常量 BILL_ALGO_GROUP（默认 1，
 * 环境变量 RUYING_BILL_ALGO_GROUP），不要因为第一轮 count 0 就认定视频账单没数据。
 */
export const BILL_ALGO_GROUP_DEFAULT = 1;
/** 控制台账单页 9 个页签与 algoType 的映射（文档口径；图片数字人/图片编辑没有独立 algoType，见 BILL_TABS 备注） */
export const BILL_TABS = [
  { id: 'avatar', label: '人物形象模型生成', kind: 'task', algoType: 12 },
  { id: 'video', label: '视频合成', kind: 'task', algoType: 14 },
  { id: 'live', label: '互动直播', kind: 'task', algoType: 17 },
  { id: 'multi', label: '视频互动直播', kind: 'task', algoType: 44 },
  { id: 'tts', label: '声音合成', kind: 'voice', algoType: 31 },
  { id: 'asr', label: 'ASR合成', kind: 'voice', algoType: 30 },
  { id: 'voice-model', label: '个人音色模型生成', kind: 'task', algoType: 11 },
  // 图片数字人：账单接口没有独立的 algoType，控制台该页签列的是图片数字人任务；
  // 本站用视频合成（algoType 14）查询并在页面上如实标注，不按计费单位过滤（单位口径未确认）。
  { id: 'image-avatar', label: '图片数字人', kind: 'task', algoType: 14, note: '账单接口没有图片数字人的独立 algoType，这里列出的是视频合成账单（含图片数字人任务），请按任务名称区分。' },
  // 图片编辑：账单接口没有独立的 algoType，且当前总量为 0（未开通）；本站不调接口，直接说明。
  { id: 'image-edit', label: '图片编辑', kind: 'none', algoType: null, note: '账单接口没有图片编辑的独立 algoType，无法查询；图片编辑当前总量为 0（未开通），账单为空是正常的。' },
];
export const BILL_TAB_IDS = BILL_TABS.map((t) => t.id);
export function billTabOf(id) { return BILL_TABS.find((t) => t.id === id) || BILL_TABS[1]; }

/** 账单日期校验：YYYY-MM-DD，开始不得晚于结束；返回 "YYYY-MM-DD HH:MM:SS" 形式的起止 */
export function billRange(from, to) {
  const okDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim());
  const f = okDate(from) ? String(from).trim() : '';
  const t = okDate(to) ? String(to).trim() : '';
  if (!f || !t) throw fail('INVALID_INPUT', '账单日期范围需要起止日期（YYYY-MM-DD）。');
  if (f > t) throw fail('INVALID_INPUT', '开始日期不能晚于结束日期。');
  return { billStartTime: `${f} 00:00:00`, billEndTime: `${t} 23:59:59` };
}

export function buildBillListBody(p = {}) {
  const { billStartTime, billEndTime } = billRange(p.from, p.to);
  const algoType = Number(p.algoType);
  if (!Number.isFinite(algoType)) throw fail('INVALID_INPUT', '账单查询需要 algoType。');
  return {
    owner: Number(p.owner),
    algoGroup: Number(p.algoGroup ?? BILL_ALGO_GROUP_DEFAULT),
    algoType,
    billStartTime, billEndTime,
    pageSize: clampInt(p.pageSize, 50, 1, 1000),
    pageNo: Math.max(1, Number(p.pageNo) || 1),
    ...(p.sortName ? { sortName: String(p.sortName) } : {}),
    ...(p.sortValue ? { sortValue: String(p.sortValue) } : {}),
  };
}

/**
 * 语音账单查询请求体（POST /api/assist/bill/voice/list）。
 * 口径以 2026-11-17 飞书文档核查为准：体 {owner, algoType（30 ASR/31 TTS）,
 * billStartTime/billEndTime, algoSubType1（PAAS_HTTP/PAAS_WS/PAAS_VIDEO_2D/PAAS_VIDEO_MIX/PAAS_LIVE）,
 * algoSubType2（ASR5/TTS3/TTS4/TTS5/TTS7/TTS8）, statRange（1 日账单/2 月账单）}。
 * 2026-11-17 容器实测已通：2026-11-09~17 查到 2 条 TTS 记录，billingDate 2026-11-12，
 * billingValue 0.0108，billingUnit 3，algoSubType1 PAAS_HTTP、algoSubType2 TTS3。
 */
export function buildBillVoiceListBody(p = {}) {
  const { billStartTime, billEndTime } = billRange(p.from, p.to);
  const algoType = Number(p.algoType);
  if (![30, 31].includes(algoType)) throw fail('INVALID_INPUT', '语音账单的 algoType 只能是 30（ASR）或 31（TTS）。');
  const statRange = Number(p.statRange) === 2 ? 2 : 1;
  return {
    owner: Number(p.owner),
    algoType,
    billStartTime, billEndTime,
    ...(String(p.algoSubType1 || '').trim() ? { algoSubType1: String(p.algoSubType1).trim() } : {}),
    ...(String(p.algoSubType2 || '').trim() ? { algoSubType2: String(p.algoSubType2).trim() } : {}),
    statRange,
  };
}

/** 账单行规整：只取平台原字段，不猜单位含义；billingUnit 原值保留，展示时按原值标注 */
export function normalizeBillRow(r = {}) {
  return {
    id: r.id ?? r.billId ?? '',
    algoType: r.algoType ?? null,
    billingDate: r.billingDate || r.billDate || r.createTime || '',
    billingValue: r.billingValue ?? r.used ?? r.value ?? '',
    billingUnit: r.billingUnit ?? r.unit ?? '',
    algoSubType1: r.algoSubType1 || '',
    algoSubType2: r.algoSubType2 || '',
    startTime: r.startTime || r.billStartTime || '',
    endTime: r.endTime || r.billEndTime || '',
    status: r.status ?? '',
    taskName: r.taskName || r.materialName || r.name || '',
    raw: r,
  };
}
/**
 * 装修任务请求体（POST /api/2dvh/v1/multi-video-live/decoration-tasks）。
 * 按飞书《装修脚本和接管脚本》子文档 2.1 最小可用脚本构造（2.12.0 按文档改对）：
 * digital_role.url 与 tts_config.qid 均为必填；旧版只发了 face_feature_id 与 fileId，
 * 按文档会被平台校验拒绝。param 为 JSON 数组字符串，每元素一份装修脚本。
 */
export function buildDecorationTaskBody(p = {}, { faceFeatureId = '' } = {}) {
  if (!faceFeatureId) {
    throw fail('PREREQUISITE',
      '装修任务需要已训练的数字人形象（face_feature_id），当前未配置。',
      '先用「形象复刻」训练形象，拿到 face_feature_id 后由管理员配到服务端；演示环境不受影响。', 'config');
  }
  const qid = String(p.qid || p.qidInput || '').trim();
  if (!qid) throw fail('INVALID_INPUT', '装修脚本需要选一个发音人（平台要求 tts_config.qid 必填）。');
  const roleUrl = nonEmpty(p.roleUrl, '数字人模型 zip 地址');
  if (!isHttpUrl(roleUrl)) throw fail('INVALID_INPUT', '数字人模型 zip 地址需为 http(s) 地址。');
  assertPublicUrl(roleUrl, '数字人模型 zip 地址');
  const script = {
    version: '0.0.1',
    resolution: [1080, 1920],
    bit_rate: 5,
    sceneList: [{
      digital_role: { face_feature_id: faceFeatureId, url: roleUrl, position: { x: 0, y: 0 }, scale: 1 },
      tts_config: { qid, language: 'zh-CN', pitch_offset: 0, speed_ratio: 1, volume: 100 },
      tts_query: { content: nonEmpty(p.script, '装修脚本文案'), ssml: false },
      backgrounds: [], foregrounds: [],
      effects: { version: '1.0', beautify: { whitenStrength: 0.3, reddenStrength: 0.36, smoothStrength: 0.74 } },
    }],
  };
  return { name: nonEmpty(p.name, '会话名称').slice(0, 64), param: JSON.stringify([script]) };
}

/**
 * 口水词库请求体（POST /api/2dvh/v1/material/voice/content/repository/create）。
 * param 为 JSON 字符串：{type, desc?, digital_role?, tts_config, voice_content}。
 * 文本与音频不可混用：填了音频地址就按音频预热（voice_content 只有 audio），
 * 否则按文本预热（一行一句，tts_query + audio:''）；文本模式下平台要求 tts_config.qid 必填。
 */
export function buildContentRepoBody(p = {}, { faceFeatureId = '' } = {}) {
  const name = nonEmpty(p.materialName, '口水词库名称').slice(0, 64);
  const type = p.type === 'startup_script' ? 'startup_script' : 'quick_response';
  const audioUrls = String(p.audioUrls || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let voiceContent;
  if (audioUrls.length) {
    for (const u of audioUrls) { if (!isHttpUrl(u)) throw fail('INVALID_INPUT', '口水音频地址需为 http(s) 地址。'); assertPublicUrl(u, '口水音频地址'); }
    voiceContent = audioUrls.map((audio) => ({ audio }));
  } else {
    const lines = String(p.lines || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) throw fail('INVALID_INPUT', '请至少写一句口水话，或填音频地址（二选一，不可混用）。');
    voiceContent = lines.map((content) => ({ tts_query: { content, ssml: false }, audio: '' }));
  }
  const ttsConfig = {
    pitch_offset: clampNum(p.pitch, 0, -60, 60) ?? 0,
    speed_ratio: clampNum(p.speed, 1, 0.5, 2) ?? 1,
    volume: clampInt(p.volume, 100, 1, 400) ?? 100,
  };
  if (!audioUrls.length) {
    const qid = String(p.qid || p.qidInput || '').trim();
    if (!qid) throw fail('INVALID_INPUT', '文本模式需要选一个发音人（平台要求有文本时 QID 必填）。');
    ttsConfig.qid = qid;
  }
  const param = {
    type,
    ...(p.desc ? { desc: String(p.desc).slice(0, 200) } : {}),
    tts_config: ttsConfig,
    voice_content: voiceContent,
  };
  if (p.useRole === '开启') {
    if (!faceFeatureId) throw fail('PREREQUISITE', '关联数字人需要已训练的形象（face_feature_id），当前未配置。',
      '先用「形象复刻」训练形象，拿到 face_feature_id 后由管理员配到服务端；不关联也可以直接创建。', 'config');
    param.digital_role = { face_feature_id: faceFeatureId, name: nonEmpty(p.roleName, '数字人名称').slice(0, 64) };
  }
  return { materialName: name, param: JSON.stringify(param) };
}

/**
 * 预热素材请求体（POST /api/2dvh/v1/material/file/warming）。
 * 文档原文：param 表格称“预热内容数组”，但请求样例解码后是单个对象，按样例发对象。
 */
export function buildWarmingBody(p = {}) {
  const fileId = nonEmpty(p.fileId, '素材文件 ID');
  const fileUrl = nonEmpty(p.fileUrl, '素材文件地址');
  if (!isHttpUrl(fileUrl)) throw fail('INVALID_INPUT', '素材文件地址需为 http(s) 地址。');
  assertPublicUrl(fileUrl, '素材文件地址');
  const zid = nonEmpty(p.zid, 'zip 素材文件 ID');
  const md5 = nonEmpty(p.md5, 'zip 素材文件 MD5');
  return { materialName: nonEmpty(p.materialName, '预热任务名称').slice(0, 64), param: JSON.stringify({ fileId, fileUrl, zid, md5 }) };
}

/**
 * 视频转码请求体（POST /api/2dvh/v1/material/file/transcode）。
 * param 为 JSON 数组字符串，每项只有 fileUrl；平台不支持取消与重新生成。
 */
export function buildTranscodeBody(p = {}) {
  const urls = String(p.fileUrls || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!urls.length) throw fail('INVALID_INPUT', '请至少填一个视频文件地址。');
  for (const u of urls) { if (!isHttpUrl(u)) throw fail('INVALID_INPUT', '视频文件地址需为 http(s) 地址。'); assertPublicUrl(u, '视频文件地址'); }
  return { materialName: nonEmpty(p.materialName, '转码任务名称').slice(0, 64), param: JSON.stringify(urls.map((fileUrl) => ({ fileUrl }))) };
}

/**
 * 过渡视频预处理请求体（POST /api/2dvh/v1/multi-video-live/transition-transcode-tasks）。
 * param 为 JSON 数组字符串，每项 {url, materialId}；materialId 只能用英文字母、数字、
 * 下划线、加号、减号，同一账号下重复会让整个请求失败。
 */
/**
 * 过渡视频任务编号解析（查状态与批量删除共用）：换行 / 逗号 / 中文逗号分隔，去重，最多 10 个。
 * 平台只提供按任务查状态（POST .../transition-transcode-tasks/list，体 {taskIds}）与
 * 按任务批量删除（POST .../transition-transcode-tasks/delete，体 {taskIds}），
 * 没有按素材 ID（materialId）查状态的接口——界面上如实写明，不编一个。
 */
export function parseTransitionTaskIds(input) {
  const ids = (Array.isArray(input) ? input : String(input || '').split(/[\r\n,，]+/))
    .map((s) => String(s).trim()).filter(Boolean);
  const uniq = [...new Set(ids)];
  if (!uniq.length) throw fail('INVALID_INPUT', '请至少填一个过渡视频任务编号。');
  if (uniq.length > 10) throw fail('INVALID_INPUT', '一次最多查 / 删 10 个任务编号。');
  return uniq;
}

/**
 * 预热素材 fileId 解析（查状态与批量删除共用）：换行 / 逗号 / 中文逗号分隔，去重，最多 10 个。
 * 文档 V1.5.2「预热素材查询/删除」：查询 GET .../file/warming/query?fileIds=a,b（fileIds 必填），
 * 删除 POST .../file/warming/del（体 {fileIds}）；都是批量，没有单查 / 单删接口，也没有全量列表接口。
 */
export function parseWarmingFileIds(input) {
  const ids = (Array.isArray(input) ? input : String(input || '').split(/[\r\n,，]+/))
    .map((s) => String(s).trim()).filter(Boolean);
  const uniq = [...new Set(ids)];
  if (!uniq.length) throw fail('INVALID_INPUT', '请至少填一个预热素材文件 ID。');
  if (uniq.length > 10) throw fail('INVALID_INPUT', '一次最多查 / 删 10 个文件 ID。');
  return uniq;
}

export function buildTransitionBody(p = {}) {
  const url = nonEmpty(p.url, '过渡视频地址');
  if (!isHttpUrl(url)) throw fail('INVALID_INPUT', '过渡视频地址需为 http(s) 地址。');
  assertPublicUrl(url, '过渡视频地址');
  const materialId = nonEmpty(p.materialId, '素材 ID');
  if (!/^[A-Za-z0-9_+-]+$/.test(materialId)) throw fail('INVALID_INPUT', '素材 ID 只能用英文字母、数字、下划线、加号、减号。');
  return { name: nonEmpty(p.name, '任务名称').slice(0, 64), param: JSON.stringify([{ url, materialId }]) };
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
