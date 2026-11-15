// recent.js —— 上次的结果（只存本机 localStorage）：上次合成的音频、上次训好的形象、
// 上次复刻的音色 QID。表单空着时一键填入，不用重新找、重新贴。换电脑不保留。
// 纯函数 + 可注入的 storage，方便单测。

export const RECENT_KEY = 'ruying_recent_v1';

const defaultStorage = () => (typeof localStorage !== 'undefined' ? localStorage : undefined);

/** 读出最近的结果；storage 坏了或没有时返回空对象，不抛错 */
export function loadRecent(storage = defaultStorage()) {
  try {
    const raw = storage?.getItem?.(RECENT_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

/** 合并写入；返回写完后的完整对象 */
export function saveRecent(patch, storage = defaultStorage()) {
  const next = { ...loadRecent(storage), ...patch, at: Date.now() };
  try { storage?.setItem?.(RECENT_KEY, JSON.stringify(next)); } catch { /* 隐私模式等写不进时静默跳过 */ }
  return next;
}

/** 从一次能力结果里提取可记住的值（只记真实环境的结果） */
export function extractRecent(capId, result) {
  if (!result || result.mode !== 'real') return null;
  if (capId === 'voice-tts' && result.audioUrl) return { audioUrl: result.audioUrl };
  if (capId === 'avatar-train' && result.json?.faceFeatureId) {
    return { faceFeatureId: result.json.faceFeatureId, ...(result.json.modelUrl ? { modelUrl: result.json.modelUrl } : {}) };
  }
  if (capId === 'voice-clone' && result.json?.qid) return { qid: result.json.qid };
  return null;
}

/** 某个字段有没有可一键填入的上次结果；有则返回 { label, value } */
export function recentForField(key, recent = {}) {
  if (key === 'audioUrl' && recent.audioUrl) return { label: '使用上次合成的音频', value: recent.audioUrl };
  if (key === 'faceFeatureId' && recent.faceFeatureId) return { label: '使用上次训练的形象', value: recent.faceFeatureId };
  if (key === 'modelUrl' && recent.modelUrl) return { label: '使用上次训练的模型地址', value: recent.modelUrl };
  return null;
}
