// admin.js —— 登录、账号、超级管理员后台、客户管理员后台（视图 + 控制逻辑）
import { api, toApiError } from './api.js';
import { esc } from './html.js';
import { errorBlock, loadingBlock } from './views.js';
import { ROLE_LABEL } from './product.js';
import { CAPABILITIES, GROUPS, capById } from './capabilities.js';

/* ================= 工具 ================= */
const DAY = 86400000;
const todayStr = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '—');
const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`;

export const ACTION_LABEL = {
  'capability.run': '能力体验', 'video.tts': '视频配音', 'video.create': '生成视频', 'voice.tts': '语音合成', 'task.finish': '任务完成',
  'kb.upload': '上传资料', 'kb.delete': '删除资料', 'kb.chat': '知识库问答', login: '登录', change_password: '修改密码',
  'tenant.create': '创建客户', 'tenant.update': '修改客户', 'tenant.delete': '删除客户', 'user.create': '添加账号', 'user.update': '修改账号',
  'user.reset_password': '重置密码', 'user.delete': '删除账号', 'vendor.create': '添加厂商凭据', 'vendor.update': '修改厂商凭据',
  'vendor.delete': '删除厂商凭据', 'vendor.token': '获取厂商 Token',
  'key.create': '签发 API 密钥', 'key.revoke': '吊销 API 密钥', 'quota.purchase': '采购入账', 'quota.allocate': '分配额度', 'quota.reclaim': '回收额度',
};
const CATEGORY_LABEL = { usage: '门户使用', api: '开放接口', auth: '登录', admin: '管理' };
export const METERS = { video_seconds: { label: '视频时长', unit: '秒' }, tts_chars: { label: '语音合成字数', unit: '字' }, api_calls: { label: '其他能力调用', unit: '次' } };
const LEDGER_KIND = { purchase: '采购入账', allocate: '分配', reclaim: '回收', consume: '消耗', refund: '失败退回' };
const num = (n) => Number(n || 0).toLocaleString('zh-CN');

/** 客户额度表：已分配 / 已用 / 剩余 */
function quotaTable(quota) {
  return `<div class="table-scroll"><table class="table quota-table"><thead><tr><th scope="col">计量项</th><th scope="col">已分配</th><th scope="col">已用</th><th scope="col">剩余</th><th scope="col"><span class="sr-only">用量</span></th></tr></thead><tbody>
    ${Object.entries(METERS).map(([m, d]) => { const q = quota[m] || { allocated: 0, used: 0, remaining: 0 }; const pct = q.allocated ? Math.min(100, Math.round((q.used / q.allocated) * 100)) : 0; const low = q.allocated > 0 && q.remaining < q.allocated * 0.1;
      return `<tr><td>${d.label}</td><td>${num(q.allocated)} ${d.unit}</td><td>${num(q.used)} ${d.unit}</td><td class="${low ? 'warn' : ''}"><b>${num(q.remaining)}</b> ${d.unit}</td>
        <td><span class="meter-bar ${low ? 'is-low' : ''}" role="img" aria-label="已用 ${pct}%"><i style="width:${pct}%"></i></span></td></tr>`; }).join('')}
  </tbody></table></div>`;
}

function ledgerTable(rows, { showTenant = false } = {}) {
  if (!rows?.length) return '<p class="muted">还没有额度流水。</p>';
  return `<div class="table-scroll"><table class="table admin-table"><thead><tr><th scope="col">时间</th>${showTenant ? '<th scope="col">客户</th>' : ''}<th scope="col">类型</th><th scope="col">计量项</th><th scope="col">数量</th><th scope="col">操作人</th><th scope="col">说明</th></tr></thead><tbody>
    ${rows.map((l) => `<tr><td class="nowrap">${fmtTime(l.at)}</td>${showTenant ? `<td>${esc(l.tenant_name || '—')}</td>` : ''}<td>${LEDGER_KIND[l.kind] || l.kind}</td><td>${METERS[l.meter]?.label || l.meter}</td>
      <td class="nowrap ${l.amount < 0 ? 'err' : 'ok'}">${l.amount > 0 ? '+' : ''}${num(l.amount)} ${METERS[l.meter]?.unit || ''}</td><td>${esc(l.actor || '系统')}</td><td class="muted">${esc(l.note || l.ref || '')}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function keysTable(keys, scope) {
  if (!keys?.length) return '<div class="empty"><p class="empty__title">还没有 API 密钥</p><p>签发后，客户就能从自己的系统调用开放接口。</p></div>';
  const st = { active: pill('pill--ok', '有效'), revoked: pill('pill--err', '已吊销'), expired: pill('pill--warn', '已过期') };
  return `<div class="table-scroll"><table class="table admin-table"><thead><tr><th scope="col">名称</th><th scope="col">密钥</th><th scope="col">状态</th><th scope="col">有效期</th><th scope="col">最近使用</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead><tbody>
    ${keys.map((k) => `<tr><td><b>${esc(k.name)}</b><small class="cell-scene">签发于 ${fmtTime(k.createdAt)}</small></td><td><code>${esc(k.prefix)}</code></td><td>${st[k.status]}</td>
      <td>${k.expiresDay ? esc(k.expiresDay) : '长期'}</td><td class="muted">${fmtTime(k.lastUsedAt)}</td>
      <td>${k.status === 'active' ? `<button class="btn btn--sm btn--danger" type="button" data-key-revoke="${k.id}" data-scope="${scope}" data-name="${esc(k.name)}">吊销</button>` : ''}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function keyCreateForm(s, scope) {
  const f = s.adm.keyForm;
  return `<form class="inline-form" data-form="key-create" data-scope="${scope}" novalidate>
    <div class="form-field"><label for="kf-name">密钥名称</label><input class="input" id="kf-name" data-bind="adm.keyForm.name" value="${esc(f.name)}" placeholder="如：官网后台、门店小程序" /></div>
    <div class="form-field"><label for="kf-exp">有效期至（可选）</label><input class="input" type="date" id="kf-exp" data-bind="adm.keyForm.expiresDay" value="${esc(f.expiresDay)}" /></div>
    <div class="form-field form-field--btn"><button class="btn btn--primary" type="submit" ${f.busy ? 'disabled' : ''}>${f.busy ? '签发中…' : '签发密钥'}</button></div>
  </form>${f.error ? errorBlock(f.error) : ''}`;
}

/** 客户状态标签：已停用 / 未开始 / 已到期 / 即将到期 / 正常 */
export function tenantStatusPill(t) {
  if (t.status === 'disabled') return pill('pill--err', '已停用');
  if (t.notStarted) return pill('pill--info', '未开始');
  if (t.expired) return pill('pill--err', '已到期');
  if (t.daysLeft <= 7) return pill('pill--warn', `${t.daysLeft} 天后到期`);
  return pill('pill--ok', `剩余 ${t.daysLeft} 天`);
}
const planLabel = (p) => (p === 'formal' ? '正式' : '体验');

/* ================= 视图：登录与账号 ================= */
export function loginView(s) {
  const f = s.auth;
  return `<div class="auth-wrap"><div class="card auth-card">
    <h1 class="auth-title">登录</h1>
    <p class="muted">客户账号由你的企业管理员或商予科技开通。</p>
    <form class="auth-form" data-form="login" novalidate>
      <div class="form-field"><label for="login-user">用户名</label>
        <input class="input" id="login-user" data-bind="auth.username" autocomplete="username" value="${esc(f.username)}" required /></div>
      <div class="form-field"><label for="login-pass">密码</label>
        <input class="input" id="login-pass" type="password" data-bind="auth.password" autocomplete="current-password" value="${esc(f.password)}" required /></div>
      <button class="btn btn--primary btn--block" type="submit" ${f.busy ? 'disabled aria-busy="true"' : ''}>${f.busy ? '登录中…' : '登录'}</button>
    </form>
    ${f.error ? errorBlock(f.error) : ''}
    ${s.me?.publicDemo !== false ? '<p class="field-hint auth-foot">没有账号？可以先 <a href="#create" data-view="create">体验演示环境</a>，不需要登录。</p>' : ''}
  </div></div>`;
}

export function accountView(s) {
  const u = s.me?.user;
  if (!u) return loginRequired();
  const f = s.pw;
  return `<div class="console">
    ${u.mustChangePassword ? '<div class="alert alert--warn" role="alert"><div class="alert__body"><b>请先修改初始密码</b><p>为了账号安全，首次登录或密码被重置后，需要设置自己的新密码才能继续使用。</p></div></div>' : ''}
    <div class="grid-2">
      <div class="card"><div class="card__title"><h2>账号信息</h2></div>
        <table class="table kv-table"><tbody>
          <tr><th scope="row">用户名</th><td>${esc(u.username)}</td></tr>
          <tr><th scope="row">姓名</th><td>${esc(u.displayName || '—')}</td></tr>
          <tr><th scope="row">角色</th><td>${esc(ROLE_LABEL[u.role] || u.role)}</td></tr>
          ${s.me.tenant ? `<tr><th scope="row">所属企业</th><td>${esc(s.me.tenant.name)}</td></tr>
          <tr><th scope="row">有效期</th><td>${esc(s.me.tenant.startsDay)} 至 ${esc(s.me.tenant.expiresDay)} ${tenantStatusPill(s.me.tenant)}</td></tr>` : ''}
        </tbody></table>
        <div class="actions"><button class="btn" type="button" data-action="logout">退出登录</button></div>
      </div>
      <div class="card"><div class="card__title"><h2>修改密码</h2></div>
        <form data-form="change-pw" novalidate>
          <div class="form-field"><label for="pw-old">当前密码</label><input class="input" id="pw-old" type="password" autocomplete="current-password" data-bind="pw.old" value="${esc(f.old)}" /></div>
          <div class="form-field"><label for="pw-new">新密码</label><input class="input" id="pw-new" type="password" autocomplete="new-password" data-bind="pw.next" value="${esc(f.next)}" aria-describedby="pw-hint" />
            <small class="field-hint" id="pw-hint">至少 8 位，同时包含字母和数字。修改后其他设备上的登录会失效。</small></div>
          <div class="form-field"><label for="pw-again">再次输入新密码</label><input class="input" id="pw-again" type="password" autocomplete="new-password" data-bind="pw.again" value="${esc(f.again)}" /></div>
          <div class="actions"><button class="btn btn--primary" type="submit" ${f.busy ? 'disabled' : ''}>${f.busy ? '保存中…' : '保存新密码'}</button></div>
        </form>
        ${f.error ? errorBlock(f.error) : ''}
      </div>
    </div></div>`;
}

export function loginRequired(text = '这个页面需要登录后查看。') {
  return `<div class="console"><div class="card"><div class="empty"><p class="empty__title">请先登录</p><p>${esc(text)}</p>
    <div class="empty__action"><a class="btn btn--primary btn--sm" href="#login" data-view="login">去登录</a></div></div></div></div>`;
}
const forbidden = () => '<div class="console"><div class="card"><div class="empty"><p class="empty__title">没有权限</p><p>这个页面只对管理员开放。</p></div></div></div>';

/** 一次性显示新账号/重置后的初始密码 */
export function credentialDialog(c) {
  if (c.secret) {
    return `<div class="sheet-mask"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="cred-title">
    <h3 id="cred-title">${esc(c.title)}</h3>
    <p class="muted">这是密钥原文，<b>只显示这一次</b>，关闭后无法再查看。请保存在服务端配置里，不要写进网页或 App 前端代码。</p>
    <p class="secret-box"><code class="cred-pass">${esc(c.secret)}</code></p>
    <div class="actions"><button class="btn btn--primary" type="button" data-action="cred-copy" data-autofocus>复制密钥</button>
      <button class="btn" type="button" data-action="cred-close">我已保存，关闭</button></div></div>`;
  }
  return `<div class="sheet-mask"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="cred-title">
    <h3 id="cred-title">${esc(c.title)}</h3>
    <p class="muted">请把下面的登录信息安全地交给对方。<b>初始密码只显示这一次</b>，对方首次登录后需要修改。</p>
    <table class="table kv-table cred-table"><tbody>
      <tr><th scope="row">登录地址</th><td><code>${esc(location.origin + location.pathname)}#login</code></td></tr>
      <tr><th scope="row">用户名</th><td><code>${esc(c.username)}</code></td></tr>
      <tr><th scope="row">初始密码</th><td><code class="cred-pass">${esc(c.password)}</code></td></tr>
    </tbody></table>
    <div class="actions"><button class="btn btn--primary" type="button" data-action="cred-copy" data-autofocus>复制登录信息</button>
      <button class="btn" type="button" data-action="cred-close">我已保存，关闭</button></div></div>`;
}

/* ================= 视图：共用 ================= */
function statsCards(u) {
  if (!u) return '';
  const top = u.byCapability.slice(0, 5);
  return `<div class="kpi-grid">
      <div class="kpi"><span>近 ${u.days} 天调用</span><b>${u.calls}</b><small>失败 ${u.failed} 次</small></div>
      <div class="kpi"><span>真实环境调用</span><b>${u.realCalls}</b><small>其余为演示环境</small></div>
      <div class="kpi"><span>活跃账号</span><b>${u.activeUsers}</b><small>近 ${u.days} 天有使用记录</small></div>
      <div class="kpi"><span>最常用能力</span><b class="kpi__mode">${esc(top[0]?.name || '—')}</b><small>${top[0] ? `${top[0].count} 次` : '暂无使用记录'}</small></div>
    </div>`;
}

function usersTable(users, { selfId, scope }) {
  if (!users.length) return '<div class="empty"><p class="empty__title">还没有账号</p></div>';
  return `<div class="table-scroll"><table class="table admin-table"><thead><tr><th scope="col">账号</th><th scope="col">角色</th><th scope="col">状态</th><th scope="col">最近登录</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead><tbody>
    ${users.map((u) => `<tr>
      <td><b>${esc(u.username)}</b>${u.displayName ? `<small class="cell-scene">${esc(u.displayName)}</small>` : ''}${u.id === selfId ? ' <span class="tag">我</span>' : ''}</td>
      <td>${esc(ROLE_LABEL[u.role])}</td>
      <td>${u.status === 'active' ? (u.mustChangePassword ? pill('pill--warn', '待改初始密码') : pill('pill--ok', '正常')) : pill('pill--err', '已停用')}</td>
      <td class="muted">${fmtTime(u.lastLoginAt)}</td>
      <td><div class="row-actions">${u.id === selfId ? '' : `
        <button class="btn btn--sm" type="button" data-user-act="reset" data-id="${u.id}" data-scope="${scope}" data-name="${esc(u.username)}">重置密码</button>
        <button class="btn btn--sm" type="button" data-user-act="${u.status === 'active' ? 'disable' : 'enable'}" data-id="${u.id}" data-scope="${scope}" data-name="${esc(u.username)}">${u.status === 'active' ? '停用' : '启用'}</button>
        <button class="btn btn--sm" type="button" data-user-act="${u.role === 'tenant_admin' ? 'demote' : 'promote'}" data-id="${u.id}" data-scope="${scope}" data-name="${esc(u.username)}">${u.role === 'tenant_admin' ? '设为成员' : '设为管理员'}</button>
        <button class="btn btn--sm btn--danger" type="button" data-user-act="delete" data-id="${u.id}" data-scope="${scope}" data-name="${esc(u.username)}">删除</button>`}</div></td>
    </tr>`).join('')}</tbody></table></div>`;
}

function userCreateForm(s, scope, full) {
  const f = s.adm.userForm;
  return `<form class="inline-form" data-form="user-create" data-scope="${scope}" novalidate>
    <div class="form-field"><label for="nu-name">用户名</label><input class="input" id="nu-name" data-bind="adm.userForm.username" value="${esc(f.username)}" placeholder="字母开头，3～32 位" ${full ? 'disabled' : ''} /></div>
    <div class="form-field"><label for="nu-display">姓名（可选）</label><input class="input" id="nu-display" data-bind="adm.userForm.displayName" value="${esc(f.displayName)}" ${full ? 'disabled' : ''} /></div>
    <div class="form-field"><label for="nu-role">角色</label><select class="input" id="nu-role" data-bind="adm.userForm.role" ${full ? 'disabled' : ''}>
      <option value="member" ${f.role !== 'tenant_admin' ? 'selected' : ''}>成员</option><option value="tenant_admin" ${f.role === 'tenant_admin' ? 'selected' : ''}>企业管理员</option></select></div>
    <div class="form-field form-field--btn"><button class="btn btn--primary" type="submit" ${f.busy || full ? 'disabled' : ''}>${f.busy ? '添加中…' : '添加账号'}</button></div>
  </form>
  ${full ? '<p class="field-hint">成员数已达上限，需要更多名额请联系商予科技。</p>' : '<p class="field-hint">添加后会生成一次性初始密码，对方首次登录需要修改。</p>'}
  ${f.error ? errorBlock(f.error) : ''}`;
}

function logsPanel(s, scope) {
  const L = s.adm.logs;
  const f = L.filters;
  const data = L.data;
  const users = scope === 'org' ? (s.adm.orgUsers?.users || []) : [];
  const tenants = scope === 'admin' ? (s.adm.tenants || []) : [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;
  const csv = (scope === 'admin' ? api.admin : api.org).logsCsvUrl(f);
  return `<div class="card"><form class="filter-form" data-form="logs" novalidate>
      ${scope === 'admin' ? `<div class="form-field"><label for="lf-tenant">客户</label><select class="input" id="lf-tenant" data-bind="adm.logs.filters.tenant"><option value="">全部</option><option value="guest" ${f.tenant === 'guest' ? 'selected' : ''}>访客 / 平台</option>${tenants.map((t) => `<option value="${t.id}" ${f.tenant === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>` : ''}
      ${scope === 'org' ? `<div class="form-field"><label for="lf-user">成员</label><select class="input" id="lf-user" data-bind="adm.logs.filters.user"><option value="">全部</option>${users.map((u) => `<option value="${u.id}" ${f.user === u.id ? 'selected' : ''}>${esc(u.displayName || u.username)}</option>`).join('')}</select></div>` : ''}
      <div class="form-field"><label for="lf-cat">类别</label><select class="input" id="lf-cat" data-bind="adm.logs.filters.category"><option value="">全部</option>${Object.entries(CATEGORY_LABEL).map(([k, v]) => `<option value="${k}" ${f.category === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <div class="form-field"><label for="lf-cap">能力</label><select class="input" id="lf-cap" data-bind="adm.logs.filters.capability"><option value="">全部</option>${CAPABILITIES.map((c) => `<option value="${c.id}" ${f.capability === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      <div class="form-field"><label for="lf-ok">结果</label><select class="input" id="lf-ok" data-bind="adm.logs.filters.ok"><option value="">全部</option><option value="1" ${f.ok === '1' ? 'selected' : ''}>成功</option><option value="0" ${f.ok === '0' ? 'selected' : ''}>失败</option></select></div>
      <div class="form-field"><label for="lf-from">开始日期</label><input class="input" type="date" id="lf-from" data-bind="adm.logs.filters.from" value="${esc(f.from)}" /></div>
      <div class="form-field"><label for="lf-to">结束日期</label><input class="input" type="date" id="lf-to" data-bind="adm.logs.filters.to" value="${esc(f.to)}" /></div>
      <div class="form-field form-field--btn"><button class="btn btn--primary" type="submit">查询</button><a class="btn" href="${esc(csv)}" download>导出 CSV</a></div>
    </form></div>
    <div class="card">${!data ? (L.error ? errorBlock(L.error, { retry: 'logs-reload' }) : loadingBlock('正在读取日志…')) : !data.rows.length
      ? '<div class="empty"><p class="empty__title">没有符合条件的记录</p><p>换个日期范围或筛选条件试试。</p></div>'
      : `<p class="muted table-meta">共 ${data.total} 条${L.loading ? ' · 刷新中…' : ''}</p><div class="table-scroll"><table class="table admin-table log-table"><thead><tr>
          <th scope="col">时间</th>${scope === 'admin' ? '<th scope="col">客户</th>' : ''}<th scope="col">账号</th><th scope="col">操作</th><th scope="col">能力</th><th scope="col">环境</th><th scope="col">结果</th><th scope="col">耗时</th><th scope="col">说明</th></tr></thead><tbody>
        ${data.rows.map((r) => `<tr>
          <td class="nowrap">${fmtTime(r.at)}</td>
          ${scope === 'admin' ? `<td>${esc(r.tenant_name || (r.tenant_id ? '（已删除）' : '访客 / 平台'))}</td>` : ''}
          <td>${esc(r.username || '访客')}</td>
          <td>${esc(ACTION_LABEL[r.action] || r.action)}<small class="cell-scene">${CATEGORY_LABEL[r.category] || r.category}</small></td>
          <td>${esc(r.capability ? (capById(r.capability)?.name || r.capability) : '—')}</td>
          <td>${r.mode === 'real' ? '真实' : r.mode === 'mock' ? '演示' : '—'}</td>
          <td>${r.ok ? '<span class="ok">成功</span>' : `<span class="err">失败</span>${r.code ? `<small class="cell-scene">${esc(r.code)}</small>` : ''}`}</td>
          <td class="nowrap">${r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)} 秒` : '—'}</td>
          <td class="muted">${esc(r.detail || '')}</td></tr>`).join('')}</tbody></table></div>
        <div class="pager"><button class="btn btn--sm" type="button" data-action="logs-prev" ${data.page <= 1 ? 'disabled' : ''}>上一页</button>
          <span class="muted">第 ${data.page} / ${pages} 页</span>
          <button class="btn btn--sm" type="button" data-action="logs-next" ${data.page >= pages ? 'disabled' : ''}>下一页</button></div>`}
    </div>`;
}

/* ================= 视图：客户管理员 ================= */
export function orgOverviewView(s) {
  const o = s.adm.orgOverview;
  if (!o) return `<div class="console">${s.adm.error ? errorBlock(s.adm.error, { retry: 'adm-reload' }) : loadingBlock('正在读取企业信息…')}</div>`;
  const t = o.tenant;
  return `<div class="console">
    <div class="grid-2">
      <div class="card"><div class="card__title"><h2>${esc(t.name)}</h2>${tenantStatusPill(t)}</div>
        <div class="expiry-hero ${t.expired ? 'is-expired' : t.daysLeft <= 7 ? 'is-soon' : ''}">
          <span>${t.expired ? '已到期' : t.notStarted ? '尚未开始' : '剩余天数'}</span><b>${t.expired ? 0 : t.daysLeft}</b><small>有效期 ${esc(t.startsDay)} 至 ${esc(t.expiresDay)} · ${planLabel(t.plan)}客户</small></div>
        ${t.expired || t.daysLeft <= 7 ? '<p class="field-hint">需要续期请联系商予科技商务人员；到期后成员将无法使用工作台，管理功能与日志仍可查看。</p>' : ''}
      </div>
      <div class="card"><div class="card__title"><h2>授权概况</h2></div>
        <table class="table kv-table"><tbody>
          <tr><th scope="row">成员</th><td>${t.userCount} / ${t.maxUsers} 人 <a href="#org/users" data-view="org/users">管理成员</a></td></tr>
          <tr><th scope="row">真实环境</th><td>${t.allowReal ? '<span class="ok">已开通</span>' : '<span class="muted">未开通（仅演示环境）</span>'}</td></tr>
          <tr><th scope="row">计费调用</th><td>${t.allowBillable ? '<span class="warn">已允许</span>' : '<span class="muted">未允许</span>'}</td></tr>
        </tbody></table></div>
    </div>
    <div class="card"><div class="card__title"><h2>额度</h2>${o.low?.length ? pill('pill--warn', '余额不足 10%') : ''}</div>
      ${quotaTable(o.quota)}
      <p class="field-hint">额度由商予科技分配，只在真实环境调用时扣减（门户与 API 共用）；演示环境与接口沙箱不扣。调用失败或平台任务失败会自动退回。需要追加请联系商予科技。</p>
      <a class="btn btn--sm" href="#org/api" data-view="org/api">查看额度流水与 API 接入</a></div>
    <div class="card"><div class="card__title"><h2>已开通的能力（${t.modules.length} / ${CAPABILITIES.length}）</h2></div>
      ${GROUPS.map((g) => { const caps = CAPABILITIES.filter((c) => c.group === g.id); const on = caps.filter((c) => t.modules.includes(c.id)); return `<div class="module-row"><b>${esc(g.name)}</b><div>${caps.map((c) => `<span class="mod-chip ${on.includes(c) ? 'is-on' : ''}">${esc(c.name)}${on.includes(c) ? '' : '<span class="sr-only">（未开通）</span>'}</span>`).join('')}</div></div>`; }).join('')}
      <p class="field-hint">灰色为未开通的能力，成员在工作台中看不到也无法调用。需要调整请联系商予科技。</p></div>
    <h2 class="section-title">近 30 天使用</h2>
    ${statsCards(o.usage)}
    <a class="btn" href="#org/logs" data-view="org/logs">查看使用日志</a>
  </div>`;
}

export function orgUsersView(s) {
  const d = s.adm.orgUsers;
  if (!d) return `<div class="console">${s.adm.error ? errorBlock(s.adm.error, { retry: 'adm-reload' }) : loadingBlock('正在读取成员…')}</div>`;
  const full = d.users.length >= d.maxUsers;
  return `<div class="console">
    <div class="card"><div class="card__title"><h2>添加账号</h2>${pill(full ? 'pill--warn' : 'pill--info', `${d.users.length} / ${d.maxUsers} 人`)}</div>${userCreateForm(s, 'org', full)}</div>
    <div class="card"><div class="card__title"><h2>企业成员</h2></div>${usersTable(d.users, { selfId: s.me.user.id, scope: 'org' })}
      <p class="field-hint">停用后对方会立即下线且无法登录；重置密码会生成新的一次性初始密码。企业至少保留一位管理员。</p></div>
  </div>`;
}

export function orgApiView(s) {
  const d = s.adm.orgKeys;
  if (!d) return `<div class="console">${s.adm.error ? errorBlock(s.adm.error, { retry: 'adm-reload' }) : loadingBlock('正在读取…')}</div>`;
  const base = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}open/v1`;
  const allowed = CAPABILITIES.filter((c) => d.modules.includes(c.id));
  return `<div class="console">
    ${d.canReal ? '' : '<div class="alert alert--warn" role="status"><div class="alert__body"><b>你的企业尚未开通真实环境</b><p>现在可以用沙箱联调（请求头加 X-Ruying-Mode: sandbox，返回样例结果、不扣额度）；正式调用需要商予科技开通。</p></div></div>'}
    <div class="card"><div class="card__title"><h2>API 密钥</h2></div>${keysTable(d.keys, 'org')}</div>
    <div class="card"><div class="card__title"><h2>签发新密钥</h2></div>${keyCreateForm(s, 'org')}
      <p class="field-hint">每个接入系统单独一个密钥，泄露时只需吊销那一个。密钥只能在服务端使用。</p></div>
    <div class="card"><div class="card__title"><h2>额度</h2></div>${quotaTable(d.quota)}</div>
    <div class="card"><div class="card__title"><h2>额度流水</h2></div>${s.adm.orgLedger ? ledgerTable(s.adm.orgLedger) : loadingBlock('正在读取流水…')}</div>
    <div class="card api-doc"><div class="card__title"><h2>接入说明</h2></div>
      <table class="table kv-table"><tbody>
        <tr><th scope="row">接口地址</th><td><code>${esc(base)}</code></td></tr>
        <tr><th scope="row">鉴权</th><td>请求头 <code>Authorization: Bearer &lt;API 密钥&gt;</code></td></tr>
        <tr><th scope="row">沙箱</th><td>请求头 <code>X-Ruying-Mode: sandbox</code>：返回样例结果，不扣额度，用于联调</td></tr>
        <tr><th scope="row">限流</th><td>每个密钥每分钟 120 次</td></tr>
        <tr><th scope="row">已开通能力</th><td>${allowed.map((c) => `<code>${esc(c.id)}</code> ${esc(c.name)}`).join('<br>') || '无'}</td></tr>
      </tbody></table>
      <h3 class="doc-h">常用接口</h3>
      <pre class="json-block" tabindex="0"># 账户与剩余额度
curl ${esc(base)}/account -H "Authorization: Bearer $RUYING_API_KEY"

# 语音合成（按字数扣减）
curl -X POST ${esc(base)}/tts -H "Authorization: Bearer $RUYING_API_KEY" \
  -H "Content-Type: application/json" -d '{"text":"欢迎体验如影数字人"}'

# 图片数字人视频（按秒扣减，至少 5 秒；返回 taskId）
curl -X POST ${esc(base)}/videos -H "Authorization: Bearer $RUYING_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"audioUrl":"https://…/voice.mp3","duration":12,"imageUrl":"https://…/portrait.png","name":"新品介绍"}'

# 查询任务（status：1 排队 · 2 生成中 · 5 完成 · 9 失败，失败自动退回额度）
curl ${esc(base)}/tasks/&lt;taskId&gt; -H "Authorization: Bearer $RUYING_API_KEY"

# 通用能力调用（参数见 GET /capabilities）
curl -X POST ${esc(base)}/capabilities/voice-tts/run -H "Authorization: Bearer $RUYING_API_KEY" \
  -H "Content-Type: application/json" -d '{"params":{"text":"你好"}}'</pre>
      <h3 class="doc-h">错误码</h3>
      <div class="table-scroll"><table class="table admin-table"><thead><tr><th scope="col">HTTP</th><th scope="col">code</th><th scope="col">含义</th></tr></thead><tbody>
        ${[['401', 'INVALID_API_KEY / API_KEY_REVOKED / API_KEY_EXPIRED', '密钥无效、已吊销或已过期'], ['402', 'QUOTA_EXHAUSTED', '额度不足'], ['403', 'MODULE_FORBIDDEN', '企业未开通这项能力'], ['403', 'TENANT_EXPIRED', '企业账号已到期'], ['403', 'REAL_NOT_ENABLED', '企业未开通真实环境（可用沙箱）'], ['429', 'RATE_LIMITED', '请求过于频繁'], ['502 / 504', 'UPSTREAM_*', '如影平台暂时异常，已扣额度会自动退回']].map((r) => `<tr><td>${r[0]}</td><td><code>${r[1]}</code></td><td>${r[2]}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="field-hint">所有响应都是 <code>{ code, message, hint, requestId, data }</code>，<code>code</code> 为 0 表示成功；反馈问题时请附上 requestId。</p>
    </div>
  </div>`;
}

export function orgLogsView(s) { return `<div class="console">${logsPanel(s, 'org')}</div>`; }

/* ================= 视图：超级管理员 ================= */
export function adminOverviewView(s) {
  const o = s.adm.overview;
  if (!o) return `<div class="console">${s.adm.error ? errorBlock(s.adm.error, { retry: 'adm-reload' }) : loadingBlock('正在读取运营数据…')}</div>`;
  const t = o.tenants;
  return `<div class="console">
    <div class="kpi-grid">
      <div class="kpi"><span>客户总数</span><b>${t.total}</b><small>体验客户 ${t.trial} 家</small></div>
      <div class="kpi"><span>有效客户</span><b>${t.active}</b><small>在有效期内且未停用</small></div>
      <div class="kpi"><span>已到期</span><b>${t.expired}</b><small><a href="#admin/tenants" data-view="admin/tenants">去续期</a></small></div>
      <div class="kpi"><span>7 天内到期</span><b>${t.expiringSoon.length}</b><small>建议提前跟进</small></div>
    </div>
    ${t.expiringSoon.length ? `<div class="card"><div class="card__title"><h2>即将到期</h2></div><ul class="work-list">${t.expiringSoon.map((x) => `<li class="work-item"><div class="work-item__main"><b>${esc(x.name)}</b><span class="work-item__meta">${esc(x.expiresDay)} 到期 · 剩余 ${x.daysLeft} 天</span></div><a class="btn btn--sm" href="#admin/tenants/${x.id}/edit" data-view="admin/tenants/${x.id}/edit">续期</a></li>`).join('')}</ul></div>` : ''}
    <h2 class="section-title">全平台近 30 天使用</h2>
    ${statsCards(o.usage)}
    ${o.usage.byCapability.length ? `<div class="card"><div class="card__title"><h2>能力调用排行</h2></div><ul class="bar-list">${o.usage.byCapability.map((c) => `<li><span>${esc(c.name)}</span><i style="--w:${Math.round((c.count / o.usage.byCapability[0].count) * 100)}%"></i><b>${c.count}</b></li>`).join('')}</ul></div>` : ''}
    <div class="actions"><a class="btn btn--primary" href="#admin/tenants/new" data-view="admin/tenants/new">新建客户</a><a class="btn" href="#admin/vendors" data-view="admin/vendors">管理厂商凭据</a></div>
  </div>`;
}

export function tenantsView(s) {
  const list = s.adm.tenants;
  if (!list) return `<div class="console">${s.adm.error ? errorBlock(s.adm.error, { retry: 'adm-reload' }) : loadingBlock('正在读取客户…')}</div>`;
  const f = s.adm.tenantFilter;
  const shown = list.filter((t) => (!f.q || t.name.includes(f.q.trim())) && (!f.status
    || (f.status === 'active' && t.usable) || (f.status === 'soon' && t.usable && t.daysLeft <= 7)
    || (f.status === 'expired' && t.expired) || (f.status === 'disabled' && t.status === 'disabled') || (f.status === 'trial' && t.plan === 'trial')));
  return `<div class="console">
    <div class="toolbar">
      <div class="form-field"><label class="sr-only" for="tf-q">搜索客户</label><input class="input" id="tf-q" data-bind="adm.tenantFilter.q" data-live placeholder="搜索客户名称" value="${esc(f.q)}" /></div>
      <div class="form-field"><label class="sr-only" for="tf-status">状态</label><select class="input" id="tf-status" data-bind="adm.tenantFilter.status" data-live>
        ${[['', '全部状态'], ['active', '有效'], ['soon', '7 天内到期'], ['expired', '已到期'], ['disabled', '已停用'], ['trial', '体验客户']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <a class="btn btn--primary" href="#admin/tenants/new" data-view="admin/tenants/new">新建客户</a>
    </div>
    <div class="card">${!list.length ? '<div class="empty"><p class="empty__title">还没有客户</p><p>新建客户时会同时创建它的管理员账号，并设置有效期与可用模块。</p><div class="empty__action"><a class="btn btn--primary btn--sm" href="#admin/tenants/new" data-view="admin/tenants/new">新建第一个客户</a></div></div>'
      : !shown.length ? '<div class="empty"><p class="empty__title">没有符合条件的客户</p></div>'
        : `<div class="table-scroll"><table class="table admin-table"><thead><tr><th scope="col">客户</th><th scope="col">类型</th><th scope="col">有效期</th><th scope="col">状态</th><th scope="col">模块</th><th scope="col">成员</th><th scope="col">近 30 天调用</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead><tbody>
      ${shown.map((t) => `<tr>
        <td><a href="#admin/tenants/${t.id}" data-view="admin/tenants/${t.id}"><b>${esc(t.name)}</b></a>${t.contact ? `<small class="cell-scene">${esc(t.contact)}</small>` : ''}</td>
        <td>${planLabel(t.plan)}${t.allowReal ? '<small class="cell-scene">已开通真实环境</small>' : ''}</td>
        <td class="nowrap">${esc(t.startsDay)}<small class="cell-scene">至 ${esc(t.expiresDay)}</small></td>
        <td>${tenantStatusPill(t)}</td>
        <td>${t.modules.length} / ${CAPABILITIES.length}</td>
        <td>${t.userCount} / ${t.maxUsers}</td>
        <td>${t.calls30d}</td>
        <td><div class="row-actions"><a class="btn btn--sm" href="#admin/tenants/${t.id}" data-view="admin/tenants/${t.id}">详情</a><a class="btn btn--sm" href="#admin/tenants/${t.id}/edit" data-view="admin/tenants/${t.id}/edit">编辑</a></div></td>
      </tr>`).join('')}</tbody></table></div>`}</div>
  </div>`;
}

export function tenantFormView(s) {
  const f = s.adm.form;
  if (!f) return `<div class="console">${s.adm.error ? errorBlock(s.adm.error, { retry: 'adm-reload' }) : loadingBlock('正在读取…')}</div>`;
  const isNew = !f.id;
  const vendors = s.adm.vendors?.vendors || [];
  const quick = [[7, '7 天体验'], [14, '14 天体验'], [30, '30 天'], [365, '1 年']];
  return `<div class="console"><form class="card tenant-form" data-form="tenant" novalidate>
    <nav class="exp-crumb" aria-label="位置"><a href="#admin/tenants" data-view="admin/tenants">客户管理</a><span aria-hidden="true">/</span><b>${isNew ? '新建客户' : esc(f.name)}</b></nav>
    <fieldset><legend>基本信息</legend><div class="form-grid">
      <div class="form-field"><label for="tf-name">客户名称</label><input class="input" id="tf-name" data-bind="adm.form.name" value="${esc(f.name)}" maxlength="60" /></div>
      <div class="form-field"><label for="tf-contact">联系人（可选）</label><input class="input" id="tf-contact" data-bind="adm.form.contact" value="${esc(f.contact)}" maxlength="60" placeholder="如：王经理 / 销售对接人" /></div>
      <div class="form-field"><span class="label">客户类型</span><div class="seg" role="radiogroup" aria-label="客户类型">
        <label><input type="radio" name="tf-plan" value="trial" data-bind="adm.form.plan" ${f.plan === 'trial' ? 'checked' : ''} /> 体验客户</label>
        <label><input type="radio" name="tf-plan" value="formal" data-bind="adm.form.plan" ${f.plan === 'formal' ? 'checked' : ''} /> 正式客户</label></div></div>
      <div class="form-field"><label for="tf-max">成员上限</label><input class="input" id="tf-max" type="number" min="1" max="10000" data-bind="adm.form.maxUsers" value="${esc(f.maxUsers)}" /></div>
      ${isNew ? '' : `<div class="form-field"><span class="label">账号状态</span><div class="seg" role="radiogroup" aria-label="账号状态">
        <label><input type="radio" name="tf-status" value="active" data-bind="adm.form.status" ${f.status === 'active' ? 'checked' : ''} /> 启用</label>
        <label><input type="radio" name="tf-status" value="disabled" data-bind="adm.form.status" ${f.status === 'disabled' ? 'checked' : ''} /> 停用（全员立即下线）</label></div></div>`}
    </div></fieldset>
    <fieldset><legend>体验时间与到期时间</legend><div class="form-grid">
      <div class="form-field"><label for="tf-start">开始日期</label><input class="input" type="date" id="tf-start" data-bind="adm.form.startsDay" value="${esc(f.startsDay)}" /></div>
      <div class="form-field"><label for="tf-end">到期日期（当天 23:59 到期）</label><input class="input" type="date" id="tf-end" data-bind="adm.form.expiresDay" value="${esc(f.expiresDay)}" /></div>
    </div>
    <div class="chip-row" role="group" aria-label="快速设置有效期">${quick.map(([n, l]) => `<button class="chip" type="button" data-quick-days="${n}">${l}</button>`).join('')}
      ${isNew ? '' : '<button class="chip" type="button" data-quick-extend="30">在原到期日上续 30 天</button><button class="chip" type="button" data-quick-extend="365">续 1 年</button>'}</div>
    <p class="field-hint">按北京时间计算。开始日期之前与到期日期之后，该客户的成员无法使用工作台，管理员仍可登录查看日志与到期时间。</p></fieldset>
    <fieldset><legend>模块权限（${f.modules.length} / ${CAPABILITIES.length}）</legend>
      <div class="chip-row"><button class="chip" type="button" data-module-all="1">全部开通</button><button class="chip" type="button" data-module-all="0">全部取消</button></div>
      ${GROUPS.map((g) => { const caps = CAPABILITIES.filter((c) => c.group === g.id); const all = caps.every((c) => f.modules.includes(c.id)); return `<div class="module-group">
        <label class="module-group__head"><input type="checkbox" data-module-group="${g.id}" ${all ? 'checked' : ''} /> <b>${esc(g.name)}</b></label>
        <div class="module-group__items">${caps.map((c) => `<label class="check"><input type="checkbox" data-module="${c.id}" ${f.modules.includes(c.id) ? 'checked' : ''} /> ${esc(c.name)}${c.billable ? '<small class="warn">计费</small>' : ''}</label>`).join('')}</div></div>`; }).join('')}
      <p class="field-hint">创作中心的快捷链路对应：视频口播 = 图片数字人，语音合成 = 语音合成 TTS，知识库问答 = 流式问答助手。</p></fieldset>
    <fieldset><legend>真实环境与厂商凭据</legend>
      <label class="check"><input type="checkbox" data-bind="adm.form.allowReal" ${f.allowReal ? 'checked' : ''} /> 允许使用真实环境（调用如影平台）</label>
      <div class="form-grid"><div class="form-field"><label for="tf-vendor">分配厂商凭据</label><select class="input" id="tf-vendor" data-bind="adm.form.vendorId">
        <option value="">不分配</option>${vendors.map((v) => `<option value="${v.id}" ${f.vendorId === v.id ? 'selected' : ''}>${esc(v.name)}（${esc(v.appIdMasked)}）</option>`).join('')}</select>
        ${vendors.length ? '' : '<small class="field-hint">还没有厂商凭据，<a href="#admin/vendors" data-view="admin/vendors">先去添加</a>。</small>'}</div></div>
      <label class="check"><input type="checkbox" data-bind="adm.form.allowBillable" ${f.allowBillable ? 'checked' : ''} /> 允许计费调用（如生成视频；还需服务端开启 ALLOW_BILLABLE）</label>
    </fieldset>
    ${isNew ? `<fieldset><legend>客户管理员账号</legend><div class="form-grid">
      <div class="form-field"><label for="tf-admin">管理员用户名</label><input class="input" id="tf-admin" data-bind="adm.form.adminUsername" value="${esc(f.adminUsername)}" placeholder="如 acme_admin" /></div>
      <div class="form-field"><label for="tf-admin-name">管理员姓名（可选）</label><input class="input" id="tf-admin-name" data-bind="adm.form.adminDisplayName" value="${esc(f.adminDisplayName)}" /></div></div>
      <p class="field-hint">保存后会生成一次性初始密码。客户管理员可以自己添加成员、查看使用日志与到期时间。</p></fieldset>` : ''}
    <fieldset><legend>备注（仅平台可见）</legend><textarea class="editor" rows="2" data-bind="adm.form.note" aria-label="备注" maxlength="300">${esc(f.note)}</textarea></fieldset>
    ${f.error ? errorBlock(f.error) : ''}
    <div class="actions"><button class="btn btn--primary" type="submit" ${f.busy ? 'disabled aria-busy="true"' : ''}>${f.busy ? '保存中…' : isNew ? '创建客户' : '保存修改'}</button>
      <a class="btn" href="${isNew ? '#admin/tenants' : `#admin/tenants/${f.id}`}" data-view="${isNew ? 'admin/tenants' : `admin/tenants/${f.id}`}">取消</a>
      ${isNew ? '' : '<button class="btn btn--danger push-right" type="button" data-action="tenant-delete">删除客户</button>'}</div>
  </form></div>`;
}

export function tenantDetailView(s) {
  const d = s.adm.tenant;
  if (!d) return `<div class="console">${s.adm.error ? errorBlock(s.adm.error, { retry: 'adm-reload' }) : loadingBlock('正在读取客户…')}</div>`;
  const t = d.tenant;
  return `<div class="console">
    <nav class="exp-crumb" aria-label="位置"><a href="#admin/tenants" data-view="admin/tenants">客户管理</a><span aria-hidden="true">/</span><b>${esc(t.name)}</b></nav>
    <div class="grid-2">
      <div class="card"><div class="card__title"><h2>${esc(t.name)}</h2>${tenantStatusPill(t)}</div>
        <table class="table kv-table"><tbody>
          <tr><th scope="row">类型</th><td>${planLabel(t.plan)}客户</td></tr>
          <tr><th scope="row">有效期</th><td>${esc(t.startsDay)} 至 ${esc(t.expiresDay)}</td></tr>
          <tr><th scope="row">联系人</th><td>${esc(t.contact || '—')}</td></tr>
          <tr><th scope="row">成员</th><td>${t.userCount} / ${t.maxUsers}</td></tr>
          <tr><th scope="row">真实环境</th><td>${t.allowReal ? `<span class="ok">已开通</span> · ${esc(t.vendorName || '未分配凭据')}` : '<span class="muted">未开通</span>'}</td></tr>
          <tr><th scope="row">计费调用</th><td>${t.allowBillable ? '<span class="warn">允许</span>' : '不允许'}</td></tr>
          ${t.note ? `<tr><th scope="row">备注</th><td>${esc(t.note)}</td></tr>` : ''}
        </tbody></table>
        <div class="actions"><a class="btn btn--primary" href="#admin/tenants/${t.id}/edit" data-view="admin/tenants/${t.id}/edit">编辑 / 续期 / 权限</a>
          <a class="btn" href="#admin/logs/${t.id}" data-view="admin/logs/${t.id}">查看日志</a></div></div>
      <div class="card"><div class="card__title"><h2>已开通模块（${t.modules.length}）</h2></div>
        <div class="chip-wrap">${t.modules.map((id) => `<span class="mod-chip is-on">${esc(capById(id)?.name || id)}</span>`).join('')}</div></div>
    </div>
    <h2 class="section-title">近 30 天使用</h2>
    ${statsCards(d.usage)}
    <div class="card"><div class="card__title"><h2>额度（从「${esc(t.vendorName || '未分配凭据')}」的额度池划拨）</h2></div>
      ${quotaTable(d.quota)}
      <form class="inline-form" data-form="quota" novalidate>
        <div class="form-field"><label for="qf-op">操作</label><select class="input" id="qf-op" data-bind="adm.quotaForm.op"><option value="allocate" ${s.adm.quotaForm.op !== 'reclaim' ? 'selected' : ''}>分配给客户</option><option value="reclaim" ${s.adm.quotaForm.op === 'reclaim' ? 'selected' : ''}>回收到额度池</option></select></div>
        <div class="form-field"><label for="qf-meter">计量项</label><select class="input" id="qf-meter" data-bind="adm.quotaForm.meter">${Object.entries(METERS).map(([m, x]) => `<option value="${m}" ${s.adm.quotaForm.meter === m ? 'selected' : ''}>${x.label}（${x.unit}）</option>`).join('')}</select></div>
        <div class="form-field"><label for="qf-amt">数量</label><input class="input" id="qf-amt" type="number" min="1" data-bind="adm.quotaForm.amount" value="${esc(s.adm.quotaForm.amount)}" /></div>
        <div class="form-field"><label for="qf-note">备注（可选）</label><input class="input" id="qf-note" data-bind="adm.quotaForm.note" value="${esc(s.adm.quotaForm.note)}" placeholder="如：合同 HT-2026-018" /></div>
        <div class="form-field form-field--btn"><button class="btn btn--primary" type="submit" ${s.adm.quotaForm.busy || !t.vendorId ? 'disabled' : ''}>${s.adm.quotaForm.busy ? '处理中…' : '确认'}</button></div>
      </form>
      ${t.vendorId ? '' : '<p class="field-hint">客户还没有分配厂商凭据，额度需要从凭据的额度池划拨。先在「编辑」里分配凭据。</p>'}
      ${s.adm.quotaForm.error ? errorBlock(s.adm.quotaForm.error) : ''}
      <details class="ledger-details"><summary>额度流水（最近 30 条）</summary>${ledgerTable(d.ledger)}</details></div>
    <div class="card"><div class="card__title"><h2>API 密钥</h2></div>${keysTable(d.keys, 'admin')}
      <h3 class="doc-h">为客户签发</h3>${keyCreateForm(s, `admin:${t.id}`)}
      <p class="field-hint">客户用密钥调用开放接口（${esc(location.origin + location.pathname.replace(/[^/]*$/, ''))}open/v1），平台再用厂商 Token 转发；客户管理员也可以在「API 接入」里自助签发和吊销。</p></div>
    <div class="card"><div class="card__title"><h2>添加账号</h2></div>${userCreateForm(s, `admin:${t.id}`, t.userCount >= t.maxUsers)}</div>
    <div class="card"><div class="card__title"><h2>账号</h2></div>${usersTable(d.users, { selfId: s.me.user.id, scope: 'admin' })}</div>
  </div>`;
}

export function vendorsView(s) {
  const d = s.adm.vendors;
  if (!d) return `<div class="console">${s.adm.error ? errorBlock(s.adm.error, { retry: 'adm-reload' }) : loadingBlock('正在读取厂商凭据…')}</div>`;
  const f = s.adm.vendorForm;
  return `<div class="console">
    <p class="muted page-intro">厂商凭据是如影平台的 APP_ID / APP_KEY。平台用它向如影换取 Token，再按客户分配使用；客户与成员永远看不到凭据和 Token 原文。</p>
    ${d.encryptionReady ? '' : '<div class="alert alert--warn" role="alert"><div class="alert__body"><b>服务端未配置数据加密密钥</b><p>需要在服务端设置 DATA_ENCRYPTION_KEY 并重启后，才能在这里保存厂商凭据（APP_KEY 会加密存储）。</p></div></div>'}
    <div class="card">${!d.vendors.length ? '<div class="empty"><p class="empty__title">还没有厂商凭据</p><p>添加后即可分配给客户，为其开通真实环境。</p></div>'
      : `<div class="table-scroll"><table class="table admin-table"><thead><tr><th scope="col">名称</th><th scope="col">APP_ID</th><th scope="col">音色 / 形象图</th><th scope="col">使用客户</th><th scope="col">Token</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead><tbody>
      ${d.vendors.map((v) => { const tk = s.adm.vendorTokens[v.id]; return `<tr>
        <td><b>${esc(v.name)}</b>${v.note ? `<small class="cell-scene">${esc(v.note)}</small>` : ''}</td>
        <td><code>${esc(v.appIdMasked)}</code></td>
        <td>${v.ttsConfigured ? '<span class="ok">音色已配</span>' : '<span class="muted">无音色</span>'}<small class="cell-scene">${v.avatarImageConfigured ? '形象图已配' : '无形象图'}</small></td>
        <td>${v.tenantCount}</td>
        <td>${tk?.loading ? '获取中…' : tk?.error ? `<span class="err">${esc(tk.error.message)}</span>` : tk?.data?.hasToken ? `<span class="ok">有效</span><small class="cell-scene">剩余 ${Math.floor(tk.data.remainSec / 3600)} 小时 ${Math.floor((tk.data.remainSec % 3600) / 60)} 分 · ${esc(tk.data.tokenMasked)}</small>` : '<span class="muted">未获取</span>'}</td>
        <td><div class="row-actions"><button class="btn btn--sm" type="button" data-vendor-act="token" data-id="${v.id}" ${tk?.loading ? 'disabled' : ''}>获取 Token</button>
          ${v.readonly ? '' : `<button class="btn btn--sm" type="button" data-vendor-act="edit" data-id="${v.id}">编辑</button><button class="btn btn--sm btn--danger" type="button" data-vendor-act="delete" data-id="${v.id}" data-name="${esc(v.name)}">删除</button>`}</div></td>
      </tr>`; }).join('')}</tbody></table></div>`}
      <p class="field-hint">「获取 Token」会用凭据向如影换取一次 Token，用来确认凭据可用；不会产生生成费用。Token 由服务端缓存，到期前 30 分钟自动更换。</p></div>
    <div class="card"><div class="card__title"><h2>额度池（采购台账）</h2></div>
      <p class="muted">从如影采购的额度由你按采购单登记；分配给客户时从「未分配」扣除。如影没有可供查询的额度接口，这里是平台自己的台账，请以合同 / 采购单为准，并定期与如影控制台核对。</p>
      ${d.vendors.map((v) => `<div class="pool-block"><h3>${esc(v.name)}</h3><div class="table-scroll"><table class="table quota-table"><thead><tr><th scope="col">计量项</th><th scope="col">采购总量</th><th scope="col">已分配</th><th scope="col">未分配</th><th scope="col">客户已消耗</th></tr></thead><tbody>
        ${Object.entries(METERS).map(([m, x]) => { const p = v.pool?.[m] || {}; return `<tr><td>${x.label}</td><td>${num(p.purchased)} ${x.unit}</td><td>${num(p.allocated)}</td><td><b>${num(p.unallocated)}</b></td><td>${num(p.consumed)}</td></tr>`; }).join('')}
      </tbody></table></div></div>`).join('') || '<p class="muted">先添加厂商凭据。</p>'}
      ${d.vendors.length ? `<form class="inline-form" data-form="purchase" novalidate>
        <div class="form-field"><label for="pf-v">厂商凭据</label><select class="input" id="pf-v" data-bind="adm.purchaseForm.vendorId">${d.vendors.map((v) => `<option value="${v.id}" ${s.adm.purchaseForm.vendorId === v.id ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></div>
        <div class="form-field"><label for="pf-m">计量项</label><select class="input" id="pf-m" data-bind="adm.purchaseForm.meter">${Object.entries(METERS).map(([m, x]) => `<option value="${m}" ${s.adm.purchaseForm.meter === m ? 'selected' : ''}>${x.label}（${x.unit}）</option>`).join('')}</select></div>
        <div class="form-field"><label for="pf-a">数量（负数为冲减）</label><input class="input" id="pf-a" type="number" data-bind="adm.purchaseForm.amount" value="${esc(s.adm.purchaseForm.amount)}" /></div>
        <div class="form-field"><label for="pf-n">采购单号 / 备注</label><input class="input" id="pf-n" data-bind="adm.purchaseForm.note" value="${esc(s.adm.purchaseForm.note)}" /></div>
        <div class="form-field form-field--btn"><button class="btn btn--primary" type="submit" ${s.adm.purchaseForm.busy ? 'disabled' : ''}>登记入账</button></div>
      </form>${s.adm.purchaseForm.error ? errorBlock(s.adm.purchaseForm.error) : ''}` : ''}
    </div>
    <form class="card" data-form="vendor" novalidate><div class="card__title"><h2>${f.id ? `编辑：${esc(f.name)}` : '添加厂商凭据'}</h2>${f.id ? '<button class="btn btn--sm" type="button" data-action="vendor-new">改为新增</button>' : ''}</div>
      <div class="form-grid">
        <div class="form-field"><label for="vf-name">名称</label><input class="input" id="vf-name" data-bind="adm.vendorForm.name" value="${esc(f.name)}" placeholder="如：如影-主账号" /></div>
        <div class="form-field"><label for="vf-base">平台地址</label><input class="input" id="vf-base" data-bind="adm.vendorForm.baseUrl" value="${esc(f.baseUrl)}" /></div>
        <div class="form-field"><label for="vf-id">APP_ID</label><input class="input" id="vf-id" data-bind="adm.vendorForm.appId" value="${esc(f.appId)}" autocomplete="off" placeholder="${f.id ? '留空表示不修改' : ''}" /></div>
        <div class="form-field"><label for="vf-key">APP_KEY</label><input class="input" id="vf-key" type="password" data-bind="adm.vendorForm.appKey" value="${esc(f.appKey)}" autocomplete="new-password" placeholder="${f.id ? '留空表示不修改' : ''}" /></div>
        <div class="form-field"><label for="vf-qid">TTS 音色 QID（可选）</label><input class="input" id="vf-qid" data-bind="adm.vendorForm.ttsQid" value="${esc(f.ttsQid)}" /></div>
        <div class="form-field"><label for="vf-img">数字人形象图地址（可选）</label><input class="input" id="vf-img" data-bind="adm.vendorForm.avatarImageUrl" value="${esc(f.avatarImageUrl)}" placeholder="https://…" /></div>
        <div class="form-field"><label for="vf-note">备注（可选）</label><input class="input" id="vf-note" data-bind="adm.vendorForm.note" value="${esc(f.note)}" /></div>
      </div>
      ${f.error ? errorBlock(f.error) : ''}
      <div class="actions"><button class="btn btn--primary" type="submit" ${f.busy || !d.encryptionReady ? 'disabled' : ''}>${f.busy ? '保存中…' : '保存凭据'}</button></div>
      <p class="field-hint">APP_KEY 使用 AES-256-GCM 加密后存储，保存后不再显示原文。</p>
    </form>
  </div>`;
}

export function adminLogsView(s) { return `<div class="console">${logsPanel(s, 'admin')}</div>`; }

/* ================= 控制逻辑 ================= */
const emptyLogFilters = () => ({ tenant: '', user: '', category: '', capability: '', ok: '', from: addDays(todayStr(), -6), to: todayStr(), page: 1 });
const emptyVendorForm = () => ({ id: null, name: '', baseUrl: 'https://aigc.softsugar.com', appId: '', appKey: '', ttsQid: '', avatarImageUrl: '', note: '', busy: false, error: null });
const emptyUserForm = () => ({ username: '', displayName: '', role: 'member', busy: false, error: null });

export function initialAdminState() {
  return {
    error: null, overview: null, tenants: null, tenant: null, form: null, vendors: null, vendorTokens: {}, orgOverview: null, orgUsers: null,
    tenantFilter: { q: '', status: '' }, vendorForm: emptyVendorForm(), userForm: emptyUserForm(),
    keyForm: { name: '', expiresDay: '', busy: false, error: null }, quotaForm: { op: 'allocate', meter: 'video_seconds', amount: '', note: '', busy: false, error: null },
    purchaseForm: { vendorId: '', meter: 'video_seconds', amount: '', note: '', busy: false, error: null }, orgKeys: null, orgLedger: null, logs: { filters: emptyLogFilters(), data: null, error: null, loading: false },
  };
}

/** 后台页面的路由表：view → { role, title, render } */
export const ADMIN_ROUTES = {
  login: { title: '登录', render: loginView, public: true },
  account: { title: '账号与密码', render: accountView },
  org: { role: 'tenant_admin', title: '企业概览', render: orgOverviewView },
  'org/users': { role: 'tenant_admin', title: '成员管理', render: orgUsersView },
  'org/logs': { role: 'tenant_admin', title: '使用日志', render: orgLogsView },
  'org/api': { role: 'tenant_admin', title: 'API 接入', render: orgApiView },
  admin: { role: 'super_admin', title: '运营总览', render: adminOverviewView },
  'admin/tenants': { role: 'super_admin', title: '客户管理', render: tenantsView },
  'admin/tenant-new': { role: 'super_admin', title: '新建客户', render: tenantFormView },
  'admin/tenant': { role: 'super_admin', title: '客户详情', render: tenantDetailView },
  'admin/tenant-edit': { role: 'super_admin', title: '编辑客户', render: tenantFormView },
  'admin/vendors': { role: 'super_admin', title: '厂商凭据', render: vendorsView },
  'admin/logs': { role: 'super_admin', title: '全部日志', render: adminLogsView },
};

export function renderAdminRoute(s) {
  const r = ADMIN_ROUTES[s.view];
  if (r.public) return r.render(s);
  if (!s.me?.user) return loginRequired();
  if (r.role && s.me.user.role !== r.role) return forbidden();
  return r.render(s);
}

/** 把 hash 解析为后台路由；返回 null 表示不是后台页面 */
export function parseAdminHash(h) {
  if (h === 'login' || h === 'account' || h === 'org' || h === 'org/users' || h === 'org/logs' || h === 'org/api' || h === 'admin' || h === 'admin/tenants' || h === 'admin/vendors' || h === 'admin/logs') return { view: h };
  if (h === 'admin/tenants/new') return { view: 'admin/tenant-new' };
  let m = h.match(/^admin\/tenants\/([\w-]+)\/edit$/); if (m) return { view: 'admin/tenant-edit', id: m[1] };
  m = h.match(/^admin\/tenants\/([\w-]+)$/); if (m) return { view: 'admin/tenant', id: m[1] };
  m = h.match(/^admin\/logs\/([\w-]+)$/); if (m) return { view: 'admin/logs', tenant: m[1] };
  return null;
}

/** 控制器：需要主程序提供 state 与几个工具函数 */
export function createAdminController({ state, render, toast, go, refreshMe }) {
  const A = () => state.adm;
  const loadInto = async (key, fn) => {
    A().error = null;
    try { A()[key] = await fn(); } catch (e) { A().error = toApiError(e); }
    render();
  };

  function tenantToForm(t) {
    return { id: t.id, name: t.name, contact: t.contact || '', plan: t.plan, startsDay: t.startsDay, expiresDay: t.expiresDay, maxUsers: String(t.maxUsers), status: t.status,
      modules: [...t.modules], allowReal: t.allowReal, allowBillable: t.allowBillable, vendorId: t.vendorId || '', note: t.note || '', busy: false, error: null };
  }

  async function loadLogs(scope) {
    const L = A().logs; L.loading = true; L.error = null; render();
    const f = L.filters;
    const params = { category: f.category, capability: f.capability, ok: f.ok, from: f.from, to: f.to, page: f.page, size: 50 };
    try {
      L.data = scope === 'admin' ? await api.admin.logs({ ...params, tenant: f.tenant }) : await api.org.logs({ ...params, user: f.user });
    } catch (e) { L.error = toApiError(e); }
    L.loading = false; render();
  }

  /** 进入后台页面时加载数据 */
  function enter(route) {
    const v = route.view;
    if (v === 'login') { state.auth.error = null; return; }
    if (v === 'account') { state.pw = { old: '', next: '', again: '', busy: false, error: null }; return; }
    if (!state.me?.user) return;
    if (v === 'org') { A().orgOverview = null; loadInto('orgOverview', api.org.overview); }
    if (v === 'org/users') { A().orgUsers = null; A().userForm = emptyUserForm(); loadInto('orgUsers', api.org.users); }
    if (v === 'org/logs') { A().logs.filters.page = 1; if (!A().orgUsers) api.org.users().then((d) => { A().orgUsers = d; render(); }, () => {}); loadLogs('org'); }
    if (v === 'org/api') {
      A().orgKeys = null; A().orgLedger = null; A().keyForm = { name: '', expiresDay: '', busy: false, error: null };
      loadInto('orgKeys', api.org.keys);
      api.org.ledger().then((d) => { A().orgLedger = d.ledger; render(); }, () => { A().orgLedger = []; render(); });
    }
    if (v === 'admin') { A().overview = null; loadInto('overview', api.admin.overview); }
    if (v === 'admin/tenants') { loadInto('tenants', async () => (await api.admin.tenants()).tenants); }
    if (v === 'admin/tenant-new') {
      const start = todayStr();
      A().form = { id: null, name: '', contact: '', plan: 'trial', startsDay: start, expiresDay: addDays(start, 13), maxUsers: '10', status: 'active', modules: ['video-image', 'voice-tts', 'nlp-chat'], allowReal: false, allowBillable: false, vendorId: '', note: '', adminUsername: '', adminDisplayName: '', busy: false, error: null };
      loadInto('vendors', api.admin.vendors);
    }
    if (v === 'admin/tenant-edit') {
      A().form = null;
      loadInto('vendors', api.admin.vendors);
      api.admin.tenant(route.id).then((d) => { A().form = tenantToForm(d.tenant); render(); }, (e) => { A().error = toApiError(e); render(); });
    }
    if (v === 'admin/tenant') { A().tenant = null; A().userForm = emptyUserForm(); A().keyForm = { name: '', expiresDay: '', busy: false, error: null }; A().quotaForm = { op: 'allocate', meter: 'video_seconds', amount: '', note: '', busy: false, error: null }; loadInto('tenant', () => api.admin.tenant(route.id)); }
    if (v === 'admin/vendors') {
      A().vendorForm = emptyVendorForm();
      loadInto('vendors', async () => { const d = await api.admin.vendors(); if (!d.vendors.some((x) => x.id === A().purchaseForm.vendorId)) A().purchaseForm.vendorId = d.vendors[0]?.id || ''; return d; });
    }
    if (v === 'admin/logs') {
      A().logs.filters.page = 1;
      if (route.tenant) A().logs.filters.tenant = route.tenant;
      if (!A().tenants) api.admin.tenants().then((d) => { A().tenants = d.tenants; render(); }, () => {});
      loadLogs('admin');
    }
  }

  async function submitLogin() {
    const f = state.auth;
    if (!f.username.trim() || !f.password) { f.error = { message: '请输入用户名和密码。', action: 'fix' }; return render(); }
    f.busy = true; f.error = null; render();
    try {
      state.me = await api.login(f.username.trim(), f.password);
      f.password = ''; f.busy = false;
      await refreshMe(state.me);
      const u = state.me.user;
      toast(`欢迎，${u.displayName || u.username}`);
      go(u.mustChangePassword ? 'account' : u.role === 'super_admin' ? 'admin' : u.role === 'tenant_admin' ? 'org' : 'create');
    } catch (e) { f.busy = false; f.error = toApiError(e); render(); document.getElementById('login-pass')?.focus(); }
  }

  async function submitPassword() {
    const f = state.pw;
    if (f.next !== f.again) { f.error = { message: '两次输入的新密码不一致。', action: 'fix' }; return render(); }
    f.busy = true; f.error = null; render();
    try {
      state.me = await api.changePassword(f.old, f.next);
      state.pw = { old: '', next: '', again: '', busy: false, error: null };
      await refreshMe(state.me);
      toast('密码已更新');
      const u = state.me.user;
      go(u.role === 'super_admin' ? 'admin' : u.role === 'tenant_admin' ? 'org' : 'create');
    } catch (e) { f.busy = false; f.error = toApiError(e); render(); }
  }

  async function submitTenant() {
    const f = A().form;
    const body = { name: f.name, contact: f.contact, plan: f.plan, startsDay: f.startsDay, expiresDay: f.expiresDay, maxUsers: Number(f.maxUsers), modules: f.modules, allowReal: !!f.allowReal, allowBillable: !!f.allowBillable, vendorId: f.vendorId || null, note: f.note };
    if (f.id) body.status = f.status;
    else body.admin = { username: f.adminUsername.trim(), displayName: f.adminDisplayName.trim() };
    f.busy = true; f.error = null; render();
    try {
      if (f.id) {
        await api.admin.updateTenant(f.id, body);
        toast('已保存'); go(`admin/tenants/${f.id}`);
      } else {
        const r = await api.admin.createTenant(body);
        state.dialog = { type: 'cred', title: `已创建客户「${r.tenant.name}」`, username: r.admin.username, password: r.admin.initialPassword };
        go(`admin/tenants/${r.tenant.id}`);
      }
    } catch (e) { f.busy = false; f.error = toApiError(e); render(); }
  }

  async function submitUser(scope) {
    const f = A().userForm;
    f.busy = true; f.error = null; render();
    const body = { username: f.username.trim(), displayName: f.displayName.trim(), role: f.role };
    try {
      const tenantId = scope.startsWith('admin:') ? scope.slice(6) : null;
      const r = tenantId ? await api.admin.createUser(tenantId, body) : await api.org.createUser(body);
      A().userForm = emptyUserForm();
      state.dialog = { type: 'cred', title: `已添加账号 ${r.user.username}`, username: r.user.username, password: r.initialPassword };
      if (tenantId) A().tenant = await api.admin.tenant(tenantId); else A().orgUsers = await api.org.users();
      render();
    } catch (e) { f.busy = false; f.error = toApiError(e); render(); }
  }

  async function userAction(el) {
    const { userAct: act, id, scope, name } = el.dataset;
    const ns = scope === 'admin' ? api.admin : api.org;
    const confirmText = { reset: `重置 ${name} 的密码？对方会立即下线，需要用新的初始密码登录。`, disable: `停用 ${name}？对方会立即下线且无法登录。`, delete: `删除账号 ${name}？此操作不可恢复（历史日志会保留）。`, promote: `把 ${name} 设为企业管理员？`, demote: `把 ${name} 改为普通成员？` }[act];
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      if (act === 'reset') { const r = await ns.resetPassword(id); state.dialog = { type: 'cred', title: `已重置 ${r.username} 的密码`, username: r.username, password: r.initialPassword }; }
      else if (act === 'delete') { await ns.deleteUser(id); toast('已删除'); }
      else { await ns.updateUser(id, act === 'disable' ? { status: 'disabled' } : act === 'enable' ? { status: 'active' } : { role: act === 'promote' ? 'tenant_admin' : 'member' }); toast('已更新'); }
      if (scope === 'admin') A().tenant = await api.admin.tenant(A().tenant.tenant.id); else A().orgUsers = await api.org.users();
    } catch (e) { const err = toApiError(e); toast(err.message + (err.hint ? ` ${err.hint}` : '')); }
    render();
  }

  async function submitVendor() {
    const f = A().vendorForm;
    f.busy = true; f.error = null; render();
    const body = { name: f.name, baseUrl: f.baseUrl, appId: f.appId, appKey: f.appKey, ttsQid: f.ttsQid, avatarImageUrl: f.avatarImageUrl, note: f.note };
    try {
      if (f.id) await api.admin.updateVendor(f.id, body); else await api.admin.createVendor(body);
      toast('厂商凭据已保存');
      A().vendorForm = emptyVendorForm();
      A().vendors = await api.admin.vendors();
    } catch (e) { f.busy = false; f.error = toApiError(e); }
    render();
  }

  async function vendorAction(el) {
    const { vendorAct: act, id, name } = el.dataset;
    if (act === 'edit') {
      const v = A().vendors.vendors.find((x) => x.id === id);
      A().vendorForm = { ...emptyVendorForm(), id, name: v.name, baseUrl: v.baseUrl, note: v.note || '' };
      render(); document.getElementById('vf-name')?.focus(); return;
    }
    if (act === 'delete') {
      if (!window.confirm(`删除厂商凭据「${name}」？`)) return;
      try { await api.admin.deleteVendor(id); toast('已删除'); A().vendors = await api.admin.vendors(); } catch (e) { const err = toApiError(e); toast(`${err.message} ${err.hint || ''}`); }
      return render();
    }
    if (act === 'token') {
      A().vendorTokens[id] = { loading: true }; render();
      try { A().vendorTokens[id] = { data: (await api.admin.vendorToken(id)).token }; toast('已从厂商获取 Token'); } catch (e) { A().vendorTokens[id] = { error: toApiError(e) }; }
      render();
    }
  }

  const actions = {
    logout: async () => { try { await api.logout(); } catch { /* ignore */ } await refreshMe(null); toast('已退出登录'); go('home'); },
    'cred-close': () => { state.dialog = null; render(); },
    'cred-copy': () => {
      const d = state.dialog;
      const text = d.secret ? d.secret : `登录地址：${location.origin + location.pathname}#login\n用户名：${d.username}\n初始密码：${d.password}\n（首次登录需修改密码）`;
      (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => toast('已复制'), () => toast('复制失败，请手动记录'));
    },
    'adm-reload': () => enter(state.route),
    'logs-reload': () => loadLogs(state.view === 'admin/logs' ? 'admin' : 'org'),
    'logs-prev': () => { A().logs.filters.page -= 1; loadLogs(state.view === 'admin/logs' ? 'admin' : 'org'); },
    'logs-next': () => { A().logs.filters.page += 1; loadLogs(state.view === 'admin/logs' ? 'admin' : 'org'); },
    'vendor-new': () => { A().vendorForm = emptyVendorForm(); render(); },
    'tenant-delete': async () => {
      const f = A().form;
      if (window.prompt(`删除客户会同时删除它的全部账号，且不可恢复。请输入客户名称「${f.name}」确认：`) !== f.name) return toast('名称不一致，未删除');
      try { await api.admin.deleteTenant(f.id); toast('已删除客户'); go('admin/tenants'); } catch (e) { toast(toApiError(e).message); }
    },
  };

  async function submitKey(el) {
    const f = A().keyForm; const scope = el.dataset.scope;
    f.busy = true; f.error = null; render();
    try {
      const body = { name: f.name.trim(), expiresDay: f.expiresDay || undefined };
      const r = scope.startsWith('admin:') ? await api.admin.createKey(scope.slice(6), body) : await api.org.createKey(body);
      A().keyForm = { name: '', expiresDay: '', busy: false, error: null };
      state.dialog = { type: 'cred', title: `已签发 API 密钥「${r.key.name}」`, secret: r.secret };
      if (scope.startsWith('admin:')) A().tenant = await api.admin.tenant(scope.slice(6)); else A().orgKeys = await api.org.keys();
    } catch (e) { f.busy = false; f.error = toApiError(e); }
    render();
  }

  async function submitQuota() {
    const f = A().quotaForm; const id = A().tenant.tenant.id;
    f.busy = true; f.error = null; render();
    try {
      await api.admin.quota(id, { op: f.op, meter: f.meter, amount: Number(f.amount), note: f.note });
      toast(f.op === 'reclaim' ? '已回收到额度池' : '已分配给客户');
      A().quotaForm = { ...f, amount: '', note: '', busy: false, error: null };
      A().tenant = await api.admin.tenant(id);
    } catch (e) { f.busy = false; f.error = toApiError(e); }
    render();
  }

  async function submitPurchase() {
    const f = A().purchaseForm;
    f.busy = true; f.error = null; render();
    try {
      const vendorId = f.vendorId || A().vendors?.vendors?.[0]?.id; // 下拉框默认显示第一项
      if (!vendorId) throw { message: '请先添加厂商凭据。', action: 'fix' };
      await api.admin.purchase(vendorId, { meter: f.meter, amount: Number(f.amount), note: f.note });
      toast('已登记入账');
      A().purchaseForm = { ...f, vendorId, amount: '', note: '', busy: false, error: null };
      A().vendors = await api.admin.vendors();
    } catch (e) { f.busy = false; f.error = toApiError(e); }
    render();
  }

  async function revokeKey(el) {
    const { keyRevoke: id, scope, name } = el.dataset;
    if (!window.confirm(`吊销密钥「${name}」？使用它的系统会立即无法调用。`)) return;
    try {
      if (scope === 'admin') { await api.admin.revokeKey(id); A().tenant = await api.admin.tenant(A().tenant.tenant.id); }
      else { await api.org.revokeKey(id); A().orgKeys = await api.org.keys(); }
      toast('已吊销');
    } catch (e) { toast(toApiError(e).message); }
    render();
  }

  const forms = {
    'key-create': submitKey, quota: submitQuota, purchase: submitPurchase,
    login: submitLogin, 'change-pw': submitPassword, tenant: submitTenant, vendor: submitVendor,
    'user-create': (el) => submitUser(el.dataset.scope),
    logs: () => { A().logs.filters.page = 1; loadLogs(state.view === 'admin/logs' ? 'admin' : 'org'); },
  };

  /** 表单里的特殊控件（模块勾选、快捷有效期、行操作） */
  function click(el) {
    const d = el.dataset;
    const f = A().form;
    if (d.module !== undefined && f) { const set = new Set(f.modules); el.checked ? set.add(d.module) : set.delete(d.module); f.modules = CAPABILITIES.map((c) => c.id).filter((id) => set.has(id)); render(); return true; }
    if (d.moduleGroup !== undefined && f) { const ids = CAPABILITIES.filter((c) => c.group === d.moduleGroup).map((c) => c.id); const set = new Set(f.modules); ids.forEach((id) => (el.checked ? set.add(id) : set.delete(id))); f.modules = CAPABILITIES.map((c) => c.id).filter((id) => set.has(id)); render(); return true; }
    if (d.moduleAll !== undefined && f) { f.modules = d.moduleAll === '1' ? CAPABILITIES.map((c) => c.id) : []; render(); return true; }
    if (d.quickDays && f) { f.expiresDay = addDays(f.startsDay || todayStr(), Number(d.quickDays) - 1); if (Number(d.quickDays) >= 30) f.plan = Number(d.quickDays) >= 365 ? 'formal' : f.plan; render(); return true; }
    if (d.quickExtend && f) { const base = f.expiresDay < todayStr() ? todayStr() : f.expiresDay; f.expiresDay = addDays(base, Number(d.quickExtend)); render(); return true; }
    if (d.userAct) { userAction(el); return true; }
    if (d.keyRevoke) { revokeKey(el); return true; }
    if (d.vendorAct) { vendorAction(el); return true; }
    return false;
  }

  return { enter, actions, forms, click, loadLogs };
}
