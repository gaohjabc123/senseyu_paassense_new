// app.test.mjs —— 前端纯逻辑：引导、校验、作品存储、配置读取
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOUR_STEPS, nextTourStep, shouldShowTour, markTourDone, INTERPRET } from '../src/lib/guide.js';
import { validateText, estimateSeconds, stageLabel, EXPERIENCES } from '../src/lib/wizard.js';
import { getConfig } from '../server/lib/config.mjs';

test('guide：引导步骤与持久化', () => {
  assert.ok(TOUR_STEPS.length >= 3);
  for (const s of TOUR_STEPS) assert.ok(s.title && s.text && s.selector);
  assert.equal(nextTourStep(TOUR_STEPS.length - 1), -1);
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.equal(shouldShowTour(storage), true);
  markTourDone(storage);
  assert.equal(shouldShowTour(storage), false);
  assert.equal(INTERPRET.avatar({ duration: 5.8 }).length, 4);
});

test('wizard：文案校验、时长估算、阶段文案', () => {
  assert.equal(validateText('短').ok, false);
  assert.equal(validateText('字'.repeat(201)).ok, false);
  assert.equal(validateText('赣南脐橙今天到货').ok, true);
  assert.equal(estimateSeconds('一二三四五六七八九十'), 2.6);
  assert.equal(stageLabel(1, true), '平台排队中');
  assert.equal(stageLabel(2), '生成中');
  assert.deepEqual(EXPERIENCES.map((e) => e.id), ['video', 'voice', 'chat']);
});

test('works：保存 / 读取 / 删除 / 7 天过期 / 文本类作品', async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const works = await import('../src/lib/works.js');
  const now = Date.now();
  const { work, persisted } = works.addWork({ kind: 'video', type: '视频口播', title: '测试', url: 'files/mock_video.mp4' }, now);
  works.addWork({ kind: 'text', type: '知识库管理', title: 'JSON', text: '{"a":1}' }, now + 1);
  assert.equal(persisted, true);
  const list = works.listWorks(now + 10);
  assert.equal(list.length, 2);
  assert.equal(list[1].days, 7);
  assert.ok(list[0].createdAt);
  assert.equal(works.getWork(list[0].id).text, '{"a":1}');
  works.removeWork(work.id);
  assert.equal(works.listWorks(now + 10).length, 1);
  assert.equal(works.listWorks(now + 8 * 86400000).length, 0, '7 天后过期');
});

test('config：优先读环境变量，读不到再回退到 .env 文件', () => {
  const cfg = getConfig({ RUYING_APP_ID: 'from-env' }, { RUYING_APP_ID: 'from-file', RUYING_APP_KEY: 'file-key', RUYING_MOCK: 'false' });
  assert.equal(cfg.appId, 'from-env');
  assert.equal(cfg.appKey, 'file-key');
  assert.equal(cfg.defaultMode, 'real');
  const missing = getConfig({ RUYING_MOCK: 'false' }, {});
  assert.equal(missing.defaultMode, 'mock', '缺凭据时回退演示模式而不是崩溃');
  assert.equal(missing.warnings.length, 1);
  assert.equal(getConfig({ RUYING_APP_ID: '' }, { RUYING_APP_ID: 'f' }).appId, 'f', '空字符串视为未设置');
});
