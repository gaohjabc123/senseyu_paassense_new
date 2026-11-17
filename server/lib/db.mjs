// db.mjs —— 业务数据库（Node 内置 node:sqlite，零第三方依赖）
// 表：tenants 客户 · users 账号 · sessions 登录会话 · vendors 厂商凭据 · logs 使用/审计日志
//     classes 班级（院校客户）· works 作品（服务端持久化，可提交给教师批改）
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS vendors (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, app_id TEXT NOT NULL, app_key_enc TEXT NOT NULL,
    base_url TEXT NOT NULL, tts_qid TEXT DEFAULT '', avatar_image_url TEXT DEFAULT '', note TEXT DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, contact TEXT DEFAULT '', plan TEXT NOT NULL DEFAULT 'trial',
    starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    max_users INTEGER NOT NULL DEFAULT 10, modules TEXT NOT NULL DEFAULT '[]',
    allow_real INTEGER NOT NULL DEFAULT 0, allow_billable INTEGER NOT NULL DEFAULT 0, vendor_id TEXT DEFAULT NULL,
    note TEXT DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, tenant_id TEXT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT DEFAULT '',
    role TEXT NOT NULL, pw_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', must_change_pw INTEGER NOT NULL DEFAULT 1,
    last_login_at INTEGER, created_at INTEGER NOT NULL, created_by TEXT,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, ip TEXT, ua TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, category TEXT NOT NULL, action TEXT NOT NULL,
    tenant_id TEXT, user_id TEXT, username TEXT, capability TEXT, mode TEXT, ok INTEGER NOT NULL DEFAULT 1,
    code TEXT, duration_ms INTEGER, detail TEXT, ip TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_tenant_at ON logs(tenant_id, at)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_at ON logs(at)`,
  // 开放接口密钥：B 签发给客户 C/D 的 API Token（只存哈希）
  `CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL, created_by TEXT, expires_at INTEGER, last_used_at INTEGER, revoked_at INTEGER,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_keys_tenant ON api_keys(tenant_id)`,
  // 额度：厂商池（B 从 A 采购的台账）→ 客户额度（B 分配给 C/D）
  `CREATE TABLE IF NOT EXISTS quota_vendor (vendor_id TEXT NOT NULL, meter TEXT NOT NULL, purchased INTEGER NOT NULL DEFAULT 0, allocated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (vendor_id, meter))`,
  `CREATE TABLE IF NOT EXISTS quota_tenant (tenant_id TEXT NOT NULL, meter TEXT NOT NULL, allocated INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, meter),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS quota_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, meter TEXT NOT NULL, amount INTEGER NOT NULL,
    vendor_id TEXT, tenant_id TEXT, ref TEXT, actor TEXT, note TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_tenant ON quota_ledger(tenant_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_ledger_vendor ON quota_ledger(vendor_id, id)`,
  // 班级：院校客户的教学组织（学校 → 班级 → 学生），每个班可指定一位教师
  `CREATE TABLE IF NOT EXISTS classes (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, teacher_id TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL, created_by TEXT,
    UNIQUE (tenant_id, name),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE)`,
  // 作品：登录用户的产出保存在服务端，换电脑不丢；学生可提交给教师，教师评分与评语
  `CREATE TABLE IF NOT EXISTS works (
    id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT NOT NULL, kind TEXT NOT NULL, type TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', duration REAL, mode TEXT NOT NULL DEFAULT 'mock',
    created_at INTEGER NOT NULL, submitted_at INTEGER, class_id TEXT,
    score INTEGER, comment TEXT, reviewed_by TEXT, reviewed_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`,
  `CREATE INDEX IF NOT EXISTS idx_works_user ON works(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_works_class ON works(class_id, submitted_at)`,
  // 任务中心：平台任务登记（创建即入库，重启不丢；列表/状态筛选/搜索的唯一来源）
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, workspace TEXT NOT NULL, vendor_id TEXT NOT NULL, capability TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '', status INTEGER NOT NULL DEFAULT 1, result TEXT NOT NULL DEFAULT '',
    charge TEXT NOT NULL DEFAULT '', refunded INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace, created_at)`,
  // 直播脚本库：本站自己的存储（文档里没有互动直播脚本的创建/查询/列表接口，
  // 脚本不是平台独立资源：装修脚本随 decoration-tasks 提交，接管脚本随 command/queue 提交）。
  // 存直播脚本编辑器出的脚本（名称/JSON/创建时间），供查看、改名、删除、导出、导入回填编辑器。
  `CREATE TABLE IF NOT EXISTS live_scripts (
    id TEXT PRIMARY KEY, workspace TEXT NOT NULL, name TEXT NOT NULL, script_json TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'editor', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_live_scripts_workspace ON live_scripts(workspace, created_at)`,
];

// 老数据库升级：CREATE TABLE IF NOT EXISTS 不会给已有的表加列，这里按需补列（幂等）
const COLUMNS = [
  ['tenants', 'org_type', `TEXT NOT NULL DEFAULT 'enterprise'`], // enterprise 企业 | vocational 高职 | applied 应用型本科 | university 本科
  ['users', 'class_id', 'TEXT DEFAULT NULL'],
];

function migrate(db) {
  for (const [table, col, ddl] of COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_class ON users(class_id)');
}

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  for (const sql of SCHEMA) db.exec(sql);
  migrate(db);
  return db;
}

/** 在事务里执行 fn，出错回滚 */
export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
