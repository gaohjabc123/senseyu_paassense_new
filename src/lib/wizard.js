// wizard.js —— 创作中心的三条快捷链路与输入校验
export const EXPERIENCES = [
  { id: 'video', name: '视频口播', desc: '文案 → 配音 → 数字人成片', icon: '🎬' },
  { id: 'voice', name: '语音合成', desc: '文字 → 语音，在线试听', icon: '🔊' },
  { id: 'chat', name: '知识库问答', desc: '上传资料 → 基于资料回答', icon: '📚' },
];
export function validateText(text, min = 4, max = 200) {
  const chars = [...String(text || '').replace(/\s/g, '')].length;
  if (chars < min) return { ok: false, message: `至少写 ${min} 个字，现在 ${chars} 个字` };
  if (chars > max) return { ok: false, message: `最多 ${max} 个字，现在 ${chars} 个字，请删减后再生成` };
  return { ok: true, message: '', chars };
}
/** 口播时长估算：约 3.8 字/秒 */
export function estimateSeconds(text) { return Math.round(([...String(text).replace(/\s/g, '')].length / 3.8) * 10) / 10; }
export function stageLabel(status, queued) {
  if (status === 5) return '已完成';
  if (status === 2) return '生成中';
  return queued ? '平台排队中' : '等待平台开始';
}
