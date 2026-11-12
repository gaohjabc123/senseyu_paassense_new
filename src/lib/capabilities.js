// capabilities.js —— 如影 PaaS 能力目录【产品唯一数据源，前后端共用】
// 依据：aigc.softsugar.com 后台 8 大模块 24 功能页 + 官方产品文档 26 篇
// 前端 import 渲染表单/矩阵，服务端 import 生成结果；禁止在别处另写一份清单。
//
// 每项 experience 规格：
//   fields[]   输入控件 { key, label, type, placeholder, default, options, hint }
//   output     结果类型 video | audio | image | json | text | chat
//   submit     提交按钮文案
//   notes      体验提示（真实模式的前置条件等）
//   mockJson   json 类结果的模拟回执
//   mockText   text 类结果的模拟文本
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
      fields: [
        { key: 'text', label: '口播文案', type: 'textarea', default: '新款智能手表今天上市，支持全天心率监测与运动记录，欢迎了解。', placeholder: '输入要播报的文字…', hint: '4～200 字，字数决定视频时长' },
      ],
      notes: '演示环境用本地模拟素材；真实模式需要已训练的形象 ID 与音色 QID。',
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
      fields: [
        { key: 'imageUrl', label: '人像图片地址', type: 'text', default: '', placeholder: 'https://…/portrait.png', hint: '真实环境必填，需可公网访问；演示环境可留空' },
        { key: 'audioUrl', label: '音频地址', type: 'text', default: '', placeholder: 'https://…/voice.mp3', hint: '真实环境必填，需可公网访问；演示环境可留空' },
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
      fields: [
        { key: 'name', label: '脚本名称', type: 'text', default: '第3章-高级效果' },
        { key: 'lines', label: '台词内容', type: 'textarea', default: '大家好，欢迎来到本章课程。' },
        { key: 'subtitle', label: '字幕样式', type: 'select', default: '底部白字', options: [['底部白字', '底部白字'], ['无字幕', '无字幕'], ['顶部标题', '顶部标题']] },
      ],
      notes: '输出的是可直接传给视频合成接口的 param 结构，不单独计费。',
      mockTitle: '视频脚本 param 结构',
      mockJson: { version: '0.0.17', video_format: 'MP4', resolution: [1080, 1920], frame_rate: 25, digital_role: { face_feature_id: 'your_face_feature_id', position: { x: 0, y: 0 }, scale: 1.0 }, tts_query: { content: '大家好，欢迎来到本章课程。', ssml: false }, subtitle: { style: '底部白字' }, watermark: { show: false } },
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
      fields: [
        { key: 'text', label: '合成文本', type: 'textarea', default: '大家好，欢迎使用如影 AI 能力开放平台。', hint: '4～200 字' },
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
      fields: [
        { key: 'audioUrl', label: '训练音频 URL', type: 'text', default: 'https://cdn.example.com/voice-sample.wav', hint: '建议 10 秒以上、无底噪的清晰人声' },
        { key: 'voiceName', label: '音色名称', type: 'text', default: '品牌播报音' },
        { key: 'model', label: '训练模型', type: 'select', default: 'TTS8', options: [['TTS8', 'TTS8（推荐）'], ['TTS10', 'TTS10']] },
      ],
      notes: '真实模式为异步训练任务，完成后返回 QID；演示环境直接返回模拟 QID。',
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
        { key: 'text', label: '原始内容', type: 'textarea', default: '本产品支持七天无理由退货。' },
        { key: 'scene', label: '表达场景', type: 'select', default: '客服口语', options: [['客服口语', '客服口语'], ['直播话术', '直播话术'], ['课程讲解', '课程讲解']] },
      ],
      notes: '演示环境返回口语化改写示例；真实模式接入平台拟人大模型。',
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
      fields: [
        { key: 'videoUrl', label: '采集视频 URL', type: 'text', default: 'https://cdn.example.com/avatar-source.mp4', hint: '绿幕/纯色背景、1080×1920 竖屏、无背景噪音' },
        { key: 'avatarName', label: '形象名称', type: 'text', default: '张老师数字分身' },
        { key: 'avatarType', label: '训练类型', type: 'select', default: '2', options: [['2', '普通数字人'], ['4', '超级直播间'], ['5', '超级直播间 Pro']] },
      ],
      notes: '真实模式为异步训练，完成后得到 face_feature_id；演示环境返回模拟 ID。',
      mockTitle: '形象训练结果',
      mockJson: { faceFeatureId: 'ffd_demo_2c91ab', avatarName: '张老师数字分身', avatarType: 2, status: '训练完成', stage: 'Stage2 完成', resolution: '1080x1920' },
    },
  },
  {
    id: 'avatar-green', group: 'avatar', name: '绿幕效果预览', status: 'ready',
    desc: '图片/视频绿幕分割参数调试与效果预览', scene: '形象训练前质检',
    api: 'green_params_* 参数', doc: '人物形象模型生成',
    realApi: null, billable: false,
    experience: {
      output: 'image', submit: '生成预览图',
      fields: [
        { key: 'sourceUrl', label: '图片/视频 URL', type: 'text', default: 'https://cdn.example.com/green-screen.png' },
        { key: 'threshold', label: '分割阈值（BGR）', type: 'number', default: '230' },
        { key: 'blur', label: '边缘模糊核', type: 'number', default: '3' },
      ],
      notes: '输出带透明通道的抠像预览；真实模式返回平台处理后的图片地址。',
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
      fields: [
        { key: 'modelId', label: '原模型 ID', type: 'text', default: 'ffd_demo_2c91ab' },
        { key: 'materialUrl', label: '新素材 URL', type: 'text', default: 'https://cdn.example.com/new-clip.mp4' },
        { key: 'keepGreen', label: '保持原绿幕分割方式', type: 'select', default: '是', options: [['是', '是（推荐）'], ['否', '否']] },
      ],
      notes: '官方建议背景分割方式与原训练保持一致，避免效果异常。',
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
      output: 'image', submit: '生成图片',
      fields: [
        { key: 'images', label: '素材图片 URL（每行一个）', type: 'textarea', default: 'https://cdn.example.com/photo1.jpg\nhttps://cdn.example.com/photo2.jpg' },
        { key: 'prompt', label: '编辑提示词', type: 'textarea', default: '把图一和图二的人物并排放在校园背景中，风格明快' },
        { key: 'watermark', label: 'AI生成 标识', type: 'select', default: '开启', options: [['开启', '开启（合规要求）'], ['关闭', '关闭']] },
      ],
      notes: '对外发布必须保留「AI生成」标识；演示环境返回本地样例图。',
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
      fields: [
        { key: 'name', label: '知识库名称', type: 'text', default: '人工智能通识' },
        { key: 'docUrl', label: '资料文档 URL', type: 'text', default: 'https://cdn.example.com/course.pdf' },
        { key: 'desc', label: '知识库说明', type: 'textarea', default: '面向学生的课程答疑资料' },
      ],
      notes: '真实模式需先在平台上传文档并解析；演示环境返回模拟知识库记录。',
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
      fields: [
        { key: 'text', label: '你的问题', type: 'textarea', default: '这个平台能做什么？', hint: '回答会逐字出现，可随时点「停止」' },
      ],
      notes: '演示环境为本地 SSE 模拟回答；真实模式接入平台大模型。',
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
      output: 'json', submit: '创建脚本',
      fields: [
        { key: 'name', label: '脚本名称', type: 'text', default: '双十一专场脚本' },
        { key: 'scene', label: '脚本场景', type: 'select', default: '带货', options: [['带货', '带货'], ['问答', '问答'], ['讲解', '课程讲解']] },
      ],
      notes: '演示环境返回可复制的分享链接；真实模式需在平台创建脚本。',
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
      fields: [
        { key: 'name', label: '直播间名称', type: 'text', default: '品牌旗舰直播间' },
        { key: 'avatarType', label: 'avatarType', type: 'select', default: '5', options: [['5', '5（超级直播间 Pro）'], ['4', '4（超级直播间非 Pro）']], hint: 'Pro 必须为 5' },
        { key: 'script', label: '开播脚本文案', type: 'textarea', default: '欢迎来到直播间，今天为大家带来三款好物。' },
      ],
      notes: '真实模式：素材必须预热、创建即计费、需 60 秒心跳、关播须调接口，否则占用路数。',
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
      output: 'json', submit: '创建互动直播（演示）',
      fields: [
        { key: 'name', label: '会话名称', type: 'text', default: '产品发布会互动直播' },
        { key: 'materialId', label: '默认素材 ID', type: 'text', default: 'mat_demo_001' },
        { key: 'strategy', label: '接管冲突策略', type: 'select', default: '强制切换', options: [['强制切换', '强制切换'], ['排队', '排队执行']] },
      ],
      notes: '真实模式含 20 个接口；核心是接管队列与播放顺序管理（commandTraceId）。',
      mockTitle: '互动直播会话',
      mockJson: { sessionId: 'sess_demo_7b03fa', name: '产品发布会互动直播', status: '未开播', playListCount: 1, takeoverQueue: 0, conflictStrategy: '强制切换', apiCount: 20 },
    },
  },
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
