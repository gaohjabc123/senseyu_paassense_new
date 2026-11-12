// admin.test.mjs —— 后台：超级管理员 / 客户管理员 / 成员，有效期、模块权限、日志、厂商凭据
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, superClient, setupTenant, today, SUPER, KB_TEXT } from './helpers.mjs';

let s, sup, A, B;
before(async () => {
  s = await startServer({ env: { ...SUPER, DATA_ENCRYPTION_KEY: 'unit-test-encryption' } });
});
after(async () => { await s.close(); });

test('超级管理员：由环境变量初始化，首次登录必须改密码，改完才能进后台', async () => {
  const first = await s.login('root', 'Bootstrap1pw'); // 测试用示例口令
  const me = await first.get('/api/me');
  assert.equal(me.data.user.role, 'super_admin');
  assert.equal(me.data.user.mustChangePassword, true);
  assert.equal((await first.get('/api/admin/tenants')).code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await first.post('/api/auth/password', { oldPassword: 'Bootstrap1pw', newPassword: 'short' })).code, 'INVALID_INPUT'); // 测试用示例口令
  sup = await superClient(s);
  assert.equal((await sup.get('/api/admin/tenants')).code, 0);
});

test('客户：创建时校验模块、有效期、真实环境必须分配凭据', async () => {
  const base = { name: '校验客户', startsDay: today(), expiresDay: today(10), modules: ['video-image'], admin: { username: 'check_admin' } };
  assert.equal((await sup.post('/api/admin/tenants', { ...base, modules: [] })).code, 'INVALID_INPUT');
  assert.equal((await sup.post('/api/admin/tenants', { ...base, expiresDay: today(-5) })).code, 'INVALID_INPUT');
  assert.equal((await sup.post('/api/admin/tenants', { ...base, allowReal: true })).code, 'INVALID_INPUT');
  assert.equal((await sup.post('/api/admin/tenants', { ...base, modules: ['not-a-module'] })).code, 'INVALID_INPUT');
  const ok = await sup.post('/api/admin/tenants', base);
  assert.equal(ok.code, 0);
  assert.match(ok.data.admin.initialPassword, /^(?=.*[A-Za-z])(?=.*\d).{12}$/, '初始密码随机生成且只返回这一次');
  assert.equal((await sup.post('/api/admin/tenants', base)).code, 'TENANT_EXISTS');
});

test('客户管理员：查看到期时间、添加成员、成员上限', async () => {
  A = await setupTenant(s, sup, { name: '甲公司', maxUsers: 3, modules: ['video-image'] });
  const o = await A.admin.get('/api/org/overview');
  assert.equal(o.data.tenant.name, '甲公司');
  assert.equal(o.data.tenant.expiresDay, today(13));
  assert.equal(o.data.tenant.daysLeft, 14);
  assert.deepEqual(o.data.tenant.modules, ['video-image']);
  assert.equal(o.data.tenant.vendorId, undefined, '客户看不到厂商凭据信息');

  const m1 = await A.admin.post('/api/org/users', { username: 'jia_member1', displayName: '张三' });
  assert.equal(m1.code, 0); assert.ok(m1.data.initialPassword);
  assert.equal((await A.admin.post('/api/org/users', { username: 'jia_member1' })).code, 'USERNAME_TAKEN');
  assert.equal((await A.admin.post('/api/org/users', { username: 'jia_member2' })).code, 0);
  const full = await A.admin.post('/api/org/users', { username: 'jia_member3' });
  assert.equal(full.code, 'SEAT_LIMIT'); assert.ok(full.hint);
  A.memberPw = m1.data.initialPassword;
});

test('权限：成员不能进企业管理；客户管理员不能管理其他企业的账号', async () => {
  const member = await s.login('jia_member1', A.memberPw);
  assert.equal((await member.get('/api/org/users')).code, 'FORBIDDEN');
  assert.equal((await member.get('/api/admin/tenants')).code, 'FORBIDDEN');
  B = await setupTenant(s, sup, { name: '乙公司' });
  const users = (await A.admin.get('/api/org/users')).data.users;
  const target = users.find((u) => u.username === 'jia_member2');
  assert.equal((await B.admin.patch(`/api/org/users/${target.id}`, { status: 'disabled' })).code, 'FORBIDDEN');
  assert.equal((await B.admin.del(`/api/org/users/${target.id}`)).code, 'FORBIDDEN');
});

test('模块权限：只开通图片数字人的客户，只能用图片数字人', async () => {
  const c = A.admin;
  const ok = await c.post('/api/capability/run', { id: 'video-image', params: {} });
  assert.equal(ok.code, 0);
  const tts = await c.post('/api/capability/run', { id: 'voice-tts', params: { text: '欢迎体验如影平台' } });
  assert.equal(tts.code, 'MODULE_FORBIDDEN'); assert.match(tts.message, /未开通「语音合成 TTS」/); assert.equal(tts.action, 'contact');
  assert.equal((await c.post('/api/tts', { text: '欢迎体验如影平台', purpose: 'voice' })).code, 'MODULE_FORBIDDEN');
  assert.equal((await c.post('/api/tts', { text: '欢迎体验如影平台', purpose: 'video' })).code, 0, '视频口播的配音随图片数字人一起开通');
  assert.equal((await c.get('/api/kb')).code, 'MODULE_FORBIDDEN');
  const caps = (await c.get('/api/capabilities')).data.list;
  assert.deepEqual(caps.filter((x) => x.allowed).map((x) => x.id), ['video-image']);
  assert.deepEqual((await c.get('/api/me')).data.access.modules, ['video-image']);
});

test('知识库：同一企业内共享，企业之间隔离', async () => {
  const b2 = await B.admin.post('/api/org/users', { username: 'yi_member' });
  const member = await s.login('yi_member', b2.data.initialPassword);
  await member.post('/api/auth/password', { oldPassword: b2.data.initialPassword, newPassword: 'Member1pass' });
  const m = await s.login('yi_member', 'Member1pass');
  assert.equal((await B.admin.post('/api/kb/upload', { name: '手册.txt', content: KB_TEXT })).code, 0);
  assert.equal((await m.get('/api/kb')).data.docs.length, 1, '同企业成员可见');
  const r = await m.sse('生成视频要多久？');
  assert.equal(r.meta.hit, true);
  assert.equal((await s.get('/api/kb')).data.docs.length, 0, '访客看不到企业资料');
});

test('有效期：到期后工作台不可用但能登录、能看到期时间与日志；续期后恢复', async () => {
  const tid = A.tenant.id;
  assert.equal((await sup.patch(`/api/admin/tenants/${tid}`, { startsDay: today(-30), expiresDay: today(-1) })).code, 0);
  const c = await s.login(A.username, 'Tenant1pass');
  const r = await c.post('/api/capability/run', { id: 'video-image', params: {} });
  assert.equal(r.code, 'TENANT_EXPIRED'); assert.match(r.message, /已于 .* 到期/); assert.equal(r.action, 'contact');
  const o = await c.get('/api/org/overview');
  assert.equal(o.data.tenant.expired, true);
  assert.equal((await c.get('/api/org/logs')).code, 0);
  await sup.patch(`/api/admin/tenants/${tid}`, { expiresDay: today(30) });
  assert.equal((await c.post('/api/capability/run', { id: 'video-image', params: {} })).code, 0);
  // 尚未开始
  await sup.patch(`/api/admin/tenants/${tid}`, { startsDay: today(2), expiresDay: today(30) });
  assert.equal((await c.post('/api/capability/run', { id: 'video-image', params: {} })).code, 'TENANT_NOT_STARTED');
  await sup.patch(`/api/admin/tenants/${tid}`, { startsDay: today(-1) });
});

test('停用：停用客户后全员下线且无法登录；停用成员同理', async () => {
  const c = await s.login(A.username, 'Tenant1pass');
  await sup.patch(`/api/admin/tenants/${A.tenant.id}`, { status: 'disabled' });
  assert.equal((await c.get('/api/me')).data.user, null, '会话立即失效');
  assert.equal((await s.post('/api/auth/login', { username: A.username, password: 'Tenant1pass' })).code, 'TENANT_DISABLED');
  await sup.patch(`/api/admin/tenants/${A.tenant.id}`, { status: 'active' });
  A.admin = await s.login(A.username, 'Tenant1pass');
  const u = (await A.admin.get('/api/org/users')).data.users.find((x) => x.username === 'jia_member1');
  await A.admin.patch(`/api/org/users/${u.id}`, { status: 'disabled' });
  assert.equal((await s.post('/api/auth/login', { username: 'jia_member1', password: A.memberPw })).code, 'ACCOUNT_DISABLED');
  assert.equal((await A.admin.patch(`/api/org/users/${(await A.admin.get('/api/me')).data.user.id}`, { status: 'disabled' })).code, 'INVALID_INPUT', '不能停用自己');
});

test('重置密码：生成新的一次性密码，旧密码失效，需重新改密', async () => {
  const u = (await A.admin.get('/api/org/users')).data.users.find((x) => x.username === 'jia_member2');
  const r = await A.admin.post(`/api/org/users/${u.id}/reset-password`);
  assert.equal(r.code, 0);
  const c = await s.login('jia_member2', r.data.initialPassword);
  assert.equal((await c.get('/api/me')).data.user.mustChangePassword, true);
});

test('使用日志：记录每次调用；客户管理员只看到本企业；支持筛选与 CSV 导出', async () => {
  const org = await A.admin.get('/api/org/logs?category=usage');
  assert.equal(org.code, 0);
  assert.ok(org.data.rows.length >= 3);
  assert.ok(org.data.rows.every((r) => r.tenant_id === A.tenant.id), '只能看到本企业日志');
  const failed = await A.admin.get('/api/org/logs?ok=0&category=usage');
  assert.ok(failed.data.rows.some((r) => r.code === 'MODULE_FORBIDDEN' || r.code === 'TENANT_EXPIRED'), '失败调用也会被记录');
  const cap = await A.admin.get('/api/org/logs?capability=video-image');
  assert.ok(cap.data.rows.every((r) => r.capability === 'video-image'));
  const csv = await A.admin.get('/api/org/logs.csv');
  assert.match(csv.contentType, /text\/csv/);
  assert.match(csv.raw, /时间,客户,账号/);
  const all = await sup.get(`/api/admin/logs?tenant=${B.tenant.id}`);
  assert.ok(all.data.rows.every((r) => r.tenant_id === B.tenant.id));
  const audit = await sup.get('/api/admin/logs?category=admin');
  assert.ok(audit.data.rows.some((r) => r.action === 'tenant.update' && /到期/.test(r.detail)), '有效期变更有审计记录');
  const stats = await sup.get(`/api/admin/tenants/${A.tenant.id}`);
  assert.ok(stats.data.usage.calls >= 3);
});

test('厂商凭据：APP_KEY 加密存储、不回显；被客户使用时不能删除', async () => {
  const v = await sup.post('/api/admin/vendors', { name: '如影-测试账号', appId: 'test-vendor-app', appKey: 'fake-key-1', ttsQid: 'qid-x' });
  assert.equal(v.code, 0);
  const list = await sup.get('/api/admin/vendors');
  const text = JSON.stringify(list.data);
  assert.ok(!text.includes('fake-key-1') && !text.includes('test-vendor-app'), '列表里只有打码后的 APP_ID，没有 APP_KEY');
  assert.equal((await sup.patch(`/api/admin/tenants/${B.tenant.id}`, { allowReal: true, vendorId: v.data.vendor.id })).code, 0);
  assert.equal((await sup.del(`/api/admin/vendors/${v.data.vendor.id}`)).code, 'VENDOR_IN_USE');
  const me = await B.admin.get('/api/me');
  assert.equal(me.data.access.canReal, true, '开通真实环境且分配了凭据');
  assert.equal((await A.admin.get('/api/admin/vendors')).code, 'FORBIDDEN');
});

test('厂商凭据：未配置 DATA_ENCRYPTION_KEY 时拒绝保存并说明原因', async () => {
  const s2 = await startServer({ env: SUPER });
  try {
    const sup2 = await superClient(s2);
    const r = await sup2.post('/api/admin/vendors', { name: '如影', appId: 'x', appKey: 'y' });
    assert.equal(r.code, 'ENCRYPTION_NOT_CONFIGURED'); assert.equal(r.action, 'config');
  } finally { await s2.close(); }
});

test('登录保护：连续输错 5 次临时锁定；错误提示不泄露账号是否存在', async () => {
  const bad = await s.post('/api/auth/login', { username: 'nobody', password: 'x' });
  const bad2 = await s.post('/api/auth/login', { username: A.username, password: 'wrong' });
  assert.equal(bad.message, bad2.message);
  for (let i = 0; i < 4; i++) await s.post('/api/auth/login', { username: A.username, password: 'wrong' });
  assert.equal((await s.post('/api/auth/login', { username: A.username, password: 'Tenant1pass' })).code, 'LOGIN_LOCKED');
});

test('访客：PUBLIC_DEMO=false 时工作台需要登录', async () => {
  const s3 = await startServer({ env: { PUBLIC_DEMO: 'false' } });
  try {
    const r = await s3.post('/api/capability/run', { id: 'video-image', params: {} });
    assert.equal(r.code, 'LOGIN_REQUIRED'); assert.equal(r.action, 'login');
    assert.equal((await s3.get('/api/health')).code, 0);
  } finally { await s3.close(); }
});

test('退出登录：会话失效，Cookie 被清除', async () => {
  const c = await s.login(B.username, 'Tenant1pass');
  const r = await c.post('/api/auth/logout');
  assert.match(r.setCookie, /Max-Age=0/);
  assert.equal((await c.get('/api/me')).data.user, null);
});
