// capabilities.js —— 如影 PaaS 能力目录【产品唯一数据源，前后端共用】
// 依据：aigc.softsugar.com 后台 8 大模块 24 功能页 + 官方产品文档 26 篇
// 前端 import 渲染表单/矩阵，服务端 import 生成结果；禁止在别处另写一份清单。
//
// 每项 experience 规格：
//   fields[]   输入控件 { key, label, type, placeholder, default, options, hint, upload }
//              upload：该字段可点「上传」直接传本站文件（image | audio | video | media），传完自动填入地址
//   requires[] 前置条件 { text, cap?, note?, config? }：cap 是产出它的能力 id，渲染「去生成」直达链接；
//              note 以「真实模式：……」开头写清真实链路（先做什么、返回什么），再写获取办法/配置状态；
//              config 是服务端配置状态的键名（见 /api/config：ttsConfigured / avatarImageConfigured /
//              faceFeatureConfigured / avatarModelConfigured / liveAvatarConfigured），有值时在条目前显示「服务端已配置 / 未配置」
//   output     结果类型 video | audio | image | json | text | chat
//   submit     提交按钮文案
//   notes      体验提示（真实模式的前置条件等）
//   mockJson   json 类结果的模拟回执
//   mockText   text 类结果的模拟文本
// GUIDED_PATH：推荐上手顺序（第一次用按这个顺序走，每步都是可点的能力）
// realApi / billable：真实模式转发用；realApi 为 null 表示该能力需前置资源，不直接转发。

export const GROUPS = [
  { id: 'video', name: '视频合成', icon: '🎬', desc: '文案、图片、音频一键生成数字人成片', accent: '#4F46E5' },
  { id: 'voice', name: '语音处理', icon: '🔊', desc: '语音合成、音色复刻与声音克隆', accent: '#0891B2' },
  { id: 'avatar', name: '人物形象', icon: '🧑', desc: '形象复刻、模型训练与绿幕处理', accent: '#7C3AED' },
  { id: 'image', name: '图片能力', icon: '🖼️', desc: '图片数字人、AI 图片编辑', accent: '#DB2777' },
  { id: 'nlp', name: '知识与对话', icon: '💬', desc: '知识库管理、问答与流式对话', accent: '#059669' },
  { id: 'live', name: '互动与直播', icon: '📡', desc: '互动数字人、直播脚本与接管', accent: '#EA580C' },
];

export const CAPABILITIES = [
  // ---------- 视频合成 ----------
  {
    id: 'video-tts', group: 'video', name: '文本驱动视频合成', tag: '核心', status: 'ready',
    desc: '输入文案，自动配音并驱动数字人生成口播视频', scene: '商品介绍 / 课程开场 / 通知播报',
    api: 'POST /api/2dvh/v1/material/video/create', doc: '视频合成',
    realApi: '/api/2dvh/v1/material/video/create', billable: true,
    experience: {
      output: 'video', submit: '生成视频',
      requires: [
        { text: '配音音色（QID）', config: 'ttsConfigured', note: '真实模式：先调 TTS 用这个音色合成语音；服务端已配置，直接合成；换音色找管理员' },
        { text: '默认形象图', config: 'avatarImageConfigured', note: '真实模式：再用这张图生成图片数字人视频，与创作中心视频口播同一链路；服务端已配置，直接生成；换图找管理员' },
      ],
      fields: [
        { key: 'text', label: '口播文案', type: 'textarea', default: '新款智能手表今天上市，支持全天心率监测与运动记录，欢迎了解。', placeholder: '输入要播报的文字…', hint: '4～200 字，字数决定视频时长；演示环境返回本地样例视频' },
      ],
      notes: '真实模式先调 TTS 合成语音，再用默认形象图生成图片数字人视频（与创作中心视频口播同一链路）；演示环境返回本地样例视频。',
      mockTitle: '数字人口播成片',
    },
  },
  {
    id: 'video-image', group: 'video', name: '图片数字人', tag: '热门', status: 'ready',
    desc: '一张人像照片 + 一段音频，生成会说话的数字人视频', scene: '营销短视频 / 数字分身',
    api: 'POST /api/2dvh/v1/material/single/image/video/create', doc: '图片数字人',
    realApi: '/api/2dvh/v1/material/single/image/video/create', billable: true,
    experience: {
      output: 'video', submit: '生成数字人视频',
      requires: [
        { text: '人像照片（可公网访问的图片地址）', config: 'avatarImageConfigured', note: '真实模式：用这张照片生成图片数字人视频，图片须可公网访问；留空用服务端默认形象图；点表单右侧「上传」可直接传本站图片' },
        { text: '配音音频地址', cap: 'voice-tts', note: '真实模式：用这段音频驱动口型，音频须可公网访问；先去语音合成生成，或上传自己的录音' },
        { text: '图片数字人额度 ≥ 视频时长', note: '真实模式：视频时长须在图片数字人剩余额度内，剩余额度见工作台「我的额度」，不足时会报明确的错' },
      ],
      fields: [
        { key: 'imageUrl', label: '人像图片地址', type: 'text', default: '', placeholder: 'https://…/portrait.png', upload: 'image', hint: '留空使用服务端默认形象图；也可点右侧「上传」传自己的照片，或填可公网访问的图片地址' },
        { key: 'audioUrl', label: '音频地址', type: 'text', default: '', placeholder: 'https://…/voice.mp3', upload: 'audio', hint: '真实环境必填；先去「语音合成」生成，或点右侧「上传」传自己的录音；演示环境忽略地址直接返回样例成片' },
        { key: 'prompt', label: '视频名称', type: 'text', default: '图片数字人示例' },
        { key: 'duration', label: '时长（秒）', type: 'number', default: '10', hint: '整数秒，至少 5 秒' },
      ],
      notes: '演示环境忽略 URL 直接返回样例成片；真实模式需可公网访问的图片与音频地址。',
      mockTitle: '图片数字人成片',
    },
  },
  {
    id: 'video-script', group: 'video', name: '视频脚本编辑', status: 'ready',
    desc: '可视化编排人物、内容、装饰、字幕与背景音乐，输出 param JSON', scene: '精品课程 / 品牌宣传片',
    api: '视频合成 param JSON', doc: '视频合成',
    realApi: null, billable: false,
    experience: {
      output: 'json', submit: '生成脚本 JSON',
      requires: [
        { text: '形象 face_feature_id', cap: 'avatar-train', config: 'faceFeatureConfigured', note: '真实模式：填了形象与 zip 包地址时，脚本会提交到平台生成视频；服务端已配置时留空即可；想用自己的形象先去形象复刻训一个' },
        { text: '形象 zip 包地址', cap: 'avatar-train', config: 'avatarModelConfigured', note: '真实模式：提交生成时与 face_feature_id 一起用；服务端已配置时留空即可；否则在平台控制台的形象详情里复制模型文件地址' },
        { text: '台词至少 10 个字', note: '真实模式：只生成脚本 JSON 时不提交、不计费；填了形象才会提交生成视频' },
      ],
      fields: [
        { key: 'name', label: '脚本名称', type: 'text', default: '第3章-高级效果' },
        { key: 'lines', label: '台词内容', type: 'textarea', default: '大家好，欢迎来到本章课程。', hint: '提交到平台生成时，台词至少 10 个字' },
        { key: 'subtitle', label: '字幕样式', type: 'select', default: '底部白字', options: [['底部白字', '底部白字'], ['无字幕', '无字幕'], ['顶部标题', '顶部标题']] },
        { key: 'videoName', label: '视频名称（提交生成时用）', type: 'text', default: '第3章-高级效果', hint: '只传台词不提交时可留空' },
        { key: 'faceFeatureId', label: '形象 face_feature_id（提交生成时用）', type: 'text', default: '', placeholder: '训练完成后在平台控制台查看', hint: '服务端已配置时留空即可；填自己训好的形象可覆盖' },
        { key: 'modelUrl', label: '形象 zip 包地址（提交生成时用）', type: 'text', default: '', placeholder: 'https://…/avatar.zip', hint: '服务端已配置时留空即可；否则在平台控制台的形象详情里复制模型文件地址' },
      ],
      notes: '输出的是可直接传给视频合成接口的 param 结构（版本 0.0.17），不单独计费；填了形象 face_feature_id 与 zip 包地址时，真实模式会把这份脚本提交到平台生成视频。',
      mockTitle: '视频脚本 param 结构',
      mockJson: { version: '0.0.17', video_format: 'mp4', resolution: [1080, 1920], bit_rate: 8, frame_rate: 25, digital_role: { face_feature_id: 'your_face_feature_id', name: 'your_face_feature_id', url: 'https://example.com/avatar.zip', position: { x: 0, y: 0, scale: 1.0 } }, tts_config: { language: 'zh-CN', pitch_offset: 0, speed_ratio: 1, volume: 100 }, tts_query: { content: '大家好，欢迎来到本章课程。', ssml: false }, subtitle: { scale: 1, rgba: [255, 255, 255, 255], font_size: 20, font_family: 'Noto Sans S Chinese Black' }, watermark: { show: true, content: 'AIGenerated' } },
    },
  },

  // ---------- 语音处理 ----------
  {
    id: 'voice-tts', group: 'voice', name: '语音合成 TTS', tag: '核心', status: 'ready',
    desc: '文字转语音，使用平台音色（QID）合成可下载的音频', scene: '配音 / 无障碍朗读',
    api: 'POST /api/voice/v3/tts/request', doc: '语音处理',
    realApi: '/api/voice/v3/tts/request', billable: false,
    experience: {
      output: 'audio', submit: '合成语音',
      requires: [
        { text: '配音音色（QID）', config: 'ttsConfigured', note: '真实模式：用这个音色合成语音；服务端已配置，直接合成；换音色找管理员' },
      ],
      fields: [
        { key: 'text', label: '合成文本', type: 'textarea', default: '大家好，欢迎使用如影 AI 能力开放平台。', hint: '4～200 字；演示环境返回本地样例音频' },
      ],
      notes: '真实环境使用服务端配置的平台音色（QID）合成；演示环境返回本地样例音频。',
      mockTitle: '合成语音',
    },
  },
  {
    id: 'voice-clone', group: 'voice', name: '音色复刻', status: 'ready',
    desc: '用少量录音训练专属音色，获得可复用的 QID', scene: '品牌专属播报音 / 数字分身',
    api: 'POST /api/2dvh/v1/material/voice/clone/qid/create', doc: '音色复刻',
    realApi: '/api/2dvh/v1/material/voice/clone/qid/create', billable: true,
    experience: {
      output: 'json', submit: '提交音色训练',
      requires: [
        { text: '训练录音：10 秒以上、清晰人声', note: '真实模式：提交后为异步训练任务，完成后返回 QID；建议自己录一段 10 秒以上清晰人声，或先用本站「语音合成」生成一段；想先试效果可从 LibriVox（librivox.org，免费公有领域有声书）下载一段真人朗读，但训出来的是朗读者的音色；点表单右侧「上传」可直接传本站音频' },
        { text: '发言人姓名与公司名称', note: '真实模式：发言人与公司名称是平台要求的同意声明必填项，须与同意音频里的一致' },
      ],
      fields: [
        { key: 'audioUrl', label: '训练音频 URL', type: 'text', default: '', placeholder: 'https://…/voice-sample.mp3', upload: 'audio', hint: '支持 wav/mp3/m4a/aac，建议 10 秒以上、无底噪的清晰人声；点右侧「上传」可直接传本站音频；演示环境返回示例 QID' },
        { key: 'audioLanguage', label: '主要语言', type: 'text', default: 'zh-CN', hint: 'BCP 47，如 zh-CN / en-US' },
        { key: 'voiceName', label: '音色名称', type: 'text', default: '品牌播报音', hint: '不超过 64 字符' },
        { key: 'gender', label: '性别', type: 'select', default: '2', options: [['2', '女'], ['1', '男']] },
        { key: 'speakerName', label: '发言人姓名（同意声明）', type: 'text', default: '', hint: '须与同意音频里的发言人一致，不超过 64 字符' },
        { key: 'companyName', label: '公司名称（同意声明）', type: 'text', default: '', hint: '须与同意音频一致，不超过 64 字符' },
        { key: 'taskType', label: '训练模型', type: 'select', default: 'TTS8', options: [['TTS8', 'TTS8（推荐）'], ['TTS3', 'TTS3'], ['TTS6', 'TTS6'], ['TTS7', 'TTS7'], ['TTS101', 'TTS101']] },
        { key: 'trainMode', label: '训练方式（仅 TTS8）', type: 'select', default: 'common', options: [['common', '常规'], ['backend_only', '极速训练']] },
        { key: 'musicSep', label: '背景音乐消除', type: 'select', default: '否', options: [['否', '否'], ['是', '是']] },
      ],
      notes: '真实模式为异步训练任务，完成后返回 QID；发言人与公司名称是平台要求的同意声明必填项。',
      mockTitle: '音色复刻结果',
      mockJson: { qid: 'qid_demo_8f3a2c', voiceName: '品牌播报音', model: 'TTS8', status: '训练完成', durationSec: 12, usable: true },
    },
  },
  {
    id: 'voice-nlp', group: 'voice', name: '拟人大模型 NLP10', status: 'ready',
    desc: '面向对话场景的语义理解与拟人口语化表达', scene: '智能客服 / 互动问答',
    api: 'NLP10 参数定义', doc: '语音处理',
    realApi: null, billable: false,
    experience: {
      output: 'text', submit: '生成拟人造句',
      fields: [
        { key: 'text', label: '原始内容', type: 'textarea', default: '本产品支持七天无理由退货。', hint: '真实模式用服务端配置的大模型按所选场景改写；演示环境返回口语化改写示例' },
        { key: 'scene', label: '表达场景', type: 'select', default: '客服口语', options: [['客服口语', '客服口语'], ['直播话术', '直播话术'], ['课程讲解', '课程讲解']] },
      ],
      notes: '平台没有 NLP10 接口；真实模式用服务端配置的大模型按所选场景改写，演示环境返回口语化改写示例。',
      mockTitle: '拟人化表达',
      mockText: '亲，这款产品支持七天无理由退货哦～收到货后如果不满意，随时都可以申请，放心下单就好啦！',
    },
  },

  // ---------- 人物形象 ----------
  {
    id: 'avatar-train', group: 'avatar', name: '形象复刻', status: 'ready',
    desc: '按采集标准拍摄视频，训练专属数字人形象', scene: '企业 IP / 教师数字分身',
    api: 'POST /api/2dvh/v1/material/2davatar/model/multi/create', doc: '形象复刻',
    realApi: '/api/2dvh/v1/material/2davatar/model/multi/create', billable: true,
    experience: {
      output: 'json', submit: '提交形象训练',
      requires: [
        { text: '采集视频：时长 ≥6 分钟', note: '真实模式：提交后为异步训练，完成后得到 face_feature_id；绿幕/纯色背景、1080×1920 竖屏、无背景噪音；点右侧「上传」可直接传本站视频' },
        { text: '1 个人物形象模型额度', note: '真实模式：训练消耗 1 个人物形象模型额度，剩余额度见工作台「我的额度」' },
      ],
      fields: [
        { key: 'videoUrl', label: '采集视频 URL', type: 'text', default: '', placeholder: 'https://…/avatar-source.mp4', upload: 'video', hint: '绿幕/纯色背景、1080×1920 竖屏、无背景噪音，时长须 ≥6 分钟；点右侧「上传」可直接传本站视频（≤100MB）；演示环境返回示例 face_feature_id' },
        { key: 'avatarName', label: '形象名称', type: 'text', default: '张老师数字分身' },
        { key: 'avatarType', label: '训练类型', type: 'select', default: '0', options: [['0', '普通数字人'], ['1', '动静数字人'], ['2', '动作编辑数字人'], ['3', '快速数字人'], ['4', '超级直播间'], ['5', '超级直播间 Pro']] },
        { key: 'segmentStyle', label: '背景分割方式', type: 'select', default: '1', options: [['1', '绿幕分割'], ['0', '不分割'], ['2', '普通分割'], ['3', '绿幕分割后处理']] },
        { key: 'videoCrfQuality', label: '视频质量 CRF（0-51，越小越清晰）', type: 'number', default: '23', hint: '建议 14-28' },
      ],
      notes: '真实模式为异步训练，完成后得到 face_feature_id；训练消耗 1 个人物形象模型额度。',
      mockTitle: '形象训练结果',
      mockJson: { faceFeatureId: 'ffd_demo_2c91ab', avatarName: '张老师数字分身', avatarType: 0, status: '训练完成', stage: 'Stage2 完成', resolution: '1080x1920' },
    },
  },
  {
    id: 'avatar-green', group: 'avatar', name: '绿幕效果预览', status: 'ready',
    desc: '图片/视频绿幕分割参数调试与效果预览', scene: '形象训练前质检',
    api: 'green_params_* 参数', doc: '人物形象模型生成',
    realApi: null, billable: false,
    experience: {
      output: 'image', submit: '生成预览图',
      requires: [
        { text: '绿幕图片或视频地址', note: '真实模式：调平台绿幕分割预览接口，返回处理后的图片地址；点右侧「上传」可直接传本站文件；视频须 ≥6 分钟' },
      ],
      fields: [
        { key: 'sourceUrl', label: '图片/视频 URL', type: 'text', default: '', placeholder: 'https://…/green-screen.png', upload: 'media', hint: '图片走图片预览接口，视频（mp4/mov）走视频预览接口，视频时长须 ≥6 分钟；点右侧「上传」可直接传本站文件；同一组参数也用于形象训练（训练内为驼峰命名）' },
        { key: 'materialName', label: '任务名称', type: 'text', default: '绿幕预览' },
        { key: 'threshold', label: '高阈值（0-255，视频 70-220）', type: 'number', default: '160' },
        { key: 'blur', label: '边缘模糊核（1-24）', type: 'number', default: '3' },
        { key: 'colorbalance', label: '去绿程度（0-100）', type: 'number', default: '100' },
        { key: 'spill', label: '去绿色彩平衡（-1.0~1.0）', type: 'number', default: '0.5' },
      ],
      notes: '真实模式调平台绿幕分割预览接口，返回处理后的图片地址；同一组参数也用于形象训练（训练内为驼峰命名）。',
      mockTitle: '绿幕抠像预览',
    },
  },
  {
    id: 'avatar-update', group: 'avatar', name: '人物模型更新', status: 'ready',
    desc: '对已有形象模型做增量更新与重新训练', scene: '形象迭代',
    api: '人物形象模型更新任务', doc: '人物形象模型生成',
    realApi: null, billable: true,
    experience: {
      output: 'json', submit: '提交模型更新',
      requires: [
        { text: '已有形象的模型文件地址', cap: 'avatar-train', note: '真实模式：提交重建任务，用原模型文件地址更新；先去形象复刻训一个形象，拿到模型文件地址' },
        { text: '新素材视频', note: '真实模式：用这段新素材视频更新动作片段；点右侧「上传」可直接传本站视频' },
      ],
      fields: [
        { key: 'materialName', label: '模型名称', type: 'text', default: '张老师数字分身' },
        { key: 'videoUrl', label: '新素材视频 URL', type: 'text', default: '', placeholder: 'https://…/new-clip.mp4', upload: 'video', hint: '用于更新动作片段的视频；点右侧「上传」可直接传本站视频' },
        { key: 'modelUrl', label: '原模型文件地址', type: 'text', default: '', placeholder: 'https://…/model.zip', hint: '已生成的原模型文件下载地址，在平台控制台的形象详情里复制' },
        { key: 'avatarType', label: '形象类型', type: 'select', default: '0', options: [['0', '普通数字人'], ['1', '动静数字人'], ['2', '动作编辑数字人'], ['4', '超级直播间'], ['5', '超级直播间 Pro']] },
        { key: 'segmentStyle', label: '背景分割方式', type: 'select', default: '1', options: [['1', '绿幕分割'], ['0', '不分割'], ['2', '普通分割'], ['3', '绿幕分割后处理'], ['4', '自定义 Mask 分割']], hint: '建议与原训练保持一致，否则效果可能异常' },
        { key: 'dynamicRangeStart', label: '动态素材开始时间（秒）', type: 'number', default: '1' },
        { key: 'dynamicRangeEnd', label: '动态素材结束时间（秒）', type: 'number', default: '210', hint: '默认取说话第一秒到 3 分半' },
      ],
      notes: '真实模式提交重建任务；背景分割方式建议与原训练保持一致，否则效果可能异常。',
      mockTitle: '模型更新回执',
      mockJson: { taskId: 7003001, modelId: 'ffd_demo_2c91ab', status: '更新排队中', keepGreenParams: true, message: '任务已提交，完成后模型 ID 保持不变' },
    },
  },

  // ---------- 图片能力 ----------
  {
    id: 'image-edit', group: 'image', name: 'AI 图片编辑', status: 'ready',
    desc: '多图理解 + 提示词编辑，输出带「AI生成」标识的新图', scene: '营销素材 / 教学插图',
    api: 'POST /api/2dvh/v1/material/single/image/edit', doc: '图片编辑',
    realApi: '/api/2dvh/v1/material/single/image/edit', billable: true,
    experience: {
      output: 'image', submit: '确定', dialogTitle: '图片编辑信息',
      requires: [
        { text: '1–3 张素材图片', note: '真实模式：提交后为异步任务，完成后返回新图片地址；点上传框可直接传本站图片' },
        { text: 'AI 图片编辑额度已开通', note: '真实模式：未开通时提交会报明确的错，剩余额度见「我的额度」' },
      ],
      fields: [
        { key: 'imageName', label: '任务名', type: 'text', default: 'AI 编辑图片', maxLength: 20, required: true, placeholder: '请输入任务名' },
        { key: 'images', label: '上传图片', type: 'images', required: true, upload: 'image', accept: 'image/png,image/jpeg,image/webp', maxItems: 3, placeholder: 'https://…/photo1.jpg', hint: '支持 JPG、PNG、WEBP 格式，最多 3 张图片；单张分辨率不超过 2K、文件不超过 10MB；也可以在下方地址框粘贴图片地址，每行一个' },
        { key: 'prompt', label: '文本提示词', type: 'textarea', required: true, placeholder: '请描述生成或编辑图片的内容', default: '把图一和图二的人物并排放在校园背景中，风格明快' },
        { key: 'watermark', label: '图片水印', type: 'toggle', default: '开启', hint: '对外发布必须保留「AI生成」标识' },
      ],
      notes: '真实模式为异步任务，完成后返回新图片地址；对外发布必须保留「AI生成」标识。图片分辨率跟随原图：接口参数表里没有分辨率这一项，如影控制台的分辨率步进器没有对应的接口参数，本站不做假控件。',
      mockTitle: 'AI 编辑图片',
    },
  },

  // ---------- 知识与对话 ----------
  {
    id: 'nlp-kb', group: 'nlp', name: '知识库管理', status: 'ready',
    desc: '上传私有资料构建知识库，供问答与互动调用', scene: '企业知识助手 / 课程答疑',
    api: '知识库管理', doc: '用户接入',
    realApi: null, billable: false,
    experience: {
      output: 'json', submit: '创建知识库',
      requires: [
        { text: '资料文档（txt/md）', note: '真实模式：把资料文档下载后存进服务端自建知识库，供问答调用；点表单右侧「上传」可直接传本站文档，也可以直接去工作台「知识库管理」上传文件，不用填地址' },
      ],
      fields: [
        { key: 'name', label: '知识库名称', type: 'text', default: '人工智能通识' },
        { key: 'docUrl', label: '资料文档 URL', type: 'text', default: 'https://cdn.example.com/course.pdf', upload: 'doc', hint: '仅支持 txt/md；点右侧「上传」可直接传本站文档，或填可公网访问的文档地址' },
        { key: 'desc', label: '知识库说明', type: 'textarea', default: '面向学生的课程答疑资料' },
      ],
      notes: '平台没有知识库接口；真实模式把资料地址的文档（txt/md）下载后存进服务端自建知识库，供问答调用。',
      mockTitle: '知识库创建结果',
      mockJson: { kbId: 'kb_demo_9a72', name: '人工智能通识', docCount: 1, status: '解析完成', createdAt: '2026-11-11', usable: true },
    },
  },
  {
    id: 'nlp-chat', group: 'nlp', name: '流式问答助手', tag: '可体验', status: 'ready',
    desc: 'SSE 流式返回，可随时中断，边生成边显示', scene: '智能客服 / 学习助手',
    api: 'SSE /api/chat', doc: '互动直播',
    realApi: null, billable: false,
    experience: {
      output: 'chat', submit: '发送问题',
      requires: [
        { text: '知识库里已有资料', cap: 'nlp-kb', note: '真实模式：走服务端自建检索（知识库里的资料）加大模型回答，库里没有就直说没有；先去知识库管理传资料，否则只能回答没有' },
      ],
      fields: [
        { key: 'text', label: '你的问题', type: 'textarea', default: '这个平台能做什么？', hint: '回答会逐字出现，可随时点「停止」' },
      ],
      notes: '平台没有问答接口；真实模式走服务端自建检索（知识库里的资料）加大模型回答，库里没有就直说没有。',
      mockTitle: '问答结果',
    },
  },

  // ---------- 互动与直播 ----------
  {
    id: 'live-script', group: 'live', name: '互动直播脚本', status: 'ready',
    desc: '管理互动直播脚本与分享链接', scene: '直播运营',
    api: '互动直播脚本管理', doc: '互动直播',
    realApi: null, billable: false,
    experience: {
      output: 'json', submit: '创建直播间',
      requires: [
        { text: '已训练并预热的数字人形象', cap: 'avatar-train', config: 'liveAvatarConfigured', note: '真实模式：用这份脚本创建直播间，返回会话编号与拉流地址；先训形象；预热与形象配置由管理员在服务端完成' },
        { text: '创建即开始计时', note: '真实模式：创建即开始计时，未开播前不会推流；只建不开播；开播前确认脚本已备好' },
      ],
      fields: [
        { key: 'name', label: '脚本名称', type: 'text', default: '双十一专场脚本' },
        { key: 'scene', label: '脚本场景', type: 'select', default: '带货', options: [['带货', '带货'], ['问答', '问答'], ['讲解', '课程讲解']] },
        { key: 'script', label: '直播脚本文案', type: 'textarea', default: '欢迎来到直播间，今天为大家带来三款好物。' },
      ],
      notes: '真实模式用这份脚本创建直播间，返回会话编号与拉流地址；创建即开始计时，需已训练并预热的数字人形象，未开播前不会推流。',
      mockTitle: '互动直播脚本',
      mockJson: { scriptId: 31, name: '双十一专场脚本', shareUrl: 'https://aigc.softsugar.com/#/share/demo-script', linkExpireDays: 7, status: '已创建' },
    },
  },
  {
    id: 'live-pro', group: 'live', name: '超级直播间 Pro', status: 'ready',
    desc: '五阶段接入：训练 → 预热 → 脚本 → 开播 → 接管', scene: '7×24 直播',
    api: '超级直播间 Pro 接口清单', doc: '超级直播间 Pro',
    realApi: null, billable: true,
    experience: {
      output: 'json', submit: '创建直播间（演示）',
      requires: [
        { text: '已训练并预热的数字人形象', cap: 'avatar-train', config: 'liveAvatarConfigured', note: '真实模式：创建超级直播间 Pro 会话（avatarType 5），返回会话编号与拉流地址；先训形象；预热与形象配置由管理员在服务端完成' },
        { text: '创建即开始计时', note: '真实模式：创建即开始计时；只建不开播，不推流；开播后每 60 秒需心跳，关播须调接口，否则占用路数' },
      ],
      fields: [
        { key: 'name', label: '直播间名称', type: 'text', default: '品牌旗舰直播间' },
        { key: 'avatarType', label: 'avatarType', type: 'select', default: '5', options: [['5', '5（超级直播间 Pro）'], ['4', '4（超级直播间非 Pro）']], hint: 'Pro 必须为 5' },
        { key: 'script', label: '开播脚本文案', type: 'textarea', default: '欢迎来到直播间，今天为大家带来三款好物。' },
      ],
      notes: '真实模式创建超级直播间 Pro 会话（avatarType 5），返回会话编号与拉流地址；创建即开始计时，需已训练并预热的数字人形象；开播后每 60 秒需心跳，关播须调接口，否则占用路数。',
      mockTitle: '直播间创建结果',
      mockJson: { sessionId: 'sess_demo_4d21e8', name: '品牌旗舰直播间', avatarType: 5, status: '已创建·未开播', rtmpPushUrl: 'rtmp://demo.live/live', heartbeatIntervalSec: 60, billingStarted: false, tips: ['素材需先预热', '开播后每 60 秒发送心跳', '关播须调用关播接口'] },
    },
  },
  {
    id: 'live-multi', group: 'live', name: '视频互动直播', status: 'ready',
    desc: '20 个接口：素材、会话、播放列表与接管队列', scene: '多视频互动直播',
    api: '视频互动直播接口清单', doc: '视频互动直播',
    realApi: null, billable: true,
    experience: {
      output: 'json', submit: '创建装修任务',
      requires: [
        { text: '装修脚本文案', note: '真实模式分两步：先创建装修任务生成视频素材，素材完成后才能创建直播；每份脚本生成一个视频素材' },
        { text: '视频互动直播并发路数已开通', note: '真实模式：当前并发路数为 0 时建直播会被平台拒绝，剩余额度见「我的额度」' },
      ],
      fields: [
        { key: 'name', label: '会话名称', type: 'text', default: '产品发布会互动直播' },
        { key: 'script', label: '装修脚本文案', type: 'textarea', default: '您好，欢迎来到直播间。', hint: '每份装修脚本生成一个数字人视频素材，素材完成后才能用来创建直播' },
      ],
      notes: '真实模式分两步：先创建装修任务生成视频素材，素材完成后才能创建直播；直播还需推流地址与播放列表，当前并发路数为 0 时建直播会被平台拒绝。',
      mockTitle: '互动直播会话',
      mockJson: { sessionId: 'sess_demo_7b03fa', name: '产品发布会互动直播', status: '未开播', playListCount: 1, takeoverQueue: 0, conflictStrategy: '强制切换', apiCount: 20 },
    },
  },
];

export const GUIDED_PATH = [
  { cap: 'video-tts', title: '先跑通一次', why: '只填文案就能出视频，零前置；先确认真实环境是通的。' },
  { cap: 'voice-tts', title: '拿到一段音频', why: '合成的音频可以下载，后面做图片数字人直接用。' },
  { cap: 'video-image', title: '照片 + 音频出片', why: '上传一张人像照片，配上刚合成的音频，生成会说话的数字人。' },
  { cap: 'avatar-train', title: '训自己的形象', why: '按采集标准拍一段 6 分钟视频，得到 face_feature_id，解锁视频脚本与直播。' },
  { cap: 'video-script', title: '用形象出成片', why: '把训好的形象填进脚本，提交生成精品视频；有形象后也能开直播。' },
];

export const SCENARIOS = [
  { icon: '🛍️', name: '零售电商', desc: '商品口播视频、营销图、智能客服，分钟级批量出内容', caps: ['video-tts', 'image-edit', 'nlp-chat'] },
  { icon: '🎓', name: '教育培训', desc: '教师数字分身、课程开场、AI 答疑与知识库', caps: ['avatar-train', 'video-tts', 'nlp-kb'] },
  { icon: '🏛️', name: '政务与企业服务', desc: '政策播报、办事引导数字人、热线问答', caps: ['video-tts', 'voice-clone', 'nlp-chat'] },
  { icon: '📺', name: '传媒与内容', desc: '短视频脚本、配音、数字人主播与直播', caps: ['video-script', 'voice-tts', 'live-pro'] },
];

export const INTEGRATION_STEPS = [
  { n: '01', title: '注册与获取凭据', desc: '在如影 PaaS 控制台创建应用，取得 APP_ID / APP_KEY，凭据只保存在服务端。' },
  { n: '02', title: '换取 Token', desc: '服务端用 MD5(appId + timestamp + appKey) 签名换取 Token，自动缓存与提前刷新。' },
  { n: '03', title: '调用能力接口', desc: '按能力目录选择接口，提交异步任务并轮询状态；计费路径有白名单保护。' },
  { n: '04', title: '取回成果并发布', desc: '下载成片/音频，按规定添加「AI生成」显式标识后对外发布。' },
];

export const groupOf = (id) => GROUPS.find((g) => g.id === id);
export const capsOf = (gid) => CAPABILITIES.filter((c) => c.group === gid);
export const readyCaps = () => CAPABILITIES.filter((c) => c.status === 'ready');
export const capById = (id) => CAPABILITIES.find((c) => c.id === id);
export const OUTPUT_LABEL = { video: '视频', audio: '音频', image: '图片', json: 'JSON 数据', text: '文本', chat: '流式对话' };

export function stats() {
  return {
    groups: GROUPS.length,
    capabilities: CAPABILITIES.length,
    ready: readyCaps().length,
    scenarios: SCENARIOS.length,
    steps: INTEGRATION_STEPS.length,
  };
}
