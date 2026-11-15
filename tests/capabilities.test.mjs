// capabilities.test.mjs —— 操作流程数据完整性：前置条件、上手顺序、上传字段、下一步链路互相引用不出错
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, GUIDED_PATH, capById } from '../src/lib/capabilities.js';
import { NEXT_STEPS } from '../src/lib/experience.js';

test('前置条件：每条都有说明，cap 引用都真实存在', () => {
  for (const c of CAPABILITIES) {
    for (const r of c.experience?.requires || []) {
      assert.ok(typeof r.text === 'string' && r.text.length > 0, `${c.id} 的前置条件缺少说明`);
      if (r.cap) assert.ok(capById(r.cap), `${c.id} 的前置条件引用了不存在的能力 ${r.cap}`);
    }
  }
});

test('推荐上手顺序：5 步、能力都存在、无重复', () => {
  assert.equal(GUIDED_PATH.length, 5);
  const ids = GUIDED_PATH.map((s) => s.cap);
  assert.equal(new Set(ids).size, ids.length, '上手顺序里有重复的能力');
  for (const s of GUIDED_PATH) {
    assert.ok(capById(s.cap), `上手顺序引用了不存在的能力 ${s.cap}`);
    assert.ok(typeof s.why === 'string' && s.why.length > 0, `${s.cap} 的上手说明为空`);
  }
  assert.equal(GUIDED_PATH[0].cap, 'video-tts', '第一步应为零前置的文本驱动视频合成');
});

test('上传字段的类型都在服务端白名单里', async () => {
  const { MEDIA_KINDS } = await import('../server/lib/media.mjs');
  let count = 0;
  for (const c of CAPABILITIES) {
    for (const f of c.experience?.fields || []) {
      if (!f.upload) continue;
      count += 1;
      assert.ok(MEDIA_KINDS[f.upload], `${c.id}.${f.key} 的上传类型 ${f.upload} 不在服务端白名单里`);
    }
  }
  assert.ok(count >= 6, `可上传字段只有 ${count} 个，预期至少 6 个`);
});

test('前置条件的服务端配置状态：config 键名都在 /api/config 的返回字段里', () => {
  const KNOWN_CONFIG_KEYS = ['ttsConfigured', 'avatarImageConfigured', 'faceFeatureConfigured', 'avatarModelConfigured', 'liveAvatarConfigured', 'llmConfigured'];
  let count = 0;
  for (const c of CAPABILITIES) {
    for (const r of c.experience?.requires || []) {
      if (!r.config) continue;
      count += 1;
      assert.ok(KNOWN_CONFIG_KEYS.includes(r.config), `${c.id} 的前置条件引用了未知的配置键 ${r.config}`);
    }
  }
  assert.ok(count >= 5, `带服务端配置状态的前置条件只有 ${count} 条，预期至少 5 条`);
});

test('能力矩阵「需要准备」列：有前置条件的都列得出，无前置条件的显示为空', () => {
  for (const c of CAPABILITIES) {
    const reqs = c.experience?.requires || [];
    assert.ok(Array.isArray(reqs), `${c.id} 的 requires 不是数组`);
    for (const r of reqs) assert.ok(r.text.length > 0, `${c.id} 有空的前置条件`);
  }
  const withReqs = CAPABILITIES.filter((c) => (c.experience?.requires || []).length > 0);
  assert.ok(withReqs.length >= 8, `有前置条件的能力只有 ${withReqs.length} 项，预期至少 8 项`);
  assert.ok(CAPABILITIES.some((c) => !(c.experience?.requires || []).length), '应至少有一项能力无前置条件（矩阵列显示为空）');
});

test('下一步链路：来源与目标都存在，参数函数能产出非空值', () => {
  const fakeResults = {
    'voice-tts': { audioUrl: 'https://cdn.invalid/a.mp3' },
    'avatar-train': { json: { faceFeatureId: 'ff_1' } },
    'nlp-kb': {},
  };
  for (const [from, steps] of Object.entries(NEXT_STEPS)) {
    assert.ok(capById(from), `下一步来源 ${from} 不存在`);
    for (const step of steps) {
      assert.ok(capById(step.cap), `${from} 的下一步指向不存在的 ${step.cap}`);
      assert.notEqual(step.cap, from, '下一步不应指向自己');
      const params = step.params(fakeResults[from] || {});
      for (const [k, v] of Object.entries(params)) {
        assert.ok(typeof v === 'string' && v.length > 0, `${from}→${step.cap} 的参数 ${k} 为空`);
        assert.ok((capById(step.cap).experience?.fields || []).some((f) => f.key === k), `${step.cap} 没有 ${k} 这个字段，接不上`);
      }
    }
  }
});
