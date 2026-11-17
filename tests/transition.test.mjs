// transition.test.mjs —— 过渡视频 + 预热素材「查状态 / 批量删除」（演示模式，不需要平台密钥）
// 接口口径以飞书文档 V1.5.2 为准；演示环境用 mock 样例。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';
import { capById } from '../src/lib/capabilities.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); });

test('过渡视频查状态（演示）：按任务编号批量查，表格字段齐全', async () => {
  const j = await s.post('/api/live/transition/status', { taskIds: '111\n222' });
  assert.equal(j.code, 0);
  assert.equal(j.data.mode, 'mock');
  assert.equal(j.data.tasks.length, 2);
  assert.equal(j.data.tasks[0].taskId, '111');
  assert.ok(j.data.tasks[0].materialId, '须有素材 ID');
  assert.ok(j.data.tasks[0].statusText, '须有翻译后的状态');
  assert.equal(j.data.tasks[0].status, 5, '第一条样例为已完成');
});

test('过渡视频批量删除（演示）：返回已删编号，不真正调用平台', async () => {
  const j = await s.post('/api/live/transition/delete', { taskIds: '111,222' });
  assert.equal(j.code, 0);
  assert.equal(j.data.ok, true);
  assert.deepEqual(j.data.deleted, ['111', '222']);
  assert.match(j.data.note || '', /演示/);
});

test('预热素材查状态（演示）：按 fileIds 批量查，字段与文档一致', async () => {
  const j = await s.post('/api/live/warming/status', { fileIds: 'file_a\nfile_b' });
  assert.equal(j.code, 0);
  assert.equal(j.data.mode, 'mock');
  assert.equal(j.data.files.length, 2);
  assert.equal(j.data.files[0].fileId, 'file_a');
  assert.equal(j.data.files[0].taskId, '2040', '文档样例的任务 ID 是数字，统一转字符串');
  assert.equal(j.data.files[0].status, 5, '第一条样例为已完成');
  assert.equal(j.data.files[0].statusText, '已完成');
  assert.ok(j.data.files[0].fileUrl, '须有地址');
  assert.equal(j.data.files[1].statusText, '进行中');
});

test('预热素材批量删除（演示）：返回已删 fileIds', async () => {
  const j = await s.post('/api/live/warming/delete', { fileIds: ['file_a', 'file_b'] });
  assert.equal(j.code, 0);
  assert.equal(j.data.ok, true);
  assert.deepEqual(j.data.deleted, ['file_a', 'file_b']);
  assert.match(j.data.note || '', /演示/);
});

test('查状态 / 批量删除：空输入与超量输入返回可读错误', async () => {
  const empty = await s.post('/api/live/transition/status', { taskIds: '' });
  assert.equal(empty.code, 'INVALID_INPUT');
  const tooMany = await s.post('/api/live/warming/delete', { fileIds: Array.from({ length: 11 }, (_, i) => `f${i}`).join(',') });
  assert.equal(tooMany.code, 'INVALID_INPUT');
  assert.match(tooMany.message, /最多查 \/ 删 10 个/);
});

test('体验页渲染：过渡视频与预热素材有查状态/批量删除区，其余能力没有', async () => {
  const { experienceView } = await import('../src/lib/experience.js');
  const freshManage = () => ({ statusIds: '', rows: [], loading: false, error: null, deleteIds: '', deleting: false, deleteError: null, deleteMsg: '' });
  const base = { exp: { running: false, params: {}, error: null, result: null, transition: freshManage(), warming: freshManage() }, recent: {}, config: {} };
  const trans = experienceView(base, capById('live-transition'));
  for (const needle of ['查状态', '批量删除', 'data-action="transition-status"', 'data-action="transition-delete"', 'data-bind="exp.transition.statusIds"', '没有按素材 ID 查状态']) {
    assert.ok(trans.includes(needle), `过渡视频渲染缺失：${needle}`);
  }
  const warm = experienceView(base, capById('live-warming'));
  for (const needle of ['查状态', '批量删除', 'data-action="warming-status"', 'data-action="warming-delete"', 'data-bind="exp.warming.statusIds"', '没有“列出全部预热素材”的接口']) {
    assert.ok(warm.includes(needle), `预热素材渲染缺失：${needle}`);
  }
  const tts = experienceView(base, capById('voice-tts'));
  assert.ok(!tts.includes('data-action="transition-status"') && !tts.includes('data-action="warming-status"'), '语音合成不应出现查状态/批量删除区');
});
