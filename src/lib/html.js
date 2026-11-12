// html.js —— 模板工具
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const words = (t) => [...String(t || '').replace(/\s/g, '')].length;
