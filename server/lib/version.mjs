// version.mjs —— 版本号唯一来源：package.json
// 服务端在启动时读取；前端由 vite.config.js 在构建时注入同一个值（__APP_VERSION__）。
import fs from 'node:fs';
import path from 'node:path';

const PKG = path.resolve(import.meta.dirname, '..', '..', 'package.json');
export const VERSION = JSON.parse(fs.readFileSync(PKG, 'utf8')).version;
