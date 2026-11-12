// mock.mjs —— 演示环境：本地模拟平台（零费用、无需密钥）
// 所有返回都带 mode:'mock'，前端据此明确标注「演示结果」。素材地址为相对路径，支持子路径部署。
import path from 'node:path';
import { capById } from '../src/lib/capabilities.js';
import { E } from './lib/errors.mjs';
import { TASK_STATUS_TEXT } from './lib/ruying.mjs';

const ASSETS = path.resolve(import.meta.dirname, 'mock', 'assets');
const FILE = (name) => `files/${name}`;

export function createMock({ taskMs = 1400 } = {}) {
  const tasks = new Map();
  let seq = 12000;
  const words = (text) => [...String(text).replace(/\s/g, '')].length;

  function resultFor(cap, params) {
    const ex = cap.experience || {};
    const base = { capabilityId: cap.id, capabilityName: cap.name, output: ex.output, title: ex.mockTitle || cap.name, mode: 'mock' };
    switch (ex.output) {
      case 'video': return { ...base, videoUrl: FILE('mock_image_avatar.mp4'), thumbUrl: FILE('mock_thumb.png'), duration: 5.8, watermark: 'AI生成' };
      case 'audio': return { ...base, audioUrl: FILE('mock_tts.mp3'), durationMs: Math.max(1200, Math.round((words(params.text || '') / 3.8) * 1000)) };
      case 'image': return { ...base, imageUrl: FILE('mock_portrait.png') };
      case 'json': {
        const j = { ...(ex.mockJson || {}) };
        for (const f of ex.fields || []) {
          if (['text', 'textarea'].includes(f.type) && params[f.key] && !j[f.key]) j[f.key] = String(params[f.key]).slice(0, 60);
        }
        return { ...base, json: j, jsonText: JSON.stringify(j, null, 2) };
      }
      case 'text': return { ...base, text: ex.mockText || '（演示结果）' };
      default: return { ...base, text: '演示结果：真实环境下由平台返回。' };
    }
  }

  // 任务状态机与平台一致：1 未开始 → 2 生成中 → 5 完成
  function view(t) {
    const elapsed = Date.now() - t.at;
    const status = elapsed >= taskMs ? 5 : elapsed >= taskMs / 2 ? 2 : 1;
    return { id: String(t.id), status, statusText: TASK_STATUS_TEXT[status], result: status === 5 ? t.result : null, failReason: '' };
  }

  return {
    assets: ASSETS,

    tts(text) {
      return { audio_url: FILE('mock_tts.mp3'), duration_ms: Math.max(1200, Math.round((words(text) / 3.8) * 1000)), mode: 'mock' };
    },

    createAvatarTask() {
      const id = ++seq;
      tasks.set(id, { id, at: Date.now(), result: { videoUrl: FILE('mock_image_avatar.mp4'), thumbUrl: FILE('mock_thumb.png'), duration: 5.8, watermark: 'AI生成', mode: 'mock' } });
      return String(id);
    },

    task(id) { const t = tasks.get(Number(id)); return t ? view(t) : null; },

    /** 通用能力：同步类（json/text）直接返回；异步类（video/audio/image）返回任务编号 */
    runCapability(capId, params = {}) {
      const cap = capById(capId);
      if (!cap) throw E.notFound(`未知能力：${capId}`);
      const ex = cap.experience || {};
      const t = params.text;
      if (t !== undefined && String(t).trim() && !String(t).startsWith('http') && words(t) < 4) {
        throw E.validation('文案至少 4 个字，请再写一点。');
      }
      if (['json', 'text', 'chat'].includes(ex.output)) return { sync: true, result: resultFor(cap, params) };
      const id = ++seq;
      tasks.set(id, { id, at: Date.now(), result: resultFor(cap, params) });
      return { sync: false, taskId: String(id), output: ex.output };
    },
  };
}
