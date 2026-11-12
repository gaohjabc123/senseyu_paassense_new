// dev.mjs —— 本地开发：API 服务（8787）+ Vite（5173，/api 代理到 8787）
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const API_PORT = process.env.API_PORT || '8787';
const api = spawn(process.execPath, ['--watch-path=server', path.join('server', 'index.mjs')], { cwd: root, env: { ...process.env, PORT: API_PORT }, stdio: 'inherit' });
const vite = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')], { cwd: root, env: { ...process.env, API_PORT }, stdio: 'inherit' });
const stop = () => { api.kill(); vite.kill(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
