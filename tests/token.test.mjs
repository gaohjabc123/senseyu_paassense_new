// token.test.mjs —— Token 生命周期：绝对过期点、提前 30 分钟刷新、失效重试一次
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenManager, parseExpiry, isTokenInvalid, REFRESH_BEFORE_MS } from '../server/lib/token.mjs';

const cfg = { appId: 'unit-app', appKey: 'fake-key', tsUnit: 'ms', baseUrl: 'https://platform.invalid', requestTimeoutMs: 1000 };
const json = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });

function fakePlatform({ expiresInMs = 8 * 3600000, clock }) {
  let n = 0;
  return {
    get count() { return n; },
    fetch: async (url) => {
      assert.match(url, /\/api\/uc\/v1\/access\/api\/token$/);
      n += 1;
      return json({ code: 0, data: { accessToken: `tok-${n}`, expireTime: clock.now + expiresInMs } });
    },
  };
}

test('parseExpiry：优先使用平台给的绝对过期点（秒/毫秒/日期），没有才用 expiresIn', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(parseExpiry({ expireTime: now + 1000, expiresIn: 99999 }, now), now + 1000);
  assert.equal(parseExpiry({ expiresAt: Math.floor((now + 5000) / 1000) }, now), now + 5000);
  assert.equal(parseExpiry({ expireAt: '2026-01-01T01:00:00Z' }, now), now + 3600000);
  assert.equal(parseExpiry({ expiresIn: 60 }, now), now + 60000);
  assert.equal(parseExpiry({}, now), null);
});

test('缓存：剩余充足时复用；剩余不足 30 分钟时提前重新获取', async () => {
  const clock = { now: Date.UTC(2026, 10, 1) };
  const p = fakePlatform({ clock });
  const tm = new TokenManager(cfg, { fetchImpl: p.fetch, now: () => clock.now });
  assert.equal((await tm.get()).accessToken, 'tok-1');
  clock.now += 3 * 3600000;
  assert.equal((await tm.get()).accessToken, 'tok-1', '还剩 5 小时，应复用');
  clock.now += 5 * 3600000 - REFRESH_BEFORE_MS + 60000; // 剩余 29 分钟
  assert.equal((await tm.get()).accessToken, 'tok-2', '剩余不足 30 分钟，应提前更换');
  assert.equal(p.count, 2);
});

test('平台下发的 Token 本身很短时，不会每次调用都重新获取', async () => {
  const clock = { now: Date.UTC(2026, 10, 2) };
  const p = fakePlatform({ clock, expiresInMs: 10 * 60000 });
  const tm = new TokenManager(cfg, { fetchImpl: p.fetch, now: () => clock.now });
  await tm.get(); await tm.get(); await tm.get();
  assert.equal(p.count, 1);
});

test('并发请求合并为一次换取', async () => {
  const clock = { now: Date.UTC(2026, 10, 3) };
  const p = fakePlatform({ clock });
  const tm = new TokenManager(cfg, { fetchImpl: p.fetch, now: () => clock.now });
  await Promise.all([tm.get(), tm.get(), tm.get()]);
  assert.equal(p.count, 1);
});

test('withToken：平台提前作废 Token → 作废缓存、重取一次、重试一次', async () => {
  const clock = { now: Date.UTC(2026, 10, 3) };
  const p = fakePlatform({ clock });
  const tm = new TokenManager(cfg, { fetchImpl: p.fetch, now: () => clock.now });
  const used = [];
  const out = await tm.withToken(async (tok) => {
    used.push(tok);
    if (tok === 'tok-1') throw Object.assign(new Error('x'), { httpStatus: 401, platformMessage: 'token expired' });
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.deepEqual(used, ['tok-1', 'tok-2']);
});

test('withToken：只重试一次，仍然无效时给出可读错误', async () => {
  const clock = { now: Date.UTC(2026, 10, 3) };
  const p = fakePlatform({ clock });
  const tm = new TokenManager(cfg, { fetchImpl: p.fetch, now: () => clock.now });
  let calls = 0;
  await assert.rejects(
    tm.withToken(async () => { calls += 1; throw Object.assign(new Error('x'), { httpStatus: 200, platformMessage: 'Token 已失效' }); }),
    (e) => e.code === 'AUTH_FAILED' && /认证失败/.test(e.message),
  );
  assert.equal(calls, 2);
});

test('withToken：非 Token 类错误不重试', async () => {
  const clock = { now: Date.UTC(2026, 10, 3) };
  const tm = new TokenManager(cfg, { fetchImpl: fakePlatform({ clock }).fetch, now: () => clock.now });
  let calls = 0;
  await assert.rejects(tm.withToken(async () => { calls += 1; throw Object.assign(new Error('x'), { httpStatus: 400, platformMessage: '参数错误' }); }));
  assert.equal(calls, 1);
});

test('isTokenInvalid 判定', () => {
  assert.equal(isTokenInvalid({ httpStatus: 401 }), true);
  assert.equal(isTokenInvalid({ message: 'invalid token' }), true);
  assert.equal(isTokenInvalid({ message: '参数错误' }), false);
  assert.equal(isTokenInvalid({ code: 1001 }, [1001]), true);
});
