// 泄露扫描工具 scripts/check-leaks.mjs 的测试：埋入的假密钥都能查出，且报告里也已打码；干净目录 0 处；本项目自身 0 处。
// 假数据在运行时拼出来，避免测试文件本身被扫描器当成泄露。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan, scanText, mask } from '../scripts/check-leaks.mjs';

const fakeKey = ['9f2c', '41aa', '7d0e', '4b6c', '8a31', '55e0', 'c2d9', '1b77'].join('');
const fakeTok = 'ZjVk' + 'MTIzNDU2Nzg5MGFiY2RlZg'.repeat(2) + 'YWFk';
const fakeMail = ['zhang.san', 'corp-mail.cn'].join('@');
const fakePhone = '139' + '1234' + '5678';

test('埋入 5 类泄露都能查出，命中值打码为“前4****后4”', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'leak-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'a.js'), `const appKey = '${fakeKey}';\nheaders.Authorization = 'Bearer ${fakeTok}';\n`);
  writeFileSync(join(dir, 'b.md'), `联系人 ${fakeMail}，电话 ${fakePhone}\n{"accessToken":"${fakeTok}"}\n`);
  const { findings } = scan(dir, { secrets: [], base: dir });
  assert.deepEqual([...new Set(findings.map((f) => f.rule))].sort(), ['bearer', 'email', 'phone', 'secret-assign', 'token-json']);
  const report = JSON.stringify(findings);
  for (const raw of [fakeKey, fakeTok, fakeMail, fakePhone]) assert.ok(!report.includes(raw), '报告里不能出现明文');
  assert.equal(mask(fakeKey), `${fakeKey.slice(0, 4)}****${fakeKey.slice(-4)}`);
});

test('.env 里的真实密钥原文出现在任何文件都算高风险', () => {
  const f = scanText(`日志：appId=${fakeKey.slice(0, 20)} 已经打印`, 'x.log', [{ key: 'RUYING_APP_ID', value: fakeKey.slice(0, 20) }]);
  assert.equal(f[0].rule, 'env-secret');
  assert.ok(!f[0].sample.includes(fakeKey.slice(0, 20)));
});

test('已打码、官方示例值、process.env 引用不算泄露', () => {
  const ok = [
    'Authorization: Bearer ZjVk****YWFk',
    "appKey: '89f81a207e5e4a1297ed1255879191ee'   // 官方 FAQ 示例",
    'const appKey = process.env.RUYING_APP_KEY;',
    'demo@example.com',
  ].join('\n');
  assert.equal(scanText(ok, 'ok.js').length, 0);
});

test('本项目自身扫描 0 处（交付前门禁）', () => {
  const { files, findings } = scan();
  assert.ok(files > 30);
  assert.deepEqual(findings, []);
});
