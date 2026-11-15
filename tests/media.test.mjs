// media.test.mjs —— 站内素材上传接口验证：鉴权、类型/大小/内容校验、公开访问、30 天清理
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, SUPER, superClient } from './helpers.mjs';

let s;
let sup;
before(async () => {
  s = await startServer({ env: { ...SUPER } });
  sup = await superClient(s);
});
after(async () => { await s.close(); });

// 最小合法 1x1 PNG
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function rawUpload({ name, kind, body, cookie }) {
  const headers = { 'X-Requested-With': 'ruying', 'X-File-Name': encodeURIComponent(name), 'X-File-Kind': kind, 'Content-Type': 'application/octet-stream' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(`${s.base}/api/media/upload`, { method: 'POST', headers, body });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

test('未登录不能上传', async () => {
  const r = await rawUpload({ name: 'a.png', kind: 'image', body: PNG_1X1 });
  assert.equal(r.status, 401);
  assert.equal(r.code, 'UNAUTHENTICATED');
});

test('不支持的类型与扩展名直接拒绝', async () => {
  const badKind = await rawUpload({ name: 'a.png', kind: 'banana', body: PNG_1X1, cookie: sup.cookie });
  assert.equal(badKind.code, 'INVALID_INPUT');
  const badExt = await rawUpload({ name: 'a.exe', kind: 'image', body: PNG_1X1, cookie: sup.cookie });
  assert.equal(badExt.code, 'INVALID_INPUT');
  assert.match(badExt.message, /不支持的文件类型/);
});

test('图片内容与扩展名不符时拒绝（改错扩展名能立刻发现）', async () => {
  const r = await rawUpload({ name: 'fake.png', kind: 'image', body: Buffer.from('hello world, not a png'), cookie: sup.cookie });
  assert.equal(r.code, 'INVALID_INPUT');
  assert.match(r.message, /对不上/);
});

test('有效图片上传后可公开访问，路径穿越拿不到文件', async () => {
  const r = await rawUpload({ name: 'portrait.png', kind: 'image', body: PNG_1X1, cookie: sup.cookie });
  assert.equal(r.code, 0, r.message || '');
  assert.match(r.data.url, /^media\/[0-9a-f-]{36}\.png$/);
  assert.equal(r.data.size, PNG_1X1.length);
  const got = await fetch(`${s.base}/${r.data.url}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG_1X1);
  const traversal = await fetch(`${s.base}/media/../ruying.db`);
  assert.equal(traversal.status, 404);
  const missing = await fetch(`${s.base}/media/00000000-0000-0000-0000-000000000000.png`);
  assert.equal(missing.status, 404);
});

test('音频不验文件头，扩展名对就能传', async () => {
  const r = await rawUpload({ name: 'voice.mp3', kind: 'audio', body: Buffer.from('fake mp3 bytes'), cookie: sup.cookie });
  assert.equal(r.code, 0, r.message || '');
  assert.match(r.data.url, /\.mp3$/);
});

test('超过单文件上限返回 413', async () => {
  const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
  const r = await rawUpload({ name: 'big.png', kind: 'image', body: big, cookie: sup.cookie });
  assert.equal(r.status, 413);
  assert.equal(r.code, 'PAYLOAD_TOO_LARGE');
});

test('30 天前的文件在下次上传时被清理', async () => {
  const dir = path.join(s.kbDir, 'media');
  const first = await rawUpload({ name: 'old.png', kind: 'image', body: PNG_1X1, cookie: sup.cookie });
  assert.equal(first.code, 0);
  const oldPath = path.join(dir, first.data.name);
  assert.ok(fs.existsSync(oldPath));
  const ancient = Date.now() - 31 * 24 * 3600 * 1000;
  fs.utimesSync(oldPath, new Date(ancient), new Date(ancient));
  const second = await rawUpload({ name: 'new.png', kind: 'image', body: PNG_1X1, cookie: sup.cookie });
  assert.equal(second.code, 0);
  assert.equal(fs.existsSync(oldPath), false, '过期文件应被清理');
  assert.ok(fs.existsSync(path.join(dir, second.data.name)));
});
