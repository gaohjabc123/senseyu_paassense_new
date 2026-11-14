// teaching.mjs —— 教学闭环：班级、作品（服务端持久化）、提交与批改
//
// 作品
//   · 登录用户的作品存在服务端，换电脑、清浏览器都不丢；访客仍只存在本机浏览器
//   · 学生（已分班）可以把作品「提交给老师」；批改前可撤回，批改后不能删除（成绩留档）
// 班级（仅院校客户）
//   · 学校管理员建班、指定任课教师、把学生分到班级
//   · 教师只能看到自己任课班级里「已提交」的作品；学校管理员能看到全校的
import { tx } from './db.mjs';
import { newId } from './secrets.mjs';
import { AppError, E } from './errors.mjs';
import { isSchoolType } from './tenancy.mjs';

const KINDS = ['video', 'audio', 'image', 'text'];
export const MAX_WORKS_PER_USER = 500;
const MAX_TEXT = 20000;
const fail = (code, message, hint = '', action = 'fix') => new AppError({ code, message, hint, action });
/** 作品地址只接受 http(s) 或演示环境的本地样例（files/…），避免把 javascript: 之类的地址带进教师的预览页 */
const URL_OK = (u) => /^https?:\/\/[^\s"'<>]+$/i.test(u) || /^files\/[\w.-]+$/.test(u);

export function createTeaching({ db, tenancy, now = () => Date.now() }) {
  const q = (sql) => db.prepare(sql);
  const log = (actor, action, detail, ip, extra = {}) => tenancy.writeLog({ category: 'admin', action, tenantId: actor.tenant_id, userId: actor.id, username: actor.username, detail, ip, ...extra });

  /* ---------------- 班级 ---------------- */
  function schoolTenant(tenantId) {
    const t = tenancy.tenantRaw(tenantId);
    if (!t) throw E.notFound('客户不存在。');
    if (!isSchoolType(t.org_type)) throw fail('NOT_SCHOOL', '班级管理只对院校客户开放。', '如需使用班级与批改功能，请联系商予科技把客户类别改为院校。', 'contact');
    return t;
  }
  const canManage = (actor, tenantId) => actor.role === 'super_admin' || (actor.role === 'tenant_admin' && actor.tenant_id === tenantId);
  const assertManage = (actor, tenantId) => { if (!canManage(actor, tenantId)) throw fail('FORBIDDEN', '没有权限管理班级。', '', 'contact'); };

  const classView = (c) => ({ id: c.id, name: c.name, teacherId: c.teacher_id || null, teacherName: c.teacher_name || c.teacher_username || '', studentCount: c.students ?? 0, createdAt: c.created_at });
  const CLASS_SQL = `SELECT c.*, t.display_name AS teacher_name, t.username AS teacher_username,
      (SELECT COUNT(*) FROM users u WHERE u.class_id = c.id) AS students
    FROM classes c LEFT JOIN users t ON t.id = c.teacher_id`;

  function listClasses(tenantId) { return q(`${CLASS_SQL} WHERE c.tenant_id = ? ORDER BY c.name`).all(tenantId).map(classView); }
  function classRow(id) {
    const c = q(`${CLASS_SQL} WHERE c.id = ?`).get(String(id));
    if (!c) throw E.notFound('班级不存在。', '可能已被删除，请刷新列表。');
    return c;
  }

  function className(input) {
    const name = String(input ?? '').trim();
    if (name.length < 2 || name.length > 40) throw fail('INVALID_INPUT', '班级名称需 2～40 个字，例如「2026级数字媒体1班」');
    return name;
  }
  /** 任课教师必须是本校的教师或管理员 */
  function teacherOf(tenantId, teacherId) {
    if (teacherId === undefined || teacherId === null || teacherId === '') return null;
    const u = q(`SELECT id, role FROM users WHERE id = ? AND tenant_id = ?`).get(String(teacherId), tenantId);
    if (!u || !['teacher', 'tenant_admin'].includes(u.role)) throw fail('INVALID_INPUT', '任课教师需要是本校的教师账号。', '请先在「成员管理」里添加教师，或把已有账号设为教师。');
    return u.id;
  }

  function createClass(actor, tenantId, input, ip) {
    assertManage(actor, tenantId); schoolTenant(tenantId);
    const name = className(input.name);
    if (q('SELECT 1 FROM classes WHERE tenant_id = ? AND name = ?').get(tenantId, name)) throw fail('CLASS_EXISTS', `已有名为「${name}」的班级。`);
    const teacherId = teacherOf(tenantId, input.teacherId);
    const id = newId('c');
    q('INSERT INTO classes (id, tenant_id, name, teacher_id, created_at, created_by) VALUES (?,?,?,?,?,?)').run(id, tenantId, name, teacherId, now(), actor.id);
    log({ ...actor, tenant_id: tenantId }, 'class.create', `新建班级「${name}」`, ip);
    return classView(classRow(id));
  }

  function updateClass(actor, id, input, ip) {
    const c = classRow(id); assertManage(actor, c.tenant_id);
    const patch = {};
    if (input.name !== undefined) {
      const name = className(input.name);
      if (name !== c.name && q('SELECT 1 FROM classes WHERE tenant_id = ? AND name = ?').get(c.tenant_id, name)) throw fail('CLASS_EXISTS', `已有名为「${name}」的班级。`);
      patch.name = name;
    }
    if (input.teacherId !== undefined) patch.teacher_id = teacherOf(c.tenant_id, input.teacherId);
    const cols = Object.keys(patch);
    if (cols.length) q(`UPDATE classes SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => patch[k]), c.id);
    const after = classRow(id);
    log({ ...actor, tenant_id: c.tenant_id }, 'class.update', `「${after.name}」${[patch.name && patch.name !== c.name && `改名（原 ${c.name}）`, patch.teacher_id !== undefined && patch.teacher_id !== c.teacher_id && (patch.teacher_id ? `任课教师 → ${after.teacher_name || after.teacher_username}` : '取消任课教师')].filter(Boolean).join('；') || '无变化'}`, ip);
    return classView(after);
  }

  /** 删除班级：学生保留、变为未分班；已提交的作品与成绩保留（学校管理员仍可查看与导出） */
  function deleteClass(actor, id, ip) {
    const c = classRow(id); assertManage(actor, c.tenant_id);
    tx(db, () => {
      q('UPDATE users SET class_id = NULL WHERE class_id = ?').run(c.id);
      q('DELETE FROM classes WHERE id = ?').run(c.id);
    });
    log({ ...actor, tenant_id: c.tenant_id }, 'class.delete', `删除班级「${c.name}」（${c.students} 名学生变为未分班）`, ip);
  }

  /* ---------------- 作品 ---------------- */
  const workView = (w) => ({
    id: w.id, kind: w.kind, type: w.type, title: w.title, url: w.url, text: w.text, duration: w.duration, mode: w.mode, at: w.created_at,
    submittedAt: w.submitted_at || null, classId: w.class_id || null,
    review: w.reviewed_at ? { score: w.score, comment: w.comment || '', reviewer: w.reviewer_name || '', at: w.reviewed_at } : null,
  });
  const WORK_SQL = `SELECT w.*, COALESCE(NULLIF(r.display_name, ''), r.username) AS reviewer_name FROM works w LEFT JOIN users r ON r.id = w.reviewed_by`;

  function listWorks(user) { return q(`${WORK_SQL} WHERE w.user_id = ? ORDER BY w.created_at DESC, w.rowid DESC`).all(user.id).map(workView); }
  function ownWork(user, id) {
    const w = q(`${WORK_SQL} WHERE w.id = ? AND w.user_id = ?`).get(String(id), user.id);
    if (!w) throw E.notFound('找不到这条作品。', '可能已被删除，请刷新列表。');
    return w;
  }
  const workTitle = (t) => String(t ?? '').trim().slice(0, 60);

  function addWork(user, input = {}) {
    const kind = String(input.kind || '');
    if (!KINDS.includes(kind)) throw E.validation('作品类型不正确。');
    const url = String(input.url || '').trim();
    const text = String(input.text || '');
    if (url && (url.length > 1000 || !URL_OK(url))) throw E.validation('作品地址不正确。', '只能保存平台生成的结果。');
    if (kind !== 'text' && !url) throw E.validation('缺少作品地址。');
    if (kind === 'text' && !text.trim()) throw E.validation('作品内容是空的。');
    if (text.length > MAX_TEXT) throw E.validation(`文字内容太长（最多 ${MAX_TEXT} 字）。`);
    // 同一个产出只存一份：任务完成自动保存后，再手动点「保存到作品」不会重复
    if (url) {
      const dup = q(`${WORK_SQL} WHERE w.user_id = ? AND w.url = ?`).get(user.id, url);
      if (dup) return { work: workView(dup), duplicate: true };
    }
    const count = q('SELECT COUNT(*) AS n FROM works WHERE user_id = ?').get(user.id).n;
    if (count >= MAX_WORKS_PER_USER) throw fail('WORK_LIMIT', `作品数量已达上限（${MAX_WORKS_PER_USER} 条）。`, '请先删除不再需要的作品。');
    const id = newId('w');
    const duration = Number(input.duration);
    q(`INSERT INTO works (id, tenant_id, user_id, kind, type, title, url, text, duration, mode, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, user.tenant_id ?? null, user.id, kind, String(input.type || '').slice(0, 30), workTitle(input.title) || String(input.type || '作品').slice(0, 30) || '作品',
      url, kind === 'text' ? text : '', Number.isFinite(duration) && duration > 0 ? duration : null, input.mode === 'real' ? 'real' : 'mock', now());
    return { work: workView(ownWork(user, id)), duplicate: false };
  }

  function renameWork(user, id, title) {
    const w = ownWork(user, id);
    const name = workTitle(title);
    if (!name) throw E.validation('名字不能为空。');
    q('UPDATE works SET title = ? WHERE id = ?').run(name, w.id);
    return workView(ownWork(user, id));
  }

  function removeWork(user, id) {
    const w = ownWork(user, id);
    if (w.reviewed_at) throw fail('WORK_REVIEWED', '这条作品已经批改，不能删除。', '成绩需要留档；如确需删除请联系任课教师或学校管理员。', 'contact');
    q('DELETE FROM works WHERE id = ?').run(w.id);
  }

  /** 清空：已批改的作品保留；返回 { removed, kept } */
  function clearWorks(user) {
    const removed = q('DELETE FROM works WHERE user_id = ? AND reviewed_at IS NULL').run(user.id).changes;
    const kept = q('SELECT COUNT(*) AS n FROM works WHERE user_id = ?').get(user.id).n;
    return { removed, kept };
  }

  function submitWork(user, id, ip) {
    const w = ownWork(user, id);
    if (!user.class_id) throw fail('NO_CLASS', '你还没有被分到班级，暂时不能提交作品。', '请联系任课教师或学校管理员把你加入班级。', 'contact');
    const c = q('SELECT name FROM classes WHERE id = ?').get(user.class_id);
    if (!c) throw fail('NO_CLASS', '你所在的班级已被删除，暂时不能提交作品。', '请联系学校管理员重新分班。', 'contact');
    if (w.reviewed_at) throw fail('WORK_REVIEWED', '这条作品已经批改，不能重复提交。');
    q('UPDATE works SET submitted_at = ?, class_id = ? WHERE id = ?').run(now(), user.class_id, w.id);
    tenancy.writeLog({ category: 'usage', action: 'work.submit', tenantId: user.tenant_id, userId: user.id, username: user.username, detail: `提交作品「${w.title}」到 ${c.name}`, ip });
    return workView(ownWork(user, id));
  }

  function withdrawWork(user, id, ip) {
    const w = ownWork(user, id);
    if (!w.submitted_at) return workView(w);
    if (w.reviewed_at) throw fail('WORK_REVIEWED', '这条作品已经批改，不能撤回。');
    q('UPDATE works SET submitted_at = NULL, class_id = NULL WHERE id = ?').run(w.id);
    tenancy.writeLog({ category: 'usage', action: 'work.withdraw', tenantId: user.tenant_id, userId: user.id, username: user.username, detail: `撤回作品「${w.title}」`, ip });
    return workView(ownWork(user, id));
  }

  /* ---------------- 批改（教师 / 学校管理员） ---------------- */
  function assertReviewer(actor) {
    if (!['teacher', 'tenant_admin'].includes(actor.role) || !actor.tenant_id) throw fail('FORBIDDEN', '没有权限访问这个页面。', '', 'contact');
    schoolTenant(actor.tenant_id);
  }
  /** 教师：自己任课的班级；学校管理员：全部班级 */
  function reviewClasses(actor) {
    assertReviewer(actor);
    const all = listClasses(actor.tenant_id);
    return actor.role === 'tenant_admin' ? all : all.filter((c) => c.teacherId === actor.id);
  }

  const REVIEW_SQL = `SELECT w.*, COALESCE(NULLIF(r.display_name, ''), r.username) AS reviewer_name,
      u.username AS student_username, u.display_name AS student_name, c.name AS class_name
    FROM works w JOIN users u ON u.id = w.user_id LEFT JOIN classes c ON c.id = w.class_id LEFT JOIN users r ON r.id = w.reviewed_by`;
  const reviewView = (w) => ({ ...workView(w), student: { username: w.student_username, name: w.student_name || '' }, className: w.class_name || '（班级已删除）' });

  /** 已提交作品列表。status: pending 待批改 | reviewed 已批改 | 其他=全部 */
  function reviewList(actor, { classId = '', status = '' } = {}) {
    const classes = reviewClasses(actor);
    const where = ['w.tenant_id = ?', 'w.submitted_at IS NOT NULL']; const args = [actor.tenant_id];
    if (classId) {
      if (!classes.some((c) => c.id === classId)) throw fail('FORBIDDEN', '你不是这个班级的任课教师。', '', 'contact');
      where.push('w.class_id = ?'); args.push(classId);
    } else if (actor.role !== 'tenant_admin') {
      if (!classes.length) return { classes, works: [], stats: statsOf([]) };
      where.push(`w.class_id IN (${classes.map(() => '?').join(',')})`); args.push(...classes.map((c) => c.id));
    }
    const all = q(`${REVIEW_SQL} WHERE ${where.join(' AND ')} ORDER BY w.reviewed_at IS NOT NULL, w.submitted_at DESC LIMIT 2000`).all(...args).map(reviewView);
    const works = status === 'pending' ? all.filter((w) => !w.review) : status === 'reviewed' ? all.filter((w) => w.review) : all;
    return { classes, works, stats: statsOf(all) };
  }

  function statsOf(list) {
    const reviewed = list.filter((w) => w.review);
    const avg = reviewed.length ? Math.round((reviewed.reduce((s, w) => s + w.review.score, 0) / reviewed.length) * 10) / 10 : null;
    return { submitted: list.length, pending: list.length - reviewed.length, reviewed: reviewed.length, students: new Set(list.map((w) => w.student.username)).size, avgScore: avg };
  }

  function review(actor, id, input = {}, ip) {
    assertReviewer(actor);
    const w = q(`${REVIEW_SQL} WHERE w.id = ? AND w.tenant_id = ?`).get(String(id), actor.tenant_id);
    if (!w || !w.submitted_at) throw E.notFound('找不到这条作品。', '学生可能已撤回，请刷新列表。');
    if (actor.role !== 'tenant_admin' && !q('SELECT 1 FROM classes WHERE id = ? AND teacher_id = ?').get(w.class_id, actor.id)) throw fail('FORBIDDEN', '你不是这个班级的任课教师。', '', 'contact');
    const score = Number(input.score);
    if (input.score === '' || input.score === null || input.score === undefined || !Number.isInteger(score) || score < 0 || score > 100) throw E.validation('评分需为 0～100 的整数。');
    const comment = String(input.comment ?? '').trim().slice(0, 500);
    q('UPDATE works SET score = ?, comment = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(score, comment, actor.id, now(), w.id);
    tenancy.writeLog({ category: 'admin', action: 'work.review', tenantId: actor.tenant_id, userId: actor.id, username: actor.username, detail: `批改 ${w.student_username} 的作品「${w.title}」：${score} 分${w.reviewed_at ? '（改分）' : ''}`, ip });
    return reviewView(q(`${REVIEW_SQL} WHERE w.id = ?`).get(w.id));
  }

  return {
    listClasses, createClass, updateClass, deleteClass,
    listWorks, addWork, renameWork, removeWork, clearWorks, submitWork, withdrawWork,
    reviewClasses, reviewList, review,
  };
}
