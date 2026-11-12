import fs from 'node:fs';
import { defineConfig } from 'vite';

// 版本号唯一来源：package.json
const { version } = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// 构建时检测 public/brand/ 下的官方 logo；没有文件就不引用，避免 404
function findLogo(name) {
  for (const ext of ['svg', 'png', 'webp']) {
    if (fs.existsSync(new URL(`./public/brand/${name}.${ext}`, import.meta.url))) return `brand/${name}.${ext}`;
  }
  return '';
}

const API = `http://127.0.0.1:${process.env.API_PORT || 8787}`;

export default defineConfig({
  base: './', // 相对路径：支持部署在子路径（如 /digital-human/）下
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BRAND_LOGOS__: JSON.stringify({ sensetime: findLogo('sensetime'), senseyu: findLogo('senseyu') }),
  },
  server: { port: 5173, strictPort: false, host: '127.0.0.1', proxy: { '/api': API, '/files': API } },
  build: { outDir: 'dist', target: 'es2020', chunkSizeWarningLimit: 200 },
});
