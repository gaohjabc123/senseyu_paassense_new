// tenancy.mjs —— 多租户：客户（租户）、账号、会话、厂商凭据、权限判定、使用日志
//
// 角色
//   super_admin   平台超级管理员（商予科技运营）：管理客户、有效期、模块权限、厂商凭据，查看全部日志
//   tenant_admin  客户管理员：管理本企业成员、查看本企业使用日志与到期时间
//   member        客户成员：在授权范围内使用工作台
import { tx } from './db.mjs';
import { hashPassword, verifyPassword, passwordProblem, generatePassword, newSessionToken, sha256, newId, makeCipher } from './secrets.mjs';
import { maskValue } from './mask.mjs';
import { AppError, E } from './errors.mjs';
import { CAPABILITIES, capById } from '../../src/lib/capabilities.js';

export const ROLES = ['super_admin', 'tenant_admin', 'member'];
export const MODULE_IDS = CAPABILITIES.map((c) => c.id);
/** 创作中心三条快捷链路分别依赖的能力模块 */
export const SHORTCUT_MODULE = { video: 'video-image', voice: 'voice-tts', chat: 'nlp-chat' };

const SESSION_TTL = 12 * 3600000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60000;
const DAY = 86400000;
const TZ_OFFSET = '+08:00'; // 有效期按北京时间的自然日计算

export const dayStart = (d) => Date.parse(`${d}T00:00:00.000${TZ_OFFSET}`);
export const dayEnd = (d) => Date.parse(`${d}T23:59:59.999${TZ_OFFSET}`);
export const toDay = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(dayStart(s));

const fail = (code, message, hint = '', action = 'fix') => new AppError({ code, message, hint, action });
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{2,31}$/;

export function createTenancy({ db, cfg, quota, log = () => {}, now = () => Date.now() }) {
  const cipher = makeCipher(cfg.dataEncryptionKey);
  const failures = new Map(); // 登录失败计数：key -> { n, until }

  const q = (sql) => db.prepare(sql);
  const parseTenant = (t) => t && ({ ...t, modules: JSON.parse(t.modules || '[]'), allow_real: !!t.allow_real, allow_billable: !!t.allow_billable });

  /* ---------------- 日志 ---------------- */
  function writeLog(e) {
    q(`INSERT INTO logs (at, category, action, tenant_id, user_id, username, capability, mode, ok, code, duration_ms, detail, ip)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      now(), e.category || 'usage', e.action, e.tenantId ?? null, e.userId ?? null, e.username ?? null, e.capability ?? null,
      e.mode ?? null, e.ok === false ? 0 : 1, e.code ?? null, e.durationMs ?? null, e.detail ? String(e.detail).slice(0, 300) : null, e.ip ?? null);
  }
  const audit = (actor, action, detail, ip) => writeLog({ category: 'admin', action, tenantId: actor.tenant_id, userId: actor.id, username: actor.username, detail, ip });

  function queryLogs({ tenantId, userId, capability, category, ok, from, to, page = 1, size = 50 } = {}) {
    const where = []; const args = [];
    if (tenantId !== undefined) { if (tenantId === null) where.push('tenant_id IS NULL'); else { where.push('tenant_id = ?'); args.push(tenantId); } }
    if (userId) { where.push('user_id = ?'); args.push(userId); }
    if (capability) { where.push('capability = ?'); args.push(capability); }
    if (category) { where.push('category = ?'); args.push(category); }
    if (ok === true || ok === false) { where.push('ok = ?'); args.push(ok ? 1 : 0); }
    if (isDay(from)) { where.push('at >= ?'); args.push(dayStart(from)); }
    if (isDay(to)) { where.push('at <= ?'); args.push(dayEnd(to)); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = q(`SELECT COUNT(*) AS n FROM logs ${w}`).get(...args).n;
    const s = Math.min(Math.max(Number(size) || 50, 1), 500);
    const p = Math.max(Number(page) || 1, 1);
    const rows = q(`SELECT l.*, t.name AS tenant_name FROM logs l LEFT JOIN tenants t ON t.id = l.tenant_id ${w.replace(/\b(tenant_id|user_id|capability|category|ok|at)\b/g, 'l.$1')} ORDER BY l.id DESC LIMIT ? OFFSET ?`).all(...args, s, (p - 1) * s);
    return { total, page: p, size: s, rows };
  }

  /** 使用统计（全部来自日志，真实数据） */
  function usageStats(tenantId, days = 30) {
    const since = now() - days * DAY;
    const tw = tenantId === undefined ? '' : 'AND tenant_id = ?';
    const args = tenantId === undefined ? [since] : [since, tenantId];
    const totals = q(`SELECT COUNT(*) AS calls, SUM(ok = 0) AS failed, SUM(mode = 'real') AS real_calls, COUNT(DISTINCT user_id) AS active_users
      FROM logs WHERE category = 'usage' AND at >= ? ${tw}`).get(...args);
    const byCap = q(`SELECT capability, COUNT(*) AS n FROM logs WHERE category = 'usage' AND capability IS NOT NULL AND at >= ? ${tw} GROUP BY capability ORDER BY n DESC LIMIT 15`).all(...args);
    return { days, calls: totals.calls || 0, failed: totals.failed || 0, realCalls: totals.real_calls || 0, activeUsers: totals.active_users || 0, byCapability: byCap.map((r) => ({ capability: r.capability, name: capById(r.capability)?.name || r.capability, count: r.n })) };
  }

  function pruneLogs(days = cfg.logRetentionDays || 180) {
    return q('DELETE FROM logs WHERE at < ?').run(now() - days * DAY).changes;
  }

  /* ---------------- 账号与会话 ---------------- */
  const publicUser = (u) => u && ({ id: u.id, tenantId: u.tenant_id, username: u.username, displayName: u.display_name, role: u.role, status: u.status, mustChangePassword: !!u.must_change_pw, lastLoginAt: u.last_login_at, createdAt: u.created_at });

  function tenantState(t) {
    if (!t) return null;
    const n = now();
    const notStarted = n < t.starts_at;
    const expired = n > t.expires_at;
    return {
      id: t.id, name: t.name, plan: t.plan, status: t.status,
      startsAt: t.starts_at, expiresAt: t.expires_at, startsDay: toDay(t.starts_at), expiresDay: toDay(t.expires_at),
      daysLeft: expired ? 0 : Math.ceil((t.expires_at - n) / DAY),
      notStarted, expired, usable: t.status === 'active' && !notStarted && !expired,
      modules: t.modules, allowReal: t.allow_real, allowBillable: t.allow_billable, maxUsers: t.max_users,
    };
  }

  function bootstrap() {
    const has = q(`SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin'`).get().n;
    if (has) return { created: false };
    const { superAdminUsername: u, superAdminPassword: p } = cfg;
    if (!u || !p) { log('[admin] 还没有超级管理员：请设置 SUPER_ADMIN_USERNAME / SUPER_ADMIN_PASSWORD 后重启，或运行 npm run admin -- create-super'); return { created: false, missing: true }; }
    createSuperAdmin(u, p);
    log(`[admin] 已创建超级管理员 ${u}（首次登录需修改密码）`);
    return { created: true };
  }

  function createSuperAdmin(username, password) {
    if (!USERNAME_RE.test(username)) throw fail('INVALID_INPUT', '用户名需以字母开头，3～32 位字母、数字、下划线、点或短横线');
    const bad = passwordProblem(password); if (bad) throw fail('INVALID_INPUT', bad);
    if (q('SELECT 1 FROM users WHERE username = ?').get(username)) throw fail('USERNAME_TAKEN', '用户名已存在');
    q(`INSERT INTO users (id, tenant_id, username, display_name, role, pw_hash, must_change_pw, created_at) VALUES (?, NULL, ?, ?, 'super_admin', ?, 1, ?)`)
      .run(newId('u'), username, '超级管理员', hashPassword(password), now());
  }

  function login({ username, password, ip = '', ua = '' }) {
    const name = String(username || '').trim();
    const key = `${name.toLowerCase()}|${ip}`;
    const f = failures.get(key);
    if (f && f.until > now()) throw fail('LOGIN_LOCKED', '登录失败次数过多，账号已临时锁定。', `请 ${Math.ceil((f.until - now()) / 60000)} 分钟后再试，或联系管理员重置密码。`, 'later');
    const u = q('SELECT * FROM users WHERE username = ?').get(name);
    const okPw = u && verifyPassword(password, u.pw_hash);
    if (!okPw) {
      const n = (f && f.until > now() ? 0 : f?.n || 0) + 1;
      failures.set(key, { n, until: n >= LOCK_AFTER ? now() + LOCK_MS : 0 });
      writeLog({ category: 'auth', action: 'login', ok: false, code: 'BAD_CREDENTIALS', username: name.slice(0, 32), tenantId: u?.tenant_id, userId: u?.id, ip });
      throw fail('BAD_CREDENTIALS', '用户名或密码不正确。', n >= LOCK_AFTER - 1 ? '再输错一次将临时锁定 15 分钟。' : '请检查后重试；忘记密码请联系你的管理员重置。');
    }
    failures.delete(key);
    if (u.status !== 'active') throw fail('ACCOUNT_DISABLED', '这个账号已被停用。', '请联系你的企业管理员。', 'contact');
    if (u.tenant_id) {
      const t = q('SELECT status FROM tenants WHERE id = ?').get(u.tenant_id);
      if (!t || t.status !== 'active') throw fail('TENANT_DISABLED', '你所在的企业账号已停用。', '请联系商予科技商务人员。', 'contact');
    }
    const token = newSessionToken();
    q('INSERT INTO sessions (id_hash, user_id, expires_at, created_at, ip, ua) VALUES (?,?,?,?,?,?)').run(sha256(token), u.id, now() + SESSION_TTL, now(), ip, String(ua).slice(0, 120));
    q('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), u.id);
    q('DELETE FROM sessions WHERE expires_at < ?').run(now());
    writeLog({ category: 'auth', action: 'login', tenantId: u.tenant_id, userId: u.id, username: u.username, ip });
    return { token, user: publicUser(u), maxAgeSec: SESSION_TTL / 1000 };
  }

  /** 由会话令牌解析当前用户；停用账号/停用企业的会话立即失效 */
  function resolveSession(token) {
    if (!token) return null;
    const s = q('SELECT * FROM sessions WHERE id_hash = ?').get(sha256(token));
    if (!s) return null;
    if (s.expires_at < now()) { q('DELETE FROM sessions WHERE id_hash = ?').run(s.id_hash); return null; }
    const u = q('SELECT * FROM users WHERE id = ?').get(s.user_id);
    if (!u || u.status !== 'active') return null;
    let t = null;
    if (u.tenant_id) {
      t = parseTenant(q('SELECT * FROM tenants WHERE id = ?').get(u.tenant_id));
      if (!t || t.status !== 'active') return null;
    }
    if (s.expires_at - now() < SESSION_TTL / 2) q('UPDATE sessions SET expires_at = ? WHERE id_hash = ?').run(now() + SESSION_TTL, s.id_hash);
    return { user: u, tenant: t };
  }

  function logout(token) { if (token) q('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token)); }

  function changePassword(user, oldPw, newPw, keepToken) {
    if (!verifyPassword(oldPw, user.pw_hash)) throw fail('BAD_CREDENTIALS', '当前密码不正确。');
    const bad = passwordProblem(newPw); if (bad) throw fail('INVALID_INPUT', bad);
    if (oldPw === newPw) throw fail('INVALID_INPUT', '新密码不能与当前密码相同');
    q('UPDATE users SET pw_hash = ?, must_change_pw = 0 WHERE id = ?').run(hashPassword(newPw), user.id);
    q('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(user.id, sha256(keepToken || '')); // 其他设备下线
    writeLog({ category: 'auth', action: 'change_password', tenantId: user.tenant_id, userId: user.id, username: user.username });
  }

  /* ---------------- 客户（租户） ---------------- */
  function validateTenantInput(input, existing) {
    const out = {};
    if (input.name !== undefined || !existing) {
      const name = String(input.name || '').trim();
      if (name.length < 2 || name.length > 60) throw fail('INVALID_INPUT', '客户名称需 2～60 个字');
      out.name = name;
    }
    if (input.contact !== undefined) out.contact = String(input.contact).trim().slice(0, 60);
    if (input.note !== undefined) out.note = String(input.note).trim().slice(0, 300);
    if (input.plan !== undefined || !existing) {
      const plan = input.plan || 'trial';
      if (!['trial', 'formal'].includes(plan)) throw fail('INVALID_INPUT', '客户类型只能是体验或正式');
      out.plan = plan;
    }
    if (input.startsDay !== undefined || !existing) {
      if (!isDay(input.startsDay)) throw fail('INVALID_INPUT', '请选择开始日期');
      out.starts_at = dayStart(input.startsDay);
    }
    if (input.expiresDay !== undefined || !existing) {
      if (!isDay(input.expiresDay)) throw fail('INVALID_INPUT', '请选择到期日期');
      out.expires_at = dayEnd(input.expiresDay);
    }
    const s = out.starts_at ?? existing?.starts_at; const e = out.expires_at ?? existing?.expires_at;
    if (e < s) throw fail('INVALID_INPUT', '到期日期不能早于开始日期');
    if (input.status !== undefined) {
      if (!['active', 'disabled'].includes(input.status)) throw fail('INVALID_INPUT', '状态不合法');
      out.status = input.status;
    }
    if (input.maxUsers !== undefined || !existing) {
      const n = Number(input.maxUsers ?? 10);
      if (!Number.isInteger(n) || n < 1 || n > 10000) throw fail('INVALID_INPUT', '成员上限需为 1～10000 的整数');
      out.max_users = n;
    }
    if (input.modules !== undefined || !existing) {
      const mods = [...new Set(Array.isArray(input.modules) ? input.modules : [])];
      const bad = mods.filter((m) => !MODULE_IDS.includes(m));
      if (bad.length) throw fail('INVALID_INPUT', `未知模块：${bad.join('、')}`);
      if (!mods.length) throw fail('INVALID_INPUT', '至少开通一个模块');
      out.modules = JSON.stringify(mods);
    }
    if (input.allowReal !== undefined) out.allow_real = input.allowReal ? 1 : 0;
    if (input.allowBillable !== undefined) out.allow_billable = input.allowBillable ? 1 : 0;
    if (input.vendorId !== undefined) {
      const v = input.vendorId || null;
      if (v && v !== 'env' && !q('SELECT 1 FROM vendors WHERE id = ?').get(v)) throw fail('INVALID_INPUT', '所选厂商凭据不存在');
      if (v === 'env' && !cfg.realAvailable) throw fail('INVALID_INPUT', '服务端环境变量里没有配置默认厂商凭据');
      out.vendor_id = v;
    }
    const allowReal = out.allow_real ?? existing?.allow_real;
    const vendor = out.vendor_id !== undefined ? out.vendor_id : existing?.vendor_id;
    if (allowReal && !vendor) throw fail('INVALID_INPUT', '开通真实环境前，请先为客户分配厂商凭据');
    return out;
  }

  function tenantRow(id) {
    const t = parseTenant(q('SELECT * FROM tenants WHERE id = ?').get(id));
    if (!t) throw E.notFound('客户不存在。', '可能已被删除，请刷新列表。');
    return t;
  }

  function tenantView(t) {
    const users = q(`SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?`).get(t.id).n;
    const calls = q(`SELECT COUNT(*) AS n FROM logs WHERE tenant_id = ? AND category = 'usage' AND at >= ?`).get(t.id, now() - 30 * DAY).n;
    return { ...tenantState(t), contact: t.contact, note: t.note, vendorId: t.vendor_id, vendorName: vendorName(t.vendor_id), userCount: users, calls30d: calls, createdAt: t.created_at, updatedAt: t.updated_at };
  }

  function listTenants() { return q('SELECT * FROM tenants ORDER BY created_at DESC').all().map((t) => tenantView(parseTenant(t))); }
  function getTenant(id) { return tenantView(tenantRow(id)); }

  function createTenant(actor, input, ip) {
    const data = validateTenantInput(input, null);
    if (q('SELECT 1 FROM tenants WHERE name = ?').get(data.name)) throw fail('TENANT_EXISTS', '已有同名客户');
    const admin = input.admin || {};
    if (!USERNAME_RE.test(admin.username || '')) throw fail('INVALID_INPUT', '管理员用户名需以字母开头，3～32 位字母、数字、下划线、点或短横线');
    if (q('SELECT 1 FROM users WHERE username = ?').get(admin.username)) throw fail('USERNAME_TAKEN', `用户名 ${admin.username} 已被使用`);
    const id = newId('t');
    const initialPw = generatePassword();
    tx(db, () => {
      q(`INSERT INTO tenants (id, name, contact, plan, starts_at, expires_at, status, max_users, modules, allow_real, allow_billable, vendor_id, note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?)`).run(id, data.name, data.contact || '', data.plan, data.starts_at, data.expires_at, data.max_users, data.modules,
        data.allow_real || 0, data.allow_billable || 0, data.vendor_id ?? null, data.note || '', now(), now());
      q(`INSERT INTO users (id, tenant_id, username, display_name, role, pw_hash, must_change_pw, created_at, created_by) VALUES (?,?,?,?,'tenant_admin',?,1,?,?)`)
        .run(newId('u'), id, admin.username, String(admin.displayName || '管理员').slice(0, 30), hashPassword(initialPw), now(), actor.id);
    });
    audit(actor, 'tenant.create', `创建客户「${data.name}」，管理员 ${admin.username}，有效期至 ${toDay(data.expires_at)}`, ip);
    return { tenant: getTenant(id), admin: { username: admin.username, initialPassword: initialPw } };
  }

  function updateTenant(actor, id, input, ip) {
    const t = tenantRow(id);
    const data = validateTenantInput(input, t);
    if (data.vendor_id !== undefined && data.vendor_id !== t.vendor_id && quota?.hasRemaining(id)) {
      throw fail('QUOTA_BOUND', '这个客户还有未用完的额度，暂时不能更换厂商凭据。', '额度来自原凭据的额度池：先在「额度」里回收剩余额度，再更换凭据并重新分配。');
    }
    if (data.name && data.name !== t.name && q('SELECT 1 FROM tenants WHERE name = ? AND id != ?').get(data.name, id)) throw fail('TENANT_EXISTS', '已有同名客户');
    const cols = Object.keys(data);
    if (cols.length) q(`UPDATE tenants SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => data[c]), now(), id);
    const changes = [];
    if (data.expires_at && data.expires_at !== t.expires_at) changes.push(`到期 ${toDay(t.expires_at)} → ${toDay(data.expires_at)}`);
    if (data.starts_at && data.starts_at !== t.starts_at) changes.push(`开始 ${toDay(t.starts_at)} → ${toDay(data.starts_at)}`);
    if (data.status && data.status !== t.status) changes.push(data.status === 'active' ? '启用' : '停用');
    if (data.modules && data.modules !== JSON.stringify(t.modules)) changes.push(`模块 ${JSON.parse(data.modules).length} 项`);
    if (data.allow_real !== undefined && !!data.allow_real !== t.allow_real) changes.push(data.allow_real ? '开通真实环境' : '关闭真实环境');
    if (data.vendor_id !== undefined && data.vendor_id !== t.vendor_id) changes.push(`厂商凭据 → ${vendorName(data.vendor_id) || '无'}`);
    if (data.plan && data.plan !== t.plan) changes.push(data.plan === 'formal' ? '转为正式客户' : '改为体验客户');
    if (data.status === 'disabled') q('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ?)').run(id);
    audit(actor, 'tenant.update', `「${data.name || t.name}」${changes.join('；') || '更新资料'}`, ip);
    return getTenant(id);
  }

  function deleteTenant(actor, id, ip) {
    const t = tenantRow(id);
    quota?.releaseTenant(actor, t); // 未用完的额度退回厂商池
    q('DELETE FROM tenants WHERE id = ?').run(id); // 成员、会话、API 密钥级联删除；日志与额度流水保留用于审计
    audit(actor, 'tenant.delete', `删除客户「${t.name}」`, ip);
  }

  /* ---------------- 成员 ---------------- */
  function listUsers(tenantId) {
    return q('SELECT * FROM users WHERE tenant_id = ? ORDER BY role DESC, created_at').all(tenantId).map(publicUser);
  }

  function userRow(id) { const u = q('SELECT * FROM users WHERE id = ?').get(id); if (!u) throw E.notFound('账号不存在。', '请刷新列表。'); return u; }

  /** actor 能否管理 target（同企业管理员，或超级管理员） */
  function assertManage(actor, target) {
    if (actor.role === 'super_admin') return;
    if (actor.role !== 'tenant_admin' || target.tenant_id !== actor.tenant_id) throw fail('FORBIDDEN', '没有权限管理这个账号。', '', 'contact');
  }

  function createUser(actor, tenantId, input, ip) {
    const t = tenantRow(tenantId);
    if (actor.role !== 'super_admin' && actor.tenant_id !== tenantId) throw fail('FORBIDDEN', '没有权限。');
    const username = String(input.username || '').trim();
    if (!USERNAME_RE.test(username)) throw fail('INVALID_INPUT', '用户名需以字母开头，3～32 位字母、数字、下划线、点或短横线');
    const role = input.role === 'tenant_admin' ? 'tenant_admin' : 'member';
    const count = q('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?').get(tenantId).n;
    if (count >= t.max_users) throw fail('SEAT_LIMIT', `成员数已达上限（${t.max_users} 人）。`, '可以停用或删除不再使用的账号；需要更多名额请联系商予科技。', 'contact');
    if (q('SELECT 1 FROM users WHERE username = ?').get(username)) throw fail('USERNAME_TAKEN', `用户名 ${username} 已被使用`, '换一个用户名，比如加上企业缩写。');
    const initialPw = generatePassword();
    const id = newId('u');
    q(`INSERT INTO users (id, tenant_id, username, display_name, role, pw_hash, must_change_pw, created_at, created_by) VALUES (?,?,?,?,?,?,1,?,?)`)
      .run(id, tenantId, username, String(input.displayName || '').trim().slice(0, 30), role, hashPassword(initialPw), now(), actor.id);
    writeLog({ category: 'admin', action: 'user.create', tenantId, userId: actor.id, username: actor.username, detail: `添加${role === 'tenant_admin' ? '管理员' : '成员'} ${username}`, ip });
    return { user: publicUser(userRow(id)), initialPassword: initialPw };
  }

  function updateUser(actor, id, input, ip) {
    const u = userRow(id); assertManage(actor, u);
    if (u.role === 'super_admin') throw fail('FORBIDDEN', '不能在这里修改超级管理员。');
    const patch = {};
    if (input.displayName !== undefined) patch.display_name = String(input.displayName).trim().slice(0, 30);
    if (input.status !== undefined) {
      if (!['active', 'disabled'].includes(input.status)) throw fail('INVALID_INPUT', '状态不合法');
      if (u.id === actor.id && input.status === 'disabled') throw fail('INVALID_INPUT', '不能停用自己的账号');
      patch.status = input.status;
    }
    if (input.role !== undefined) {
      if (!['tenant_admin', 'member'].includes(input.role)) throw fail('INVALID_INPUT', '角色不合法');
      if (u.id === actor.id && input.role !== u.role) throw fail('INVALID_INPUT', '不能修改自己的角色');
      patch.role = input.role;
    }
    const cols = Object.keys(patch);
    if (cols.length) q(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => patch[c]), id);
    if (patch.status === 'disabled') q('DELETE FROM sessions WHERE user_id = ?').run(id);
    writeLog({ category: 'admin', action: 'user.update', tenantId: u.tenant_id, userId: actor.id, username: actor.username, detail: `${u.username}：${[patch.status && (patch.status === 'active' ? '启用' : '停用'), patch.role && (patch.role === 'tenant_admin' ? '设为管理员' : '设为成员'), patch.display_name !== undefined && '改名'].filter(Boolean).join('、') || '无变化'}`, ip });
    return publicUser(userRow(id));
  }

  function resetPassword(actor, id, ip) {
    const u = userRow(id); assertManage(actor, u);
    if (u.role === 'super_admin') throw fail('FORBIDDEN', '超级管理员请使用命令行重置密码。');
    const initialPw = generatePassword();
    q('UPDATE users SET pw_hash = ?, must_change_pw = 1 WHERE id = ?').run(hashPassword(initialPw), id);
    q('DELETE FROM sessions WHERE user_id = ?').run(id);
    writeLog({ category: 'admin', action: 'user.reset_password', tenantId: u.tenant_id, userId: actor.id, username: actor.username, detail: `重置 ${u.username} 的密码`, ip });
    return { username: u.username, initialPassword: initialPw };
  }

  function deleteUser(actor, id, ip) {
    const u = userRow(id); assertManage(actor, u);
    if (u.id === actor.id) throw fail('INVALID_INPUT', '不能删除自己的账号');
    if (u.role === 'super_admin') throw fail('FORBIDDEN', '不能删除超级管理员');
    if (u.role === 'tenant_admin' && q(`SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = 'tenant_admin' AND status = 'active'`).get(u.tenant_id).n <= 1) {
      throw fail('INVALID_INPUT', '这是企业唯一的管理员，不能删除。', '先把另一位成员设为管理员。');
    }
    q('DELETE FROM users WHERE id = ?').run(id);
    writeLog({ category: 'admin', action: 'user.delete', tenantId: u.tenant_id, userId: actor.id, username: actor.username, detail: `删除 ${u.username}`, ip });
  }

  /* ---------------- 厂商凭据 ---------------- */
  function vendorName(id) {
    if (!id) return '';
    if (id === 'env') return '默认凭据（服务端环境变量）';
    return q('SELECT name FROM vendors WHERE id = ?').get(id)?.name || '（已删除）';
  }
  const vendorView = (v) => ({ id: v.id, name: v.name, appIdMasked: maskValue(v.app_id), baseUrl: v.base_url, ttsConfigured: !!v.tts_qid, avatarImageConfigured: !!v.avatar_image_url, note: v.note, updatedAt: v.updated_at, tenantCount: q('SELECT COUNT(*) AS n FROM tenants WHERE vendor_id = ?').get(v.id).n });

  function listVendors() {
    const rows = q('SELECT * FROM vendors ORDER BY created_at').all().map(vendorView);
    if (cfg.realAvailable) rows.unshift({ id: 'env', name: vendorName('env'), appIdMasked: maskValue(cfg.appId), baseUrl: cfg.baseUrl, ttsConfigured: !!cfg.ttsQid, avatarImageConfigured: !!cfg.avatarImageUrl, note: '来自服务端 .env / 环境变量，只读', readonly: true, tenantCount: q(`SELECT COUNT(*) AS n FROM tenants WHERE vendor_id = 'env'`).get().n });
    return { vendors: rows, encryptionReady: !!cipher };
  }

  function saveVendor(actor, id, input, ip) {
    if (!cipher) throw fail('ENCRYPTION_NOT_CONFIGURED', '服务端未配置数据加密密钥，不能保存厂商凭据。', '请管理员在服务端设置 DATA_ENCRYPTION_KEY 后重启。', 'config');
    if (id === 'env') throw fail('FORBIDDEN', '默认凭据来自服务端环境变量，只能在服务器上修改。');
    const existing = id ? q('SELECT * FROM vendors WHERE id = ?').get(id) : null;
    if (id && !existing) throw E.notFound('厂商凭据不存在。');
    const name = String(input.name ?? existing?.name ?? '').trim();
    const appId = String(input.appId ?? '').trim() || existing?.app_id;
    const appKey = String(input.appKey ?? '').trim();
    if (name.length < 2) throw fail('INVALID_INPUT', '请填写凭据名称，如「如影-主账号」');
    if (!appId) throw fail('INVALID_INPUT', '请填写 APP_ID');
    if (!existing && !appKey) throw fail('INVALID_INPUT', '请填写 APP_KEY');
    const baseUrl = String(input.baseUrl || existing?.base_url || 'https://aigc.softsugar.com').trim().replace(/\/+$/, '');
    if (!/^https:\/\//.test(baseUrl)) throw fail('INVALID_INPUT', '平台地址需以 https:// 开头');
    const ttsQid = String(input.ttsQid ?? existing?.tts_qid ?? '').trim();
    const img = String(input.avatarImageUrl ?? existing?.avatar_image_url ?? '').trim();
    if (img && !/^https?:\/\//.test(img)) throw fail('INVALID_INPUT', '形象图地址需以 http(s):// 开头');
    const enc = appKey ? cipher.encrypt(appKey) : existing.app_key_enc;
    if (existing) {
      q('UPDATE vendors SET name=?, app_id=?, app_key_enc=?, base_url=?, tts_qid=?, avatar_image_url=?, note=?, updated_at=? WHERE id=?')
        .run(name, appId, enc, baseUrl, ttsQid, img, String(input.note ?? existing.note ?? '').slice(0, 200), now(), id);
    } else {
      id = newId('v');
      q('INSERT INTO vendors (id, name, app_id, app_key_enc, base_url, tts_qid, avatar_image_url, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, name, appId, enc, baseUrl, ttsQid, img, String(input.note || '').slice(0, 200), now(), now());
    }
    audit(actor, existing ? 'vendor.update' : 'vendor.create', `${existing ? '更新' : '添加'}厂商凭据「${name}」${appKey && existing ? '（更换 APP_KEY）' : ''}`, ip);
    return vendorView(q('SELECT * FROM vendors WHERE id = ?').get(id));
  }

  function deleteVendor(actor, id, ip) {
    if (id === 'env') throw fail('FORBIDDEN', '默认凭据来自服务端环境变量，不能在这里删除。');
    const v = q('SELECT * FROM vendors WHERE id = ?').get(id);
    if (!v) throw E.notFound('厂商凭据不存在。');
    const n = q('SELECT COUNT(*) AS n FROM tenants WHERE vendor_id = ?').get(id).n;
    if (n) throw fail('VENDOR_IN_USE', `还有 ${n} 个客户在使用这份凭据。`, '先在客户设置里改用其他凭据。');
    q('DELETE FROM vendors WHERE id = ?').run(id);
    q('DELETE FROM quota_vendor WHERE vendor_id = ?').run(id); // 流水保留
    audit(actor, 'vendor.delete', `删除厂商凭据「${v.name}」`, ip);
  }

  /** 真实模式使用的平台配置（含明文密钥，仅服务端内部使用） */
  function vendorConfig(vendorId) {
    if (!vendorId) return null;
    if (vendorId === 'env') return cfg.realAvailable ? { key: 'env', appId: cfg.appId, appKey: cfg.appKey, baseUrl: cfg.baseUrl, ttsQid: cfg.ttsQid, avatarImageUrl: cfg.avatarImageUrl } : null;
    const v = q('SELECT * FROM vendors WHERE id = ?').get(vendorId);
    if (!v || !cipher) return null;
    let appKey;
    try { appKey = cipher.decrypt(v.app_key_enc); } catch { log(`[vendor] ${v.name} 的 APP_KEY 无法解密（DATA_ENCRYPTION_KEY 是否更换过？）`); return null; }
    return { key: `${v.id}:${v.updated_at}`, appId: v.app_id, appKey, baseUrl: v.base_url, ttsQid: v.tts_qid, avatarImageUrl: v.avatar_image_url };
  }

  /* ---------------- 权限判定 ---------------- */
  /**
   * 计算一次请求的访问范围：
   *   guest        访客（未登录）：仅演示环境，模块全开（可由 PUBLIC_DEMO=false 关闭）
   *   super_admin  全部模块；真实环境使用服务端默认凭据
   *   tenant user  按企业开通的模块与有效期；真实环境需开通且分配了厂商凭据
   */
  function accessOf(sess) {
    if (!sess) {
      return { kind: 'guest', allowed: cfg.publicDemo, modules: cfg.publicDemo ? MODULE_IDS : [], canReal: false, vendorId: null, workspace: null };
    }
    const { user, tenant } = sess;
    if (user.role === 'super_admin') return { kind: 'super', allowed: true, modules: MODULE_IDS, canReal: cfg.realAvailable, vendorId: cfg.realAvailable ? 'env' : null, canBill: cfg.allowBillable, workspace: `u-${user.id}` };
    const st = tenantState(tenant);
    const vendorOk = !!vendorConfig(tenant.vendor_id);
    return {
      kind: 'tenant', allowed: st.usable, tenant: st, modules: tenant.modules,
      canReal: st.usable && tenant.allow_real && vendorOk, realReason: !tenant.allow_real ? '你的企业未开通真实环境' : !vendorOk ? '你的企业尚未分配厂商凭据' : '',
      vendorId: tenant.vendor_id, canBill: cfg.allowBillable && tenant.allow_billable, workspace: `t-${tenant.id}`,
    };
  }

  /** 校验某个模块是否可用，不可用时抛出可读错误 */
  function assertModule(access, moduleId) {
    if (access.kind === 'guest' && !access.allowed) throw fail('LOGIN_REQUIRED', '请先登录。', '工作台仅向已开通的客户开放，账号请联系你的企业管理员。', 'login');
    if (access.kind === 'tenant' && !access.allowed) {
      const t = access.tenant;
      if (t.notStarted) throw fail('TENANT_NOT_STARTED', `你的企业账号将于 ${t.startsDay} 开通。`, '开通后即可使用。', 'contact');
      throw fail('TENANT_EXPIRED', `你的企业账号已于 ${t.expiresDay} 到期。`, '需要继续使用请联系商予科技商务人员续期；到期前生成的作品不受影响。', 'contact');
    }
    if (moduleId && !access.modules.includes(moduleId)) {
      throw fail('MODULE_FORBIDDEN', `你的企业未开通「${capById(moduleId)?.name || moduleId}」。`, '如需使用，请联系你的企业管理员或商予科技开通。', 'contact');
    }
  }

  /* ---------------- 开放接口密钥（B 签发给客户的 API Token） ---------------- */
  const MAX_KEYS = 10;
  const keyView = (k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.created_at, expiresAt: k.expires_at, expiresDay: k.expires_at ? toDay(k.expires_at) : null,
    lastUsedAt: k.last_used_at, revokedAt: k.revoked_at, status: k.revoked_at ? 'revoked' : k.expires_at && k.expires_at < now() ? 'expired' : 'active' });

  function listKeys(tenantId) { return q('SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC').all(tenantId).map(keyView); }

  function createKey(actor, tenantId, input, ip) {
    const t = tenantRow(tenantId);
    if (actor.role !== 'super_admin' && !(actor.role === 'tenant_admin' && actor.tenant_id === tenantId)) throw fail('FORBIDDEN', '没有权限。');
    const name = String(input.name || '').trim();
    if (name.length < 2 || name.length > 40) throw fail('INVALID_INPUT', '请给密钥起个 2～40 字的名字，如「官网后台」');
    let expiresAt = null;
    if (input.expiresDay) { if (!isDay(input.expiresDay)) throw fail('INVALID_INPUT', '有效期日期格式不正确'); expiresAt = dayEnd(input.expiresDay); if (expiresAt < now()) throw fail('INVALID_INPUT', '有效期不能早于今天'); }
    const active = q('SELECT COUNT(*) AS n FROM api_keys WHERE tenant_id = ? AND revoked_at IS NULL').get(tenantId).n;
    if (active >= MAX_KEYS) throw fail('KEY_LIMIT', `每个企业最多 ${MAX_KEYS} 个有效密钥。`, '先吊销不再使用的密钥。');
    const secret = `ry_${newSessionToken()}`;
    const id = newId('k');
    q('INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, created_at, created_by, expires_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, tenantId, name, `${secret.slice(0, 9)}…${secret.slice(-4)}`, sha256(secret), now(), actor.id, expiresAt);
    writeLog({ category: 'admin', action: 'key.create', tenantId, userId: actor.id, username: actor.username, detail: `签发 API 密钥「${name}」${expiresAt ? `，有效期至 ${toDay(expiresAt)}` : ''}（${t.name}）`, ip });
    return { key: keyView(q('SELECT * FROM api_keys WHERE id = ?').get(id)), secret };
  }

  function revokeKey(actor, id, ip) {
    const k = q('SELECT * FROM api_keys WHERE id = ?').get(id);
    if (!k) throw E.notFound('密钥不存在。');
    if (actor.role !== 'super_admin' && !(actor.role === 'tenant_admin' && actor.tenant_id === k.tenant_id)) throw fail('FORBIDDEN', '没有权限。');
    if (!k.revoked_at) q('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(now(), id);
    writeLog({ category: 'admin', action: 'key.revoke', tenantId: k.tenant_id, userId: actor.id, username: actor.username, detail: `吊销 API 密钥「${k.name}」`, ip });
    return keyView(q('SELECT * FROM api_keys WHERE id = ?').get(id));
  }

  /** 校验开放接口密钥；返回 { key, tenant, access } 或抛出可读错误 */
  function resolveKey(secret) {
    const bad = (code, message, hint) => fail(code, message, hint, 'config');
    if (!secret || !/^ry_[A-Za-z0-9_-]{20,}$/.test(secret)) throw bad('INVALID_API_KEY', 'API 密钥无效。', '请在请求头携带 Authorization: Bearer <你的密钥>。');
    const k = q('SELECT * FROM api_keys WHERE key_hash = ?').get(sha256(secret));
    if (!k) throw bad('INVALID_API_KEY', 'API 密钥无效。', '请检查密钥是否复制完整，或向企业管理员申请新的密钥。');
    if (k.revoked_at) throw bad('API_KEY_REVOKED', 'API 密钥已被吊销。', '请向企业管理员申请新的密钥。');
    if (k.expires_at && k.expires_at < now()) throw bad('API_KEY_EXPIRED', `API 密钥已于 ${toDay(k.expires_at)} 过期。`, '请向企业管理员申请新的密钥。');
    const t = parseTenant(q('SELECT * FROM tenants WHERE id = ?').get(k.tenant_id));
    if (!t || t.status !== 'active') throw fail('TENANT_DISABLED', '企业账号已停用。', '请联系商予科技。', 'contact');
    if (!k.last_used_at || now() - k.last_used_at > 60000) q('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), k.id);
    return { key: keyView(k), keyName: k.name, tenant: t, access: accessOf({ user: { role: 'member' }, tenant: t }) };
  }

  const tenantRaw = (id) => parseTenant(q('SELECT * FROM tenants WHERE id = ?').get(id));

  return {
    listKeys, createKey, revokeKey, resolveKey, tenantRaw,
    bootstrap, createSuperAdmin, login, resolveSession, logout, changePassword, publicUser, tenantState,
    listTenants, getTenant, createTenant, updateTenant, deleteTenant,
    listUsers, createUser, updateUser, resetPassword, deleteUser,
    listVendors, saveVendor, deleteVendor, vendorConfig,
    accessOf, assertModule, writeLog, queryLogs, usageStats, pruneLogs, audit,
  };
}
