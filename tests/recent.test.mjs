// recent.test.mjs —— 上次的结果（localStorage 记忆）：读写、提取、字段映射
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRecent, saveRecent, extractRecent, recentForField, RECENT_KEY } from '../src/lib/recent.js';

function memStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
  };
}

test('loadRecent：空存储与坏 JSON 都返回空对象', () => {
  assert.deepEqual(loadRecent(memStore()), {});
  assert.deepEqual(loadRecent(memStore({ [RECENT_KEY]: 'not json{' })), {});
  assert.deepEqual(loadRecent(memStore({ [RECENT_KEY]: JSON.stringify({ audioUrl: 'https://x/a.mp3' }) })), { audioUrl: 'https://x/a.mp3' });
});

test('saveRecent：合并写入，不丢旧值', () => {
  const st = memStore();
  saveRecent({ audioUrl: 'https://x/a.mp3' }, st);
  const next = saveRecent({ faceFeatureId: 'ff_1' }, st);
  assert.equal(next.audioUrl, 'https://x/a.mp3');
  assert.equal(next.faceFeatureId, 'ff_1');
  assert.equal(loadRecent(st).audioUrl, 'https://x/a.mp3');
});

test('extractRecent：只记真实环境的结果，按能力取对应值', () => {
  assert.equal(extractRecent('voice-tts', { mode: 'mock', audioUrl: 'https://x/a.mp3' }), null, '演示结果不记');
  assert.deepEqual(extractRecent('voice-tts', { mode: 'real', audioUrl: 'https://x/a.mp3' }), { audioUrl: 'https://x/a.mp3' });
  assert.deepEqual(extractRecent('avatar-train', { mode: 'real', json: { faceFeatureId: 'ff_9' } }), { faceFeatureId: 'ff_9' });
  assert.deepEqual(extractRecent('voice-clone', { mode: 'real', json: { qid: 'qid_1' } }), { qid: 'qid_1' });
  assert.equal(extractRecent('video-image', { mode: 'real', videoUrl: 'https://x/v.mp4' }), null);
  assert.equal(extractRecent('avatar-train', { mode: 'real', json: {} }), null, '没有 faceFeatureId 时不记');
});

test('recentForField：字段与上次结果的映射', () => {
  const recent = { audioUrl: 'https://x/a.mp3', faceFeatureId: 'ff_1' };
  assert.deepEqual(recentForField('audioUrl', recent), { label: '使用上次合成的音频', value: 'https://x/a.mp3' });
  assert.deepEqual(recentForField('faceFeatureId', recent), { label: '使用上次训练的形象', value: 'ff_1' });
  assert.equal(recentForField('modelUrl', recent), null);
  assert.equal(recentForField('audioUrl', {}), null);
});
