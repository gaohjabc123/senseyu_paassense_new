// kb.test.mjs —— 知识库检索与存储单元测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tokenize, chunkText, search, extractiveAnswer, KbStore } from '../server/lib/kb.mjs';
import { KB_TEXT } from './helpers.mjs';

const doc = { id: 'd1', name: '手册.txt', title: '手册', chunks: chunkText(KB_TEXT, '手册') };

test('切词：中文二元组、去掉疑问虚词，英文按词', () => {
  assert.deepEqual(tokenize('生成视频要多久？'), ['生成', '成视', '视频', '多久']);
  assert.deepEqual(tokenize('What is the API'), ['api']);
  assert.deepEqual(tokenize('这个是什么'), []);
});

test('切块：按标题分节，块带标题', () => {
  const headings = doc.chunks.map((c) => c.heading);
  assert.ok(headings.includes('二、视频合成'));
  assert.ok(headings.includes('三、计费说明'));
  const long = chunkText('长文\n' + '这是一句比较长的测试句子，用来检验超长段落的切分。'.repeat(40), '长文');
  assert.ok(long.length > 1, '超长段落应被切成多块');
  assert.ok(long.every((c) => c.text.length <= 560));
});

test('检索：命中——问题关键词出现在资料里，返回正确段落', () => {
  const r = search([doc], '生成视频要多久？');
  assert.equal(r.reason, 'ok');
  assert.equal(r.hits[0].heading, '二、视频合成');
  assert.match(extractiveAnswer('生成视频要多久？', r.hits), /2 到 5 分钟/);
  assert.equal(search([doc], '怎么计费').hits[0].heading, '三、计费说明', '标题命中应排在前面');
});

test('检索：无命中——资料里没有的内容不硬凑', () => {
  for (const q of ['如何申请发票？', '今天天气怎么样', '数字货币交易平台']) {
    assert.equal(search([doc], q).hits.length, 0, `「${q}」不应命中`);
  }
  assert.equal(search([doc], '这个是什么？').reason, 'query-too-generic');
});

test('检索：空库', () => {
  const r = search([], '生成视频要多久？');
  assert.equal(r.hits.length, 0);
  assert.equal(r.reason, 'empty-kb');
});

test('存储：重复内容、同名、类型、编码、空文件都有明确提示；可持久化与删除', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-unit-'));
  try {
    const kb = new KbStore(dir);
    const ws = 'unit-test-ws';
    const d = kb.add(ws, { name: '手册.txt', content: KB_TEXT });
    const code = (fn) => { try { fn(); return null; } catch (e) { return e.kbCode; } };
    assert.equal(code(() => kb.add(ws, { name: '手册2.txt', content: KB_TEXT + '\n\n' })), 'DUPLICATE');
    assert.equal(code(() => kb.add(ws, { name: '手册.txt', content: '别的内容。' })), 'SAME_NAME');
    assert.equal(code(() => kb.add(ws, { name: 'x.docx', content: 'abc' })), 'BAD_TYPE');
    assert.equal(code(() => kb.add(ws, { name: 'gbk.txt', content: '乱码\uFFFD' })), 'BAD_ENCODING');
    assert.equal(code(() => kb.add(ws, { name: 'empty.txt', content: '  \n ' })), 'EMPTY');
    const reopened = new KbStore(dir);
    assert.equal(reopened.list(ws).length, 1, '重启后资料仍在');
    assert.equal(reopened.remove(ws, d.id), true);
    assert.equal(reopened.list(ws).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
