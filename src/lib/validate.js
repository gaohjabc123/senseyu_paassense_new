// validate.js —— 表单校验规则（纯函数，无 DOM）。
// 规则与服务端逐条对齐：server/lib/tenancy.mjs（USERNAME_RE、客户名称、日期、成员上限）、server/lib/secrets.mjs（passwordProblem）。
// 改服务端规则时请同步这里；前端校验只用来"更早地提示"，最终以服务端为准。

export const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{2,31}$/;
export const USERNAME_MSG = '用户名需以字母开头，3～32 位字母、数字、下划线、点或短横线';

export function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 8) return '密码至少 8 位';
  if (s.length > 64) return '密码最多 64 位';
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return '密码需要同时包含字母和数字';
  return '';
}

// 与服务端 tenancy.mjs 的 isDay / dayStart 逐字同构（含 +08:00 后缀）：同一个字符串，前后端对「合法日期」的结论必须一致，
// 不依赖不同引擎对 2月30日 这类越界日期的处理差异
const TZ_OFFSET = '+08:00';
const dayStart = (d) => Date.parse(`${d}T00:00:00.000${TZ_OFFSET}`);
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(dayStart(s));

/** 登录：只检查非空（不在前端暴露密码规则，避免对已有账号造成误导） */
export function validateLogin(f) {
  const e = {};
  if (!String(f.username || '').trim()) e['login-user'] = '请输入用户名';
  if (!f.password) e['login-pass'] = '请输入密码';
  return e;
}

/** 修改密码 */
export function validatePassword(f) {
  const e = {};
  if (!f.old) e['pw-old'] = '请输入当前密码';
  if (!f.next) e['pw-new'] = '请输入新密码';
  else { const p = passwordProblem(f.next); if (p) e['pw-new'] = p; else if (f.old && f.next === f.old) e['pw-new'] = '新密码不能与当前密码相同'; }
  if (!f.again) e['pw-again'] = '请再次输入新密码';
  else if (f.next && f.again !== f.next) e['pw-again'] = '两次输入的新密码不一致';
  return e;
}

/** 新建 / 编辑客户 */
export function validateTenant(f, isNew) {
  const e = {};
  const name = String(f.name || '').trim();
  if (name.length < 2 || name.length > 60) e['tf-name'] = '客户名称需 2～60 个字';
  const n = Number(f.maxUsers);
  if (f.maxUsers === '' || !Number.isInteger(n) || n < 1 || n > 10000) e['tf-max'] = '成员上限需为 1～10000 的整数';
  if (!isDay(f.startsDay)) e['tf-start'] = '请选择开始日期';
  if (!isDay(f.expiresDay)) e['tf-end'] = '请选择到期日期';
  else if (isDay(f.startsDay) && f.expiresDay < f.startsDay) e['tf-end'] = '到期日期不能早于开始日期';
  if (!Array.isArray(f.modules) || !f.modules.length) e['tf-modules'] = '至少开通一个模块';
  if (isNew && !USERNAME_RE.test(String(f.adminUsername || '').trim())) e['tf-admin'] = USERNAME_MSG;
  return e;
}

/** 单字段校验（失焦时用）：从整表结果里取该字段 */
export const pick = (errors, id) => errors[id] || '';

/* ============ 其余后台表单（规则对齐 server/lib/tenancy.mjs · quota.mjs · teaching.mjs） ============ */
export const PREFIX_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,11}$/;
export const PREFIX_MSG = '用户名前缀需以字母开头，最多 12 位字母、数字、下划线、点或短横线';
export const IMPORT_MAX = 100;

/** 新建账号（单个） */
export function validateUserCreate(f) {
  const e = {};
  if (!USERNAME_RE.test(String(f.username || '').trim())) e['nu-name'] = USERNAME_MSG;
  if (String(f.displayName || '').trim().length > 30) e['nu-display'] = '姓名最多 30 个字';
  return e;
}

/** 批量导入：rows 是 parseRoster 的结果；返回字段错误 + 逐行问题（最多列 5 条，其余折叠） */
export function validateImport(f, rows, { school = false } = {}) {
  const e = {};
  const prefix = String(f.prefix || '').trim();
  if (prefix && !PREFIX_RE.test(prefix)) e['imp-prefix'] = PREFIX_MSG;
  if (!rows.length) e['imp-text'] = '名单是空的：每行一个账号，用户名（或学号）, 姓名, 班级';
  else if (rows.length > IMPORT_MAX) e['imp-text'] = `一次最多导入 ${IMPORT_MAX} 个账号，现在 ${rows.length} 个，请按班级分批导入`;
  else {
    const seen = new Map(); const bad = [];
    rows.forEach((r, i) => {
      const line = `第 ${i + 1} 行`; const u = prefix + String(r.username || '').trim();
      if (!USERNAME_RE.test(u)) bad.push(`${line}：用户名「${u.slice(0, 20)}」不合法${/^\d/.test(u) && !prefix ? '（学号是纯数字时请填写用户名前缀）' : ''}`);
      else { const k = u.toLowerCase(); if (seen.has(k)) bad.push(`${line}：用户名 ${u} 与第 ${seen.get(k)} 行重复`); else seen.set(k, i + 1); }
      if (school && String(r.className || '').trim().length > 40) bad.push(`${line}：班级名称最多 40 个字`);
    });
    if (bad.length) e['imp-text'] = bad.slice(0, 5).join('；') + (bad.length > 5 ? `；……另有 ${bad.length - 5} 处` : '');
  }
  return e;
}

/** 新建班级 */
export function validateClass(f) {
  const e = {}; const n = String(f.name || '').trim().length;
  if (n < 2 || n > 40) e['cf-name'] = '班级名称需 2～40 个字，例如「2026级数字媒体1班」';
  return e;
}

/** 北京时间的今天（YYYY-MM-DD）：服务端按 +08:00 的自然日算有效期，前端不能用浏览器本地时区 */
export const todayBeijing = (now = Date.now()) => new Date(now + 8 * 3600e3).toISOString().slice(0, 10);

export function validateKey(f, today = todayBeijing()) {
  const e = {}; const n = String(f.name || '').trim().length;
  if (n < 2 || n > 40) e['kf-name'] = '请给密钥起个 2～40 字的名字，如「官网后台」';
  if (f.expiresDay) {
    if (!isDay(f.expiresDay)) e['kf-exp'] = '有效期日期格式不正确';
    else if (f.expiresDay < today) e['kf-exp'] = '有效期不能早于今天';
  }
  return e;
}

/** 额度分配 / 回收：正整数，≤ 1e12 */
export function validateQuota(f) {
  const e = {}; const n = Number(f.amount);
  if (f.amount === '' || f.amount == null) e['qf-amt'] = f.op === 'reclaim' ? '请输入回收数量' : '请输入分配数量';
  else if (!Number.isInteger(n) || n <= 0 || n > 1e12) e['qf-amt'] = `${f.op === 'reclaim' ? '回收' : '分配'}数量需为正整数`;
  return e;
}

/** 登记采购：非零整数，负数为冲减 */
export function validatePurchase(f) {
  const e = {}; const n = Number(f.amount);
  if (f.amount === '' || f.amount == null) e['pf-a'] = '请输入入账数量';
  else if (!Number.isInteger(n) || n === 0) e['pf-a'] = '入账数量需为非零整数（负数表示冲减）';
  return e;
}

/** 厂商凭据：新增时 APP_ID / APP_KEY 必填；编辑时留空表示不修改 */
export function validateVendor(f, isEdit) {
  const e = {};
  if (String(f.name || '').trim().length < 2) e['vf-name'] = '请填写凭据名称，如「如影-主账号」';
  const base = String(f.baseUrl || '').trim();                 // 留空 = 用服务端默认地址，所以只在填了时才校验
  if (base && !/^https:\/\//.test(base)) e['vf-base'] = '平台地址需以 https:// 开头';
  if (!isEdit && !String(f.appId || '').trim()) e['vf-id'] = '请填写 APP_ID';
  if (!isEdit && !String(f.appKey || '').trim()) e['vf-key'] = '请填写 APP_KEY';
  const img = String(f.avatarImageUrl || '').trim();
  if (img && !/^https?:\/\//.test(img)) e['vf-img'] = '形象图地址需以 http(s):// 开头';
  return e;
}
