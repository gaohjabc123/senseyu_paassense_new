// navstack.test.mjs —— 返回栈：压栈去重、弹栈、兜底、文案
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeKey, pushNav, popNav, fallbackFor, resolveBack, backLabelFor, MAX_NAV_STACK } from '../src/lib/navstack.js';

test('routeKey：体验页拼 capId，其余取 view，空取首页', () => {
  assert.equal(routeKey({ view: 'experience', capId: 'voice-tts' }), 'experience/voice-tts');
  assert.equal(routeKey({ view: 'capabilities' }), 'capabilities');
  assert.equal(routeKey(null), 'home');
  assert.equal(routeKey({}), 'home');
});

test('pushNav：空、与目标相同、与栈顶相同都不压；超长截旧', () => {
  assert.deepEqual(pushNav([], '', 'capabilities'), []);
  assert.deepEqual(pushNav([], 'capabilities', 'capabilities'), []);
  assert.deepEqual(pushNav(['capabilities'], 'capabilities', 'experience/voice-tts'), ['capabilities']);
  assert.deepEqual(pushNav(['home'], 'capabilities', 'experience/voice-tts'), ['home', 'capabilities']);
  const big = Array.from({ length: MAX_NAV_STACK }, (_, i) => `p${i}`);
  const next = pushNav(big, 'new', 'other', MAX_NAV_STACK);
  assert.equal(next.length, MAX_NAV_STACK);
  assert.equal(next[0], 'p1');
  assert.equal(next[next.length - 1], 'new');
});

test('popNav：空栈返回 null 且不动栈', () => {
  assert.deepEqual(popNav([]), [null, []]);
  assert.deepEqual(popNav(['home', 'capabilities']), ['capabilities', ['home']]);
});

test('fallbackFor：体验页回能力矩阵，深层后台回父列表，其余回首页', () => {
  assert.equal(fallbackFor('experience/voice-tts'), 'capabilities');
  assert.equal(fallbackFor('admin/tenants/12'), 'admin/tenants');
  assert.equal(fallbackFor('overview'), 'home');
  assert.equal(fallbackFor(''), 'home');
  assert.equal(fallbackFor(null), 'home');
});

test('resolveBack：有栈弹栈顶，没栈走兜底', () => {
  assert.deepEqual(resolveBack(['home', 'capabilities'], 'experience/voice-tts'), { target: 'capabilities', stack: ['home'] });
  assert.deepEqual(resolveBack([], 'experience/voice-tts'), { target: 'capabilities', stack: [] });
  assert.deepEqual(resolveBack([], 'overview'), { target: 'home', stack: [] });
  assert.deepEqual(resolveBack(['overview'], 'overview'), { target: 'home', stack: [] }, '栈顶等于当前页时不原地打转');
});

test('backLabelFor：叫得出目标页名字，叫不出就写返回上页', () => {
  assert.equal(backLabelFor('capabilities'), '返回能力矩阵');
  assert.equal(backLabelFor('overview'), '返回总览');
  assert.equal(backLabelFor('experience/voice-tts'), '返回语音合成 TTS');
  assert.equal(backLabelFor('experience/voice-clone'), '返回音色复刻');
  assert.equal(backLabelFor('admin/tenants'), '返回客户管理');
  assert.equal(backLabelFor('no-such-page'), '返回上页');
  assert.equal(backLabelFor(''), '返回上页');
});
