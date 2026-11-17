#!/usr/bin/env node
// check-leaks.mjs —— 密钥/隐私泄露扫描（跨平台，只用 Node 内置模块）
// 运行：npm run check:leaks                 扫描本项目（源码、文档、配置；不含 node_modules、dist、data、.env 本体）
//      npm run check:leaks -- <目录或文件>   扫描指定位置，例如要提交的作业目录、截图旁的文字说明
// 规则：① .env 里真实的 APP_ID / APP_KEY / CALLBACK_AUTH_KEY 原文出现在任何文件 → 高风险；
//      ② 疑似密钥赋值、Bearer 令牌、JSON 里的 accessToken/refreshToken、邮箱、11 位手机号 → 高风险；
//      已打码（含 ****）、官方公开示例值、课程演示值、process.env 引用不算。
// 脚本本身也不能把明文打印到终端——所有命中值统一打码为 前4位****后4位
import fs from 'node:fs';
import path from 'node:path';
import { loadDotEnv } from '../server/lib/config.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'reports'); // 不放 public/，避免被打包进 dist
const REPORT_FILE = path.join(PUBLIC_DIR, 'leak-report.json');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'reports', 'data']);
const SKIP_FILES = new Set(['package-lock.json', 'env-report.json', 'leak-report.json', '.DS_Store']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.html', '.css', '.json', '.md', '.txt', '.example', '.yml', '.yaml', '.env.example']);
// 不扫描 .env 本身（本地密钥文件），它由 check-env 的"是否被 git 忽略"负责
const SKIP_NAMES = new Set(['.env', '.env.local']);

// 官方文档公开的示例值、课程 mock/演示值：出现不算泄露
export const KNOWN_PUBLIC = new Set([
  'c103af9ac77646ca9fb0122e75f30811', '89f81a207e5e4a1297ed1255879191ee', 'f6ffecf33d2073d9b3b93ba157665cfc',   // FAQ 签名示例
  'abc123', 'abcde1231693206851', '863151b586912152aacee3124f81e301',                                             // 回调鉴权示例
  'mock-app-id-0001', 'mock-app-key-0001', 'mock-user-pwd-hash-0001', 'MockAuthKey2026Demo', 'demo@example.com', '13800000000',
]);

const RULES = [
  { id: 'secret-assign', level: 'high', name: '疑似密钥赋值',
    re: /(?:app[_-]?key|auth[_-]?key|secret|userPwd|password)\s*[:=]\s*["']?([A-Za-z0-9+/_=-]{12,})/gi },
  { id: 'email', level: 'high', name: '邮箱地址', re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g },
  { id: 'phone', level: 'high', name: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { id: 'bearer', level: 'high', name: 'Bearer 令牌', re: /Bearer\s+([A-Za-z0-9\-._~+/]{20,})/gi },
  { id: 'token-json', level: 'high', name: '响应中的令牌', re: /"(?:accessToken|refreshToken)"\s*:\s*"([A-Za-z0-9\-._~+/]{20,})"/g },
];
// 允许行：注释/示例/占位符/环境变量引用/已打码
const ALLOW = [
  /示例|例如|比如|placeholder|your[_-]?key|xxxx|\*\*\*\*|前4位|脱敏|process\.env/i,
  /<[^>]+>|\$\{|\{\{/, // 模板占位
  /TODO|待核实|课程约定/,
  /\.invalid\b/i, // RFC 2606 保留域名：课程演示邮箱，无法收信
];

export const mask = (v) => {
  const s = String(v);
  if (s.includes('****')) return s;
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
};

/** 读取真实密钥原文（.env 与环境变量），只用于比对，不输出 */
export function loadSecrets(root = ROOT, env = process.env) {
  const dot = loadDotEnv(path.join(root, '.env'));
  return ['RUYING_APP_ID', 'RUYING_APP_KEY', 'CALLBACK_AUTH_KEY', 'CALLBACK_AUTH_KEY_OLD']
    .map((k) => ({ key: k, value: env[k] || dot[k] || '' }))
    .filter((s) => s.value.length >= 6 && !KNOWN_PUBLIC.has(s.value));
}

function* walk(p) {
  const st = fs.statSync(p);
  if (st.isFile()) { yield p; return; }
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(p, entry.name));
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name) || SKIP_NAMES.has(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXT.has(ext) && !entry.name.startsWith('.env')) continue;
      yield path.join(p, entry.name);
    }
  }
}

/** 扫描一段文本：先比对 .env 真实密钥原文（即使是允许行也算），再走 5 条正则规则 */
export function scanText(text, file, secrets = []) {
  const findings = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, idx) => {
    for (const s of secrets) {
      if (line.includes(s.value)) findings.push({ rule: 'env-secret', ruleName: `.env 中 ${s.key} 的原文`, level: 'high', file, line: idx + 1, sample: mask(s.value) });
    }
    if (!line.trim()) return;
    if (ALLOW.some((re) => re.test(line))) return;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const value = m[1] || m[0];
        // 纯占位符（空值/全下划线/纯变量名）跳过；官方公开示例值与 mock/test/demo 前缀不算
        if (!/[A-Za-z0-9]/.test(value) || [/^_+$/, /^your/i, /^xxxx/i, /^'?\+?\d{0,3}'?$/].some((re) => re.test(value))) continue;
        if (KNOWN_PUBLIC.has(value) || /^(mock|test|demo)/i.test(value)) continue;
        findings.push({ rule: rule.id, ruleName: rule.name, level: rule.level, file, line: idx + 1, sample: mask(value) });
      }
    }
  });
  return findings;
}

/** 扫描一个目录或文件，返回 { files, findings }；file 字段为相对 base 的路径 */
export function scan(target = ROOT, { secrets = loadSecrets(), base = ROOT } = {}) {
  const findings = [];
  let files = 0;
  for (const file of walk(target)) {
    files += 1;
    const rel = path.relative(base, file) || path.basename(file);
    findings.push(...scanText(fs.readFileSync(file, 'utf8'), rel, secrets));
  }
  return { files, findings };
}

if (path.resolve(process.argv[1] || '') === path.resolve(import.meta.dirname, 'check-leaks.mjs')) {
  const target = path.resolve(process.argv[2] || ROOT);
  if (!fs.existsSync(target)) { console.error(`路径不存在：${target}`); process.exit(2); }
  const secrets = loadSecrets();
  const { files, findings } = scan(target, { secrets, base: fs.statSync(target).isDirectory() ? target : path.dirname(target) });

  const report = {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    target: path.relative(ROOT, target) || '.',
    files,
    scanned: '项目源码/文档/配置（不含 node_modules、dist、.env 本体）',
    total: findings.length,
    high: findings.filter((f) => f.level === 'high').length,
    findings,
  };
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('\n如影 AI 能力开放平台 · 泄露扫描');
  console.log('='.repeat(64));
  console.log(`扫描：${path.relative(ROOT, target) || '本项目'}，${files} 个文本文件；真实密钥比对 ${secrets.length} 项（来自 .env / 环境变量，未填则跳过）`);
  if (!findings.length) {
    console.log('✔ 未发现密钥 / 邮箱 / 手机号 / 令牌明文');
    console.log('解读：扫描通过说明当前项目里没有"可直接拿去用"的敏感信息；它不能代替 .gitignore 与提交前人工复核。');
  } else {
    for (const f of findings) {
      console.log(`${f.level === 'high' ? '✘' : '!'} ${f.file}:${f.line}  [${f.ruleName}]  ${f.sample}`);
    }
    console.log('='.repeat(64));
    console.log(`共 ${findings.length} 处（高风险 ${report.high} 处）。`);
    console.log('解读：高风险项必须清零再提交/截图；先删明文，再检查 .gitignore 是否已忽略 .env。');
  }
  console.log(`报告已写入：${path.relative(ROOT, REPORT_FILE)}`);
  console.log('解读：扫描范围是源码/文档/配置；真实密钥只在服务端 .env，浏览器与截图不应出现。\n');
  process.exitCode = report.high > 0 ? 1 : 0;
}
