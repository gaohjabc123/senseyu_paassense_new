// teaching.test.mjs —— 教学闭环：作品服务端保存、院校客户的班级 / 教师 / 批量导入、提交与批改、老库升级
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, superClient, setupTenant, SUPER } from './helpers.mjs';
import { openDb } from '../server/lib/db.mjs';

let s, sup, school, corp;
const P = 'Student1pass'; // 测试用示例口令

/** 用初始密码登录并改密，返回可用的客户端 */
async function activate(username, initPw) {
  const first = await s.login(username, initPw);
  const r = await first.post('/api/auth/password', { oldPassword: initPw, newPassword: P });
  assert.equal(r.code, 0);
  return s.login(username, P);
}

before(async () => {
  s = await startServer({ env: { ...SUPER, DATA_ENCRYPTION_KEY: 'unit-test-encryption' } });
  sup = await superClient(s);
  school = await setupTenant(s, sup, { name: '示范职业技术学院', orgType: 'vocational', maxUsers: 12 });
  corp = await setupTenant(s, sup, { name: '示范企业' });
});
after(async () => { await s.close(); });

test('作品：访客不能用服务端作品库；登录后保存、去重、改名、删除、清空', async () => {
  assert.equal((await s.get('/api/works')).code, 'UNAUTHENTICATED');
  const c = corp.admin;
  const a = await c.post('/api/works', { kind: 'video', type: '视频口播', title: '新品口播', url: 'files/mock_image_avatar.mp4', duration: 5.8, mode: 'mock' });
  assert.equal(a.code, 0); assert.equal(a.data.duplicate, false);
  const dup = await c.post('/api/works', { kind: 'video', type: '视频口播', title: '再存一次', url: 'files/mock_image_avatar.mp4' });
  assert.equal(dup.data.duplicate, true); assert.equal(dup.data.work.id, a.data.work.id, '同一地址只存一份');
  assert.equal((await c.post('/api/works', { kind: 'text', type: '知识库管理', title: 'JSON', text: '{"a":1}' })).code, 0);
  assert.equal((await c.post('/api/works', { kind: 'video', title: 'x', url: 'javascript:alert(1)' })).code, 'INVALID_INPUT', '拒绝非 http(s) 地址');
  assert.equal((await c.post('/api/works', { kind: 'text', title: '空', text: '  ' })).code, 'INVALID_INPUT');
  assert.equal((await c.post('/api/works', { kind: 'exe', title: 'x', url: 'https://a.example/x' })).code, 'INVALID_INPUT');

  let list = (await c.get('/api/works')).data.works;
  assert.equal(list.length, 2);
  assert.equal((await c.patch(`/api/works/${a.data.work.id}`, { title: '改过的名字' })).data.work.title, '改过的名字');
  assert.equal((await c.patch(`/api/works/${a.data.work.id}`, { title: '  ' })).code, 'INVALID_INPUT');

  // 换一台电脑（新会话）仍然能看到；别人看不到、也删不掉
  const again = await s.login(corp.username, 'Tenant1pass');
  assert.equal((await again.get('/api/works')).data.works.length, 2);
  assert.equal((await school.admin.get('/api/works')).data.works.length, 0);
  assert.equal((await school.admin.del(`/api/works/${a.data.work.id}`)).code, 'NOT_FOUND');

  assert.equal((await c.del(`/api/works/${a.data.work.id}`)).code, 0);
  const cleared = await c.del('/api/works');
  assert.equal(cleared.data.removed, 1); assert.equal(cleared.data.works.length, 0);
});

test('客户类别：院校才有教师角色与班级；企业客户被明确拒绝', async () => {
  assert.equal(school.tenant.orgType, 'vocational'); assert.equal(school.tenant.isSchool, true);
  assert.equal(corp.tenant.orgType, 'enterprise'); assert.equal(corp.tenant.isSchool, false);
  assert.equal((await sup.post('/api/admin/tenants', { name: '类别不对', orgType: 'kindergarten', startsDay: '2026-01-01', expiresDay: '2027-01-01', modules: ['voice-tts'], admin: { username: 'bad_type' } })).code, 'INVALID_INPUT');
  assert.equal((await corp.admin.post('/api/org/users', { username: 'corp_teacher', role: 'teacher' })).code, 'INVALID_INPUT');
  assert.equal((await corp.admin.post('/api/org/classes', { name: '企业一班' })).code, 'NOT_SCHOOL');
  assert.equal((await corp.admin.get('/api/teach/works')).code, 'NOT_SCHOOL');
  assert.equal((await corp.admin.get('/api/me')).data.teaching.isSchool, false);
});

test('班级：建班、重名、指定任课教师（必须是本校教师）、改名', async () => {
  const A = school.admin;
  const t1 = await A.post('/api/org/users', { username: 'sf_teacher1', displayName: '王老师', role: 'teacher' });
  assert.equal(t1.code, 0); assert.equal(t1.data.user.role, 'teacher');
  school.teacher1 = { id: t1.data.user.id, pw: t1.data.initialPassword };
  const t2 = await A.post('/api/org/users', { username: 'sf_teacher2', displayName: '李老师', role: 'teacher' });
  school.teacher2 = { id: t2.data.user.id, pw: t2.data.initialPassword };

  const c1 = await A.post('/api/org/classes', { name: '数媒2601', teacherId: school.teacher1.id });
  assert.equal(c1.code, 0); assert.equal(c1.data.class.teacherName, '王老师');
  school.class1 = c1.data.class.id;
  assert.equal((await A.post('/api/org/classes', { name: '数媒2601' })).code, 'CLASS_EXISTS');
  assert.equal((await A.post('/api/org/classes', { name: '一' })).code, 'INVALID_INPUT');
  const outsider = (await corp.admin.get('/api/me')).data.user.id;
  assert.equal((await A.post('/api/org/classes', { name: '数媒2602', teacherId: outsider })).code, 'INVALID_INPUT', '不能指定外校账号任课');
  const c2 = await A.post('/api/org/classes', { name: '数媒2602', teacherId: school.teacher2.id });
  school.class2 = c2.data.class.id;
  assert.equal((await A.patch(`/api/org/classes/${school.class2}`, { name: '电商2602' })).data.class.name, '电商2602');
  assert.equal((await corp.admin.patch(`/api/org/classes/${school.class1}`, { name: '越权改名' })).code, 'FORBIDDEN');
  const d = await A.get('/api/org/classes');
  assert.equal(d.data.classes.length, 2);
  assert.ok(d.data.teachers.some((t) => t.id === school.teacher1.id));
});

test('批量导入：学号加前缀、自动建班、整批校验、名额限制', async () => {
  const A = school.admin;
  const bad = await A.post('/api/org/users/import', { rows: [{ username: '20260101', displayName: '赵一', className: '数媒2601' }] });
  assert.equal(bad.code, 'INVALID_INPUT'); assert.match(bad.message, /第 1 行/); assert.match(bad.hint, /前缀/);
  const dup = await A.post('/api/org/users/import', { prefix: 'sf', rows: [{ username: '20260101' }, { username: '20260101' }] });
  assert.equal(dup.code, 'INVALID_INPUT'); assert.match(dup.message, /第 2 行/);
  assert.equal((await A.get('/api/org/users')).data.users.length, 3, '校验失败时一个账号都不会创建');

  const ok = await A.post('/api/org/users/import', { prefix: 'sf', rows: [
    { username: '20260101', displayName: '赵一', className: '数媒2601' },
    { username: '20260102', displayName: '钱二', className: '数媒2601' },
    { username: '20260201', displayName: '孙三', className: '电商2602' },
    { username: '20260301', displayName: '李四', className: '新媒体2603' },
  ] });
  assert.equal(ok.code, 0);
  assert.equal(ok.data.created.length, 4);
  assert.deepEqual(ok.data.classesCreated, ['新媒体2603'], '名单里出现的新班级自动创建');
  assert.ok(ok.data.created.every((c) => c.initialPassword && c.username.startsWith('sf')));
  school.students = Object.fromEntries(ok.data.created.map((c) => [c.username, c.initialPassword]));

  const users = (await A.get('/api/org/users')).data;
  assert.equal(users.users.find((u) => u.username === 'sf20260101').className, '数媒2601');
  assert.equal(users.classes.find((c) => c.name === '数媒2601').studentCount, 2);

  const over = await A.post('/api/org/users/import', { prefix: 'sx', rows: Array.from({ length: 6 }, (_, i) => ({ username: `stu${i}` })) });
  assert.equal(over.code, 'SEAT_LIMIT');
  assert.equal((await A.post('/api/org/users/import', { prefix: 'sx', role: 'tenant_admin', rows: [{ username: 'boss' }] })).code, 'INVALID_INPUT');
  const member = await activate('sf20260301', school.students.sf20260301);
  assert.equal((await member.post('/api/org/users/import', { rows: [{ username: 'hacker1' }] })).code, 'FORBIDDEN');
});

test('提交与批改：学生提交 → 任课教师评分 → 学生看到成绩；越权与留档规则', async () => {
  const stu = await activate('sf20260101', school.students.sf20260101);
  const me = (await stu.get('/api/me')).data;
  assert.equal(me.user.className, '数媒2601'); assert.equal(me.teaching.canSubmit, true); assert.equal(me.teaching.canReview, false);

  const w = (await stu.post('/api/works', { kind: 'video', type: '视频口播', title: '实训一：新品口播', url: 'https://cdn.example.com/a.mp4', mode: 'real', duration: 12 })).data.work;
  const draft = (await stu.post('/api/works', { kind: 'audio', type: '语音合成', title: '草稿', url: 'files/mock_tts.mp3' })).data.work;
  const sub = await stu.post(`/api/works/${w.id}/submit`);
  assert.equal(sub.code, 0); assert.ok(sub.data.work.submittedAt);

  // 学生不能进批改页；未分班的账号不能提交
  assert.equal((await stu.get('/api/teach/works')).code, 'FORBIDDEN');
  const noClass = await school.admin.post('/api/works', { kind: 'text', type: 't', title: '管理员的作品', text: 'x' });
  assert.equal((await school.admin.post(`/api/works/${noClass.data.work.id}/submit`)).code, 'NO_CLASS');

  // 任课教师只看到自己班「已提交」的作品
  const t1 = await activate('sf_teacher1', school.teacher1.pw);
  const t2 = await activate('sf_teacher2', school.teacher2.pw);
  const list1 = (await t1.get('/api/teach/works')).data;
  assert.deepEqual(list1.classes.map((c) => c.name), ['数媒2601']);
  assert.deepEqual(list1.works.map((x) => x.title), ['实训一：新品口播'], '未提交的草稿教师看不到');
  assert.equal(list1.works[0].student.name, '赵一');
  assert.deepEqual(list1.stats, { submitted: 1, pending: 1, reviewed: 0, students: 1, avgScore: null });
  assert.equal((await t2.get('/api/teach/works')).data.works.length, 0);
  assert.equal((await t2.get(`/api/teach/works?class=${school.class1}`)).code, 'FORBIDDEN');
  assert.equal((await t2.post(`/api/teach/works/${w.id}/review`, { score: 60 })).code, 'FORBIDDEN', '非任课教师不能评分');
  assert.equal((await t1.post(`/api/teach/works/${draft.id}/review`, { score: 60 })).code, 'NOT_FOUND', '未提交的作品不能评分');

  for (const score of [101, -1, 85.5, '', 'abc']) assert.equal((await t1.post(`/api/teach/works/${w.id}/review`, { score })).code, 'INVALID_INPUT');
  const rv = await t1.post(`/api/teach/works/${w.id}/review`, { score: 88, comment: '口播节奏好，结尾的行动号召可以更明确。' });
  assert.equal(rv.code, 0); assert.equal(rv.data.work.review.score, 88); assert.equal(rv.data.work.review.reviewer, '王老师');

  // 学生看到成绩与评语；已批改的不能撤回、不能删除，清空时保留
  const mine = (await stu.get('/api/works')).data.works.find((x) => x.id === w.id);
  assert.equal(mine.review.score, 88); assert.match(mine.review.comment, /行动号召/);
  assert.equal((await stu.post(`/api/works/${w.id}/withdraw`)).code, 'WORK_REVIEWED');
  assert.equal((await stu.del(`/api/works/${w.id}`)).code, 'WORK_REVIEWED');
  const cleared = (await stu.del('/api/works')).data;
  assert.equal(cleared.removed, 1); assert.equal(cleared.kept, 1);

  // 撤回：批改前可以
  const w2 = (await stu.post('/api/works', { kind: 'image', type: 'AI 图片编辑', title: '实训二', url: 'https://cdn.example.com/b.png' })).data.work;
  await stu.post(`/api/works/${w2.id}/submit`);
  assert.equal((await t1.get('/api/teach/works?status=pending')).data.works.length, 1);
  assert.equal((await stu.post(`/api/works/${w2.id}/withdraw`)).data.work.submittedAt, null);
  assert.equal((await t1.get('/api/teach/works?status=pending')).data.works.length, 0);

  // 学校管理员看全校；成绩单 CSV 可导出
  const all = (await school.admin.get('/api/teach/works')).data;
  assert.equal(all.classes.length, 3); assert.equal(all.stats.reviewed, 1); assert.equal(all.stats.avgScore, 88);
  const csv = await fetch(`${s.base}/api/teach/works.csv`, { headers: { Cookie: t1.cookie } });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const body = await csv.text();
  assert.match(body, /班级,账号,姓名/); assert.match(body, /数媒2601,sf20260101,赵一,实训一：新品口播/); assert.match(body, /,88,/);

  // 留痕：批改与提交都进日志
  const logs = (await school.admin.get('/api/org/logs?size=200')).data.rows.map((r) => r.action);
  for (const a of ['work.submit', 'work.review', 'user.import', 'class.create']) assert.ok(logs.includes(a), `日志应包含 ${a}`);
});

test('调班与角色变更：教师降为学生后不再任课；删除班级后学生保留、成绩保留', async () => {
  const A = school.admin;
  const users = (await A.get('/api/org/users')).data.users;
  const stu = users.find((u) => u.username === 'sf20260102');
  const moved = await A.patch(`/api/org/users/${stu.id}`, { classId: school.class2 });
  assert.equal(moved.data.user.classId, school.class2);
  assert.equal((await A.patch(`/api/org/users/${stu.id}`, { classId: 'c_not_exist' })).code, 'INVALID_INPUT');

  await A.patch(`/api/org/users/${school.teacher2.id}`, { role: 'member' });
  assert.equal((await A.get('/api/org/classes')).data.classes.find((c) => c.id === school.class2).teacherId, null);

  assert.equal((await A.del(`/api/org/classes/${school.class1}`)).code, 0);
  const after = (await A.get('/api/org/users')).data;
  assert.equal(after.users.find((u) => u.username === 'sf20260101').classId, null);
  const kept = (await A.get('/api/teach/works')).data.works;
  assert.equal(kept.length, 1); assert.equal(kept[0].review.score, 88); assert.equal(kept[0].className, '（班级已删除）');

  const self = (await A.get('/api/me')).data.user.id;
  assert.equal((await A.patch(`/api/org/users/${self}`, { role: 'teacher' })).code, 'INVALID_INPUT', '不能修改自己的角色');
});

test('老数据库升级：缺少新列的 2.4 数据库打开后自动补齐，原有数据不丢', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruying-db-'));
  const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, contact TEXT DEFAULT '', plan TEXT NOT NULL DEFAULT 'trial', starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', max_users INTEGER NOT NULL DEFAULT 10, modules TEXT NOT NULL DEFAULT '[]', allow_real INTEGER NOT NULL DEFAULT 0, allow_billable INTEGER NOT NULL DEFAULT 0, vendor_id TEXT DEFAULT NULL, note TEXT DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT DEFAULT '', role TEXT NOT NULL, pw_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', must_change_pw INTEGER NOT NULL DEFAULT 1, last_login_at INTEGER, created_at INTEGER NOT NULL, created_by TEXT);
    INSERT INTO tenants (id, name, starts_at, expires_at, created_at, updated_at) VALUES ('t_old', '老客户', 1, 2, 1, 1);
    INSERT INTO users (id, tenant_id, username, role, pw_hash, created_at) VALUES ('u_old', 't_old', 'old_user', 'member', 'x', 1);`);
  old.close();
  const db = openDb(file);
  assert.equal(db.prepare('SELECT org_type FROM tenants WHERE id = ?').get('t_old').org_type, 'enterprise');
  assert.equal(db.prepare('SELECT class_id FROM users WHERE id = ?').get('u_old').class_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM works').get().n, 0);
  db.close();
  openDb(file).close(); // 再打开一次：升级是幂等的
  fs.rmSync(dir, { recursive: true, force: true });
});
