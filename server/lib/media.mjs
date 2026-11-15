// media.mjs —— 站内素材上传：登录用户把图片 / 音频 / 视频传到本站，
// 得到一个可公开访问的地址，直接填进能力表单的 URL 字段（平台要求素材地址可公网访问）。
// 安全要点：只认白名单扩展名、按类型限大小、随机文件名（不暴露原名、不拼路径）、
// 图片验文件头、总容量上限、30 天自动清理。校验失败抛 AppError，由调用方按统一口径返回。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError, E } from './errors.mjs';

export const MEDIA_RETENTION_MS = 30 * 24 * 3600 * 1000; // 素材保留 30 天
export const MEDIA_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 本站素材总容量上限 2GB

export const MEDIA_KINDS = {
  image: { label: '图片', exts: ['.png', '.jpg', '.jpeg', '.webp', '.gif'], maxBytes: 10 * 1024 * 1024, accept: 'image/png,image/jpeg,image/webp,image/gif' },
  audio: { label: '音频', exts: ['.mp3', '.wav', '.m4a', '.aac'], maxBytes: 20 * 1024 * 1024, accept: 'audio/mpeg,audio/wav,audio/mp4,audio/aac,.mp3,.wav,.m4a,.aac' },
  video: { label: '视频', exts: ['.mp4', '.mov'], maxBytes: 100 * 1024 * 1024, accept: 'video/mp4,video/quicktime,.mp4,.mov' },
  // 绿幕预览：图片或视频都行
  media: { label: '图片或视频', exts: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.mov'], maxBytes: 100 * 1024 * 1024, accept: 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,.mp4,.mov' },
  // 知识库资料：txt/md 文档（与知识库管理的文件上限一致，2MB；纯文本不验文件头）
  doc: { label: '文档', exts: ['.txt', '.md'], maxBytes: 2 * 1024 * 1024, accept: 'text/plain,text/markdown,.txt,.md' },
};

export const mediaDir = (kbDir) => path.join(kbDir, 'media');
export const mediaUrl = (name) => `media/${name}`; // 相对路径，前端按当前页面地址拼成绝对地址（支持子路径部署）

export function mediaSpec(kind) {
  const spec = MEDIA_KINDS[kind];
  if (!spec) throw E.validation(`不支持的素材类型：${kind || '（空）'}。`, '请选择图片、音频或视频上传。');
  return spec;
}

/** 图片文件头校验：扩展名与内容对不上时拒绝（改错扩展名、传错文件能立刻发现） */
function checkImageMagic(ext, buf) {
  if (ext === '.webp') return buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
  const magic = { '.png': [0x89, 0x50, 0x4e, 0x47], '.jpg': [0xff, 0xd8, 0xff], '.jpeg': [0xff, 0xd8, 0xff], '.gif': [0x47, 0x49, 0x46, 0x38] }[ext];
  if (!magic) return true; // 音频 / 视频容器格式多，只验扩展名
  return magic.every((b, i) => buf[i] === b);
}

export function totalBytes(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, f)).size; } catch { /* ignore */ }
    }
  } catch { /* 目录不存在即为 0 */ }
  return total;
}

/** 删除超过保留期的素材；返回清理掉的文件数（启动与每次上传前各扫一次） */
export function sweepMedia(dir, now = Date.now()) {
  let removed = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && now - st.mtimeMs > MEDIA_RETENTION_MS) { fs.unlinkSync(file); removed += 1; }
    } catch { /* ignore */ }
  }
  return removed;
}

/**
 * 校验并保存一次上传；返回 { name, url, size, kind }。
 * 文件名一律随机生成，原名只进日志、不进路径，杜绝路径穿越与重名覆盖。
 */
export function storeMedia({ dir, kind, filename, buffer }) {
  const spec = mediaSpec(kind);
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (!spec.exts.includes(ext)) {
    throw E.validation(`不支持的文件类型：${ext || '（无扩展名）'}。`, `${spec.label}只支持 ${spec.exts.join('、')}。`);
  }
  if (!buffer || buffer.length === 0) throw E.validation('没有收到文件内容。', '请重新选择文件上传。');
  if (buffer.length > spec.maxBytes) {
    throw new AppError({ code: 'PAYLOAD_TOO_LARGE', message: `文件太大了：${spec.label}单个文件请控制在 ${Math.round(spec.maxBytes / 1024 / 1024)}MB 以内。`, hint: '可以压缩或裁剪后再上传。', action: 'fix' });
  }
  if (['image', 'media'].includes(kind) && ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) && !checkImageMagic(ext, buffer)) {
    throw E.validation('文件内容与扩展名对不上。', '请确认文件没有损坏、也没有改错扩展名。');
  }
  sweepMedia(dir);
  if (totalBytes(dir) + buffer.length > MEDIA_MAX_TOTAL_BYTES) {
    throw new AppError({ code: 'MEDIA_FULL', message: '本站素材空间已满（2GB）。', hint: '30 天前的文件会自动清理；也可以联系管理员手动清理。', action: 'contact' });
  }
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(dir, name), buffer);
  return { name, url: mediaUrl(name), size: buffer.length, kind };
}
