#!/usr/bin/env node
// check-leaks.mjs —— 密钥/隐私泄露扫描（跨平台，只用 Node 内置模块）
// 运行：npm run check:leaks
// 原则：脚本本身也不能把明文打印到终端——所有命中值统一打码为 前4位****后4位
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'reports'); // 不放 public/，避免被打包进 dist
const REPORT_FILE = path.join(PUBLIC_DIR, 'leak-report.json');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'reports', 'data']);
const SKIP_FILES = new Set(['package-lock.json', 'env-report.json', 'leak-report.json', '.DS_Store']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.html', '.css', '.json', '.md', '.txt', '.example', '.yml', '.yaml', '.env.example']);
// 不扫描 .env 本身（本地密钥文件），它由 check-env 的"是否被 git 忽略"负责
const SKIP_NAMES = new Set(['.env', '.env.local']);

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

const mask = (v) => {
  const s = String(v);
  if (s.includes('****')) return s;
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
};

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name) || SKIP_NAMES.has(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXT.has(ext) && !entry.name.startsWith('.env')) continue;
      yield path.join(dir, entry.name);
    }
  }
}

function scanFile(file) {
  const rel = path.relative(ROOT, file);
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const findings = [];
  lines.forEach((line, idx) => {
    if (!line.trim()) return;
    if (ALLOW.some((re) => re.test(line))) return;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const value = m[1] || m[0];
        // 纯占位符（空值/全下划线/纯变量名）跳过
        if (!/[A-Za-z0-9]/.test(value) || [/^_+$/, /^your/i, /^xxxx/i, /^'?\+?\d{0,3}'?$/].some((re) => re.test(value))) continue;
        findings.push({ rule: rule.id, ruleName: rule.name, level: rule.level, file: rel, line: idx + 1, sample: mask(value) });
      }
    }
  });
  return findings;
}

const findings = [];
for (const file of walk(ROOT)) findings.push(...scanFile(file));

const report = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  scanned: '项目源码/文档/配置（不含 node_modules、dist、.env 本体）',
  total: findings.length,
  high: findings.filter((f) => f.level === 'high').length,
  findings,
};
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log('\n如影 AI 能力开放平台 · 泄露扫描');
console.log('='.repeat(64));
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
