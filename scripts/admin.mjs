#!/usr/bin/env node
// admin.mjs —— 超级管理员命令行（在服务器上执行，不经过网页）
//   npm run admin -- create-super <用户名>       创建超级管理员（交互输入密码）
//   npm run admin -- reset-super <用户名>        重置超级管理员密码（交互输入）
//   npm run admin -- list-super                  列出超级管理员
// Docker：docker compose -f deploy/docker-compose.yml exec <服务名> node scripts/admin.mjs create-super admin
import readline from 'node:readline';
import { getConfig } from '../server/lib/config.mjs';
import { openDb } from '../server/lib/db.mjs';
import { createTenancy } from '../server/lib/tenancy.mjs';
import { hashPassword, passwordProblem } from '../server/lib/secrets.mjs';

const [cmd, username] = process.argv.slice(2);
const cfg = getConfig();
const db = openDb(cfg.dbFile);
const T = createTenancy({ db, cfg });

function askHidden(prompt) {
  if (process.env.ADMIN_PASSWORD) return Promise.resolve(process.env.ADMIN_PASSWORD); // 非交互（CI）用
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function readPassword() {
  const p1 = await askHidden('输入密码（至少 8 位，含字母和数字）：');
  const bad = passwordProblem(p1);
  if (bad) { console.error(`✘ ${bad}`); process.exit(1); }
  const p2 = await askHidden('再次输入：');
  if (p1 !== p2) { console.error('✘ 两次输入不一致'); process.exit(1); }
  return p1;
}

try {
  if (cmd === 'create-super' && username) {
    T.createSuperAdmin(username, await readPassword());
    console.log(`✔ 已创建超级管理员 ${username}，首次登录需修改密码。`);
  } else if (cmd === 'reset-super' && username) {
    const u = db.prepare(`SELECT id FROM users WHERE username = ? AND role = 'super_admin'`).get(username);
    if (!u) { console.error('✘ 没有这个超级管理员'); process.exit(1); }
    db.prepare('UPDATE users SET pw_hash = ?, must_change_pw = 1, status = ? WHERE id = ?').run(hashPassword(await readPassword()), 'active', u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    console.log(`✔ 已重置 ${username} 的密码，首次登录需修改。`);
  } else if (cmd === 'list-super') {
    for (const u of db.prepare(`SELECT username, status, last_login_at FROM users WHERE role = 'super_admin'`).all()) {
      console.log(`${u.username}\t${u.status}\t最近登录 ${u.last_login_at ? new Date(u.last_login_at).toLocaleString('zh-CN') : '从未'}`);
    }
  } else {
    console.log('用法：npm run admin -- create-super <用户名> | reset-super <用户名> | list-super');
    process.exit(1);
  }
} catch (e) {
  console.error(`✘ ${e.message}`); process.exit(1);
}
