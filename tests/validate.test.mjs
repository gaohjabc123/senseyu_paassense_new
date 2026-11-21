// validate.test.mjs —— 前端表单校验规则（src/lib/validate.js）
// 这些规则是对 server/lib/tenancy.mjs · secrets.mjs · quota.mjs · teaching.mjs 的前端镜像。
// 本文件的作用之一：服务端改规则时，让这里先红，提醒同步更新前端，而不是等用户在页面上撞见。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  USERNAME_RE, PREFIX_RE, IMPORT_MAX, passwordProblem, todayBeijing,
  validateLogin, validatePassword, validateTenant, validateUserCreate, validateImport,
  validateClass, validateKey, validateQuota, validatePurchase, validateVendor,
} from '../src/lib/validate.js';
import { parseRoster } from '../src/lib/admin.js';

// ---- 与服务端同源：正则字面量必须逐字一致（读服务端源码比对，不手抄） ----
const tenancySrc = fs.readFileSync(new URL('../server/lib/tenancy.mjs', import.meta.url), 'utf8');
const literal = (src, name) => src.match(new RegExp(`${name} = (/.*/);`))?.[1];

test('规则同源：USERNAME_RE / PREFIX_RE / IMPORT_MAX 与服务端逐字一致', () => {
  assert.equal(String(USERNAME_RE), literal(tenancySrc, 'USERNAME_RE'));
  assert.equal(String(PREFIX_RE), literal(tenancySrc, 'PREFIX_RE'));
  assert.equal(String(IMPORT_MAX), tenancySrc.match(/IMPORT_MAX = (\d+)/)[1]);
});

test('密码规则：与 server/lib/secrets.mjs 的 passwordProblem 同口径', async () => {
  const { passwordProblem: server } = await import('../server/lib/secrets.mjs');
  for (const pw of ['', 'abc1234', 'abcdefgh', '12345678', 'abcdefg1', 'Abcdefg1', 'a1'.repeat(32), 'a1'.repeat(33), '密码密码密码1a'])
    assert.equal(passwordProblem(pw), server(pw), `密码「${pw.slice(0, 12)}」前后端结论应一致`);
});

test('日期判断：前端 isDay 与服务端同构（源码级），并拒绝明显非法的日期', () => {
  const feSrc = fs.readFileSync(new URL('../src/lib/validate.js', import.meta.url), 'utf8');
  const grab = (src, re) => src.match(re)?.[0];
  assert.equal(grab(feSrc, /const isDay = .*/), grab(tenancySrc, /const isDay = .*/), 'isDay 一字不差');
  assert.equal(grab(feSrc, /const dayStart = .*/), grab(tenancySrc, /export const dayStart = .*/)?.replace('export ', ''), 'dayStart 一字不差');
  assert.match(validateKey({ name: '官网后台', expiresDay: '2026-13-45' }, '2026-11-21')['kf-exp'], /格式不正确/);
  assert.match(validateKey({ name: '官网后台', expiresDay: '2026-1-5' }, '2026-11-21')['kf-exp'], /格式不正确/, '非 YYYY-MM-DD 格式');
});

test('用户名边界：3～32 位、字母开头', () => {
  for (const ok of ['abc', 'a_b.c-d', 'a'.repeat(32)]) assert.ok(USERNAME_RE.test(ok), ok);
  for (const bad of ['ab', 'a'.repeat(33), '1abc', 'a b', '张三abc', '']) assert.ok(!USERNAME_RE.test(bad), bad);
});

test('登录：只检查非空，不在前端暴露密码规则', () => {
  assert.deepEqual(Object.keys(validateLogin({ username: '', password: '' })).sort(), ['login-pass', 'login-user']);
  assert.deepEqual(validateLogin({ username: ' u ', password: 'x' }), {});
  assert.deepEqual(Object.keys(validateLogin({ username: '   ', password: 'x' })), ['login-user'], '纯空格用户名视为空');
});

test('修改密码：规则 + 联动提示', () => {
  const e = validatePassword({ old: 'old12345', next: 'abc', again: 'xyz' });
  assert.match(e['pw-new'], /至少 8 位/);
  assert.match(e['pw-again'], /不一致/);
  assert.match(validatePassword({ old: 'abcdefg1', next: 'abcdefg1', again: 'abcdefg1' })['pw-new'], /不能与当前密码相同/);
  assert.deepEqual(validatePassword({ old: 'old12345', next: 'abcdefg1', again: 'abcdefg1' }), {});
  assert.ok(validatePassword({ old: '', next: 'abcdefg1', again: 'abcdefg1' })['pw-old'], '当前密码必填');
});

const goodTenant = () => ({ name: '示例企业', maxUsers: '10', startsDay: '2026-11-21', expiresDay: '2026-12-04', modules: ['voice-tts'], adminUsername: 'acme_admin' });
test('客户：合法值通过；逐项触发服务端同款错误', () => {
  assert.deepEqual(validateTenant(goodTenant(), true), {});
  assert.ok(validateTenant({ ...goodTenant(), name: '甲' }, true)['tf-name'], '名称 < 2');
  assert.ok(validateTenant({ ...goodTenant(), name: '甲'.repeat(61) }, true)['tf-name'], '名称 > 60');
  for (const n of ['0', '10001', '1.5', '', 'abc']) assert.ok(validateTenant({ ...goodTenant(), maxUsers: n }, true)['tf-max'], `成员上限 ${n}`);
  assert.deepEqual(validateTenant({ ...goodTenant(), maxUsers: '10000' }, true), {}, '上限边界 10000 合法');
  assert.match(validateTenant({ ...goodTenant(), expiresDay: '2026-11-20' }, true)['tf-end'], /不能早于开始日期/);
  assert.deepEqual(validateTenant({ ...goodTenant(), expiresDay: '2026-11-21' }, true), {}, '到期=开始当天合法');
  assert.ok(validateTenant({ ...goodTenant(), modules: [] }, true)['tf-modules'], '至少一个模块');
  assert.ok(validateTenant({ ...goodTenant(), adminUsername: '1abc' }, true)['tf-admin']);
  assert.equal(validateTenant({ ...goodTenant(), adminUsername: '' }, false)['tf-admin'], undefined, '编辑客户时不校验管理员用户名');
});

test('新建账号 / 新建班级', () => {
  assert.deepEqual(validateUserCreate({ username: 'zhang.san', displayName: '张三' }), {});
  assert.ok(validateUserCreate({ username: '1abc', displayName: '' })['nu-name']);
  assert.ok(validateUserCreate({ username: 'abc', displayName: '甲'.repeat(31) })['nu-display']);
  assert.deepEqual(validateClass({ name: '2026级数字媒体1班' }), {});
  assert.ok(validateClass({ name: '一' })['cf-name']);
  assert.ok(validateClass({ name: '班'.repeat(41) })['cf-name']);
  assert.deepEqual(validateClass({ name: '班'.repeat(40) }), {}, '40 字边界合法');
});

test('批量导入：逐行校验，大小写重复、前缀、条数上限、班级名长度', () => {
  const run = (text, f = {}, o = {}) => validateImport({ prefix: '', ...f }, parseRoster(text), o);
  assert.deepEqual(run('zhangsan, 张三\nlisi, 李四'), {});
  assert.deepEqual(run('用户名,姓名\nzhangsan,张三'), {}, '表头被跳过');
  assert.deepEqual(run('ab1，张三'), {}, '全角逗号');
  assert.match(run('20260101, 张三, 一班', {}, { school: true })['imp-text'], /第 1 行.*不合法.*用户名前缀/s, '纯数字学号且无前缀给出针对性提示');
  assert.deepEqual(run('20260101, 张三, 一班', { prefix: 'szpt' }, { school: true }), {});
  assert.match(run('Zhang, A\nzhang, B')['imp-text'], /第 2 行.*与第 1 行重复/, '重复判断不区分大小写（与服务端一致）');
  assert.ok(run('abc, x', { prefix: '1abc' })['imp-prefix'], '前缀须字母开头');
  assert.ok(run('\n  \n')['imp-text'], '空名单');
  assert.match(run(Array.from({ length: 101 }, (_, i) => `user${String(i).padStart(3, '0')}`).join('\n'))['imp-text'], /最多导入 100/);
  assert.match(run('szpt1001, 张三, ' + '班'.repeat(41), {}, { school: true })['imp-text'], /班级名称最多 40 个字/);
  assert.equal(run('szpt1001, 张三, ' + '班'.repeat(41), {}, { school: false })['imp-text'], undefined, '企业客户不校验班级列（服务端同样忽略）');
  const many = run(Array.from({ length: 8 }, (_, i) => `${i}x`).join('\n'))['imp-text'];
  assert.match(many, /另有 3 处/, '最多列 5 条，其余折叠');
});

test('密钥：名称 2～40；有效期可空，今天可以、昨天不行；按北京时间', () => {
  const today = '2026-11-21';
  assert.deepEqual(validateKey({ name: '官网后台', expiresDay: '' }, today), {});
  assert.ok(validateKey({ name: '甲', expiresDay: '' }, today)['kf-name']);
  assert.ok(validateKey({ name: '甲'.repeat(41), expiresDay: '' }, today)['kf-name']);
  assert.deepEqual(validateKey({ name: '官网后台', expiresDay: today }, today), {}, '今天本身合法（服务端按当天 23:59:59 到期）');
  assert.match(validateKey({ name: '官网后台', expiresDay: '2026-11-20' }, today)['kf-exp'], /不能早于今天/);
});

test('北京时间「今天」：UTC 15:59 仍是当天，16:00 已是次日', () => {
  assert.equal(todayBeijing(Date.UTC(2026, 10, 21, 15, 59, 59)), '2026-11-21');
  assert.equal(todayBeijing(Date.UTC(2026, 10, 21, 16, 0, 0)), '2026-11-22');
});

test('额度 / 采购：正整数与非零整数', () => {
  for (const a of ['', '0', '-1', '1.5', 'abc', String(1e12 + 1)]) assert.ok(validateQuota({ op: 'allocate', amount: a })['qf-amt'], `额度 ${a}`);
  assert.deepEqual(validateQuota({ op: 'allocate', amount: '100' }), {});
  assert.match(validateQuota({ op: 'reclaim', amount: '' })['qf-amt'], /回收/, '回收与分配文案不同');
  assert.ok(validatePurchase({ amount: '0' })['pf-a']);
  assert.ok(validatePurchase({ amount: '1.5' })['pf-a']);
  assert.deepEqual(validatePurchase({ amount: '-100' }), {}, '负数表示冲减，合法');
});

test('厂商凭据：新增必填 APP_ID/APP_KEY，编辑可留空；平台地址可留空', () => {
  const base = { name: '如影-主账号', baseUrl: '', appId: '', appKey: '', avatarImageUrl: '' };
  assert.deepEqual(Object.keys(validateVendor(base, false)).sort(), ['vf-id', 'vf-key'], '新增：地址留空合法，ID/KEY 必填');
  assert.deepEqual(validateVendor(base, true), {}, '编辑：ID/KEY 留空 = 不修改');
  assert.ok(validateVendor({ ...base, baseUrl: 'http://x.com' }, true)['vf-base'], '填了就必须 https');
  assert.deepEqual(validateVendor({ ...base, baseUrl: 'https://aigc.softsugar.com', appId: 'a', appKey: 'b' }, false), {});
  assert.ok(validateVendor({ ...base, avatarImageUrl: 'ftp://x' }, true)['vf-img']);
  assert.deepEqual(validateVendor({ ...base, avatarImageUrl: 'http://x/a.png' }, true), {}, '形象图允许 http');
  assert.ok(validateVendor({ ...base, name: '甲' }, true)['vf-name']);
});
