// views.js —— 视图渲染（纯函数：state → HTML）
// 外壳（顶栏/页脚，含双 logo）只在启动时渲染一次；这里的函数只负责动态内容区与覆盖层。
import { PRODUCT, BRAND_LOGOS, MODE_NOTICE, navFor, SHORTCUT_MODULE, ROLE_LABEL } from './product.js';
import { GROUPS, CAPABILITIES, SCENARIOS, INTEGRATION_STEPS, capsOf, stats, capById, groupOf, OUTPUT_LABEL } from './capabilities.js';
import { INTERPRET, TOUR_STEPS } from './guide.js';
import { EXPERIENCES, estimateSeconds } from './wizard.js';
import { esc, words } from './html.js';

/* ============ 通用片段 ============ */
const isReal = (s) => s.mode === 'real';

export function brandMarks(where) {
  return `<span class="brand-logos brand-logos--${where}">${BRAND_LOGOS.map((l) => l.src
    ? `<img class="brand-logo" src="${esc(l.src)}" alt="${esc(l.alt)}" height="28" decoding="async" />`
    : `<span class="brand-wordmark" role="img" aria-label="${esc(l.alt)}"><b>${esc(l.zh)}</b><small>${esc(l.en)}</small></span>`).join('<i class="brand-logos__sep" aria-hidden="true"></i>')}</span>`;
}

/** 顶栏：只渲染一次。环境开关的文字/样式由 main.js 单独更新 */
export function topbarHtml() {
  return `<header class="topbar"><div class="topbar__inner">
    <a class="brand" href="#home" data-view="home" aria-label="${esc(PRODUCT.name)}，返回首页">
      ${brandMarks('top')}
      <span class="brand__text"><b>${esc(PRODUCT.name)}</b><small>数字人 PaaS 能力门户</small></span>
    </a>
    <div class="topbar__spacer"></div>
    <button class="env-switch" id="env-switch" type="button" data-action="open-mode" aria-haspopup="dialog">
      <i aria-hidden="true"></i><span id="env-switch-label">读取环境…</span>
    </button>
    <a class="btn btn--ghost topbar__link" href="${PRODUCT.docsUrl}" target="_blank" rel="noreferrer">产品文档<span class="sr-only">（新窗口打开）</span></a>
    <div id="user-slot" class="user-slot"></div>
    <a class="btn btn--primary topbar__cta" href="#create" data-view="create">进入工作台</a>
  </div></header>`;
}

/** 顶栏右侧账号区（仅在登录状态变化时更新，不影响 logo） */
export function userSlotHtml(me) {
  const u = me?.user;
  if (!u) return '<a class="btn btn--ghost topbar__login" href="#login" data-view="login">登录</a>';
  const home = u.role === 'super_admin' ? 'admin' : u.role === 'tenant_admin' ? 'org' : 'account';
  return `<a class="user-chip" href="#${home}" data-view="${home}" title="${esc(ROLE_LABEL[u.role])}">
      <span class="user-chip__avatar" aria-hidden="true">${esc((u.displayName || u.username).slice(0, 1).toUpperCase())}</span>
      <span class="user-chip__text"><b>${esc(u.displayName || u.username)}</b><small>${esc(me.tenant?.name || ROLE_LABEL[u.role])}</small></span></a>`;
}

/** 当前用户可用的模块（访客为全部演示模块） */
export const allowedModules = (s) => s.me?.access?.modules || [];
export const canUse = (s, capId) => allowedModules(s).includes(capId);

/** 工作台顶部提示：到期、即将到期、未开始、必须登录 */
export function accessBanner(s) {
  const a = s.me?.access; const t = s.me?.tenant;
  if (!s.me) return '';
  if (a.kind === 'guest' && !a.allowed) return '<div class="alert alert--warn" role="status"><div class="alert__body"><b>工作台需要登录后使用</b><p>账号由你的企业管理员或商予科技开通。</p></div><div class="alert__actions"><a class="btn btn--primary btn--sm" href="#login" data-view="login">登录</a></div></div>';
  if (!t) return '';
  if (t.notStarted) return `<div class="alert alert--warn" role="status"><div class="alert__body"><b>企业账号将于 ${esc(t.startsDay)} 开通</b><p>开通后即可使用工作台。</p></div></div>`;
  if (t.expired) return `<div class="alert alert--err" role="status"><div class="alert__body"><b>企业账号已于 ${esc(t.expiresDay)} 到期</b><p>工作台暂停使用；需要续期请联系商予科技商务人员。到期前保存的作品不受影响。</p></div></div>`;
  const low = s.me.quota?.low || [];
  const lowNote = low.length && a.canReal ? `<div class="alert alert--warn" role="status"><div class="alert__body"><b>真实环境额度即将用完</b><p>${low.map((m) => ({ video_seconds: '视频时长', tts_chars: '语音合成字数', api_calls: '其他能力调用' }[m])).join('、')}剩余不足 10%。需要追加请联系企业管理员或商予科技；演示环境不受影响。</p></div></div>` : '';
  if (t.daysLeft <= 7) return lowNote +  `<div class="alert alert--warn" role="status"><div class="alert__body"><b>企业账号将于 ${esc(t.expiresDay)} 到期（剩余 ${t.daysLeft} 天）</b><p>需要续期请提前联系商予科技。</p></div></div>`;
  return lowNote;
}

export function footerHtml() {
  return `<footer class="footer"><div class="footer__inner">
    ${brandMarks('foot')}
    <span class="footer__text">© ${new Date().getFullYear()} ${esc(PRODUCT.vendor)} · ${esc(PRODUCT.name)}</span>
    <span class="footer__text">AI 生成内容对外发布前须添加显式标识</span>
    <a href="${PRODUCT.docsUrl}" target="_blank" rel="noreferrer">官方文档</a>
    <span class="footer__ver">v${esc(PRODUCT.version)}</span>
  </div></footer>`;
}

/** 失败态：说清发生了什么、为什么、下一步；按钮由 action 决定 */
export function errorBlock(err, { retry = '', resume = '' } = {}) {
  if (!err) return '';
  const a = err.action;
  let buttons = '';
  if (a === 'resume' && resume) buttons = `<button class="btn btn--primary btn--sm" data-action="${resume}">继续等待</button>${retry ? `<button class="btn btn--sm" data-action="${retry}">重新生成</button>` : ''}`;
  else if ((a === 'retry' || a === 'later') && retry) buttons = `<button class="btn btn--primary btn--sm" data-action="${retry}">${a === 'later' ? '稍后重试' : '重试'}</button>`;
  else if (a === 'config') buttons = '<a class="btn btn--sm" href="#settings" data-view="settings">查看环境配置</a>';
  else if (a === 'login') buttons = '<a class="btn btn--primary btn--sm" href="#login" data-view="login">去登录</a>';
  else if (a === 'contact') buttons = `<a class="btn btn--sm" href="${PRODUCT.docsUrl}" target="_blank" rel="noreferrer">查看帮助文档</a>`;
  return `<div class="alert alert--err" role="alert">
    <div class="alert__body"><b>${esc(err.message)}</b>${err.hint ? `<p>${esc(err.hint)}</p>` : ''}</div>
    ${buttons ? `<div class="alert__actions">${buttons}</div>` : ''}</div>`;
}

const spinner = '<span class="spinner" aria-hidden="true"></span>';
export function loadingBlock(text) { return `<div class="loading" role="status">${spinner}<span>${esc(text)}</span></div>`; }
const fmtElapsed = (ms) => { const s = Math.floor(ms / 1000); return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`; };

/** 进行中的任务：阶段、已等待时间、平台排队提示、停止等待 */
function taskProgress({ stage, elapsed = 0, queued = false, stopAction, key }) {
  return `<div class="task-progress" role="status" aria-live="polite">
    <div class="task-progress__head">${spinner}<b>${esc(stage)}</b><span class="muted" data-elapsed="${key}">已等待 ${fmtElapsed(elapsed)}</span>
      ${stopAction ? `<button class="btn btn--sm btn--ghost" data-action="${stopAction}">停止等待</button>` : ''}</div>
    ${queued ? '<p class="task-progress__note">平台侧队列可能在排队，任务还没开始生成。这通常需要几分钟，可以保持页面打开继续等待；不想等也可以停止，稍后重新生成。</p>' : ''}
  </div>`;
}

function resultModeTag(mode) {
  return mode === 'real' ? '<span class="pill pill--ok">真实环境结果</span>' : '<span class="pill pill--mock">演示结果 · 本地样例</span>';
}

/* ============ 内容区：官网 ============ */
export function homeView(s) {
  const st = stats();
  return `<div class="site">
    <section class="hero">
      <div class="hero__bg" aria-hidden="true"></div>
      <div class="hero__inner">
        <p class="hero__badge"><i aria-hidden="true"></i> 数字人 PaaS · 能力即服务</p>
        <h1>${esc(PRODUCT.tagline)}</h1>
        <p class="hero__lead">${esc(PRODUCT.description)}</p>
        <div class="hero__actions">
          <a class="btn btn--primary btn--lg" href="#create" data-view="create">立即体验能力</a>
          <a class="btn btn--lg btn--outline" href="#capabilities" data-view="capabilities">查看能力矩阵</a>
        </div>
        <dl class="hero__stats">
          <div><dt>能力大类</dt><dd>${st.groups}</dd></div>
          <div><dt>平台能力</dt><dd>${st.capabilities}</dd></div>
          <div><dt>可在线体验</dt><dd>${st.ready}</dd></div>
          <div><dt>行业场景</dt><dd>${st.scenarios}</dd></div>
        </dl>
      </div>
    </section>

    <div class="notice-bar ${isReal(s) ? 'notice-bar--real' : ''}"><span>${esc(MODE_NOTICE[s.mode])}</span>
      <a class="btn btn--ghost btn--sm" href="#settings" data-view="settings">环境设置</a></div>

    <section class="section">
      <div class="section__head"><div><h2>一套 API，覆盖数字人内容生产全链路</h2>
        <p>6 大类 15 项能力：从形象、音色到成片、互动，可单独调用，也可组合集成。</p></div>
        <a class="btn" href="#capabilities" data-view="capabilities">全部能力</a></div>
      <div class="cap-grid">${GROUPS.map((g) => `<button class="cap-card" type="button" data-group="${g.id}" style="--accent:${g.accent}">
          <span class="cap-card__icon" aria-hidden="true">${g.icon}</span>
          <h3>${esc(g.name)}</h3><p>${esc(g.desc)}</p>
          <span class="cap-card__foot"><span>${capsOf(g.id).length} 项能力</span><span class="cap-card__dot on">可在线体验</span></span>
        </button>`).join('')}</div>
    </section>

    <section class="section section--alt">
      <div class="section__head"><div><h2>从场景出发，选能力组合</h2>
        <p>不同行业的落地路径，都建立在同一套开放能力之上。</p></div></div>
      <div class="scene-grid">${SCENARIOS.map((sc) => `
        <div class="scene-card"><div class="scene-card__icon" aria-hidden="true">${sc.icon}</div>
          <h3>${esc(sc.name)}</h3><p>${esc(sc.desc)}</p>
          <div class="scene-card__tags">${sc.caps.map((id) => { const c = capById(id); return c ? `<span>${esc(c.name)}</span>` : ''; }).join('')}</div>
        </div>`).join('')}</div>
    </section>

    <section class="section">
      <div class="section__head"><div><h2>四步接入，凭据不出服务端</h2>
        <p>签名换取 Token → 调用能力 → 取回成果，与官方「快速集成」流程一致。</p></div>
        <a class="btn" href="#integration" data-view="integration">接入指南</a></div>
      <ol class="steps-grid">${INTEGRATION_STEPS.map((x) => `
        <li class="step-card"><span class="step-card__n" aria-hidden="true">${x.n}</span><h3>${esc(x.title)}</h3><p>${esc(x.desc)}</p></li>`).join('')}</ol>
    </section>

    <section class="cta"><div class="cta__inner"><h2>现在就看看能力长什么样</h2>
      <p>无需注册、无需密钥，演示环境直接体验；准备好后可切换到真实环境。</p>
      <div class="cta__actions"><a class="btn btn--primary btn--lg" href="#create" data-view="create">打开工作台</a>
      <a class="btn btn--lg btn--outline" href="#integration" data-view="integration">了解接入方式</a></div></div></section>
  </div>`;
}

function capTable(list, s) {
  return `<div class="table-scroll"><table class="table cap-table">
    <caption class="sr-only">能力列表</caption>
    <thead><tr><th scope="col">能力</th><th scope="col">所属</th><th scope="col">说明 / 场景</th><th scope="col">输出</th><th scope="col">接口</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead>
    <tbody>${list.map((c) => `<tr>
      <td data-label="能力"><b>${esc(c.name)}</b>${c.tag ? `<span class="tag">${esc(c.tag)}</span>` : ''}</td>
      <td data-label="所属">${esc(groupOf(c.group)?.name ?? '')}</td>
      <td data-label="说明"><span class="muted">${esc(c.desc)}</span><small class="cell-scene">${esc(c.scene)}</small></td>
      <td data-label="输出"><span class="status st-ready">${OUTPUT_LABEL[c.experience?.output] || '文本'}</span></td>
      <td data-label="接口"><code class="code-sm">${esc(c.api)}</code></td>
      <td>${canUse(s, c.id) ? `<button class="btn btn--sm btn--primary" type="button" data-use="${c.id}" aria-label="体验${esc(c.name)}">体验</button>` : `<span class="pill pill--lock" title="你的企业未开通这项能力">未开通</span>`}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function filterRow(filter) {
  return `<div class="filter-row" role="group" aria-label="按能力大类筛选">
    <button class="chip ${filter === 'all' ? 'is-on' : ''}" type="button" data-filter="all" aria-pressed="${filter === 'all'}">全部 ${CAPABILITIES.length}</button>
    ${GROUPS.map((g) => `<button class="chip ${filter === g.id ? 'is-on' : ''}" type="button" data-filter="${g.id}" aria-pressed="${filter === g.id}">${esc(g.name)} ${capsOf(g.id).length}</button>`).join('')}
  </div>`;
}

export function capabilitiesView(s) {
  const filter = s.capFilter || 'all';
  const list = filter === 'all' ? CAPABILITIES : CAPABILITIES.filter((c) => c.group === filter);
  return `<div class="site site--inner">
    <div class="page-head"><h1>能力矩阵</h1>
      <p>平台全部能力的索引：所属大类、输出类型与对应接口。每一项都可以在工作台在线体验。</p></div>
    <div class="page-body">${filterRow(filter)}${capTable(list, s)}
    <p class="hint-block">能力口径依据如影平台官方产品文档整理。演示环境返回本地样例，真实环境的可用范围以你的平台账号开通情况为准。</p></div>
  </div>`;
}

export function scenariosView() {
  return `<div class="site site--inner">
    <div class="page-head"><h1>应用场景</h1><p>按行业看能力如何组合成可落地的方案。</p></div>
    <div class="scene-detail">${SCENARIOS.map((sc) => `
      <article class="scene-row"><div class="scene-row__icon" aria-hidden="true">${sc.icon}</div>
        <div class="scene-row__body"><h2>${esc(sc.name)}</h2><p>${esc(sc.desc)}</p>
          <div class="scene-row__caps">${sc.caps.map((id) => { const c = capById(id); return c ? `<button class="cap-pill" type="button" data-use="${c.id}">${esc(c.name)}<small>${OUTPUT_LABEL[c.experience?.output] || '文本'}</small></button>` : ''; }).join('')}</div>
        </div></article>`).join('')}</div>
  </div>`;
}

export function integrationView() {
  return `<div class="site site--inner">
    <div class="page-head"><h1>接入指南</h1>
      <p>从凭据到成果的完整路径。所有密钥只保存在服务端，浏览器永远拿不到。</p></div>
    <ol class="integration-steps">${INTEGRATION_STEPS.map((x, i) => `
      <li class="int-step"><div class="int-step__rail" aria-hidden="true"><span>${Number(x.n)}</span>${i < INTEGRATION_STEPS.length - 1 ? '<i></i>' : ''}</div>
        <div class="int-step__body"><h3>${esc(x.title)}</h3><p>${esc(x.desc)}</p></div></li>`).join('')}</ol>
    <div class="page-body grid-2">
      <div class="card"><div class="card__title"><h2>安全边界</h2></div>
        <ul class="check-list">
          <li>APP_ID / APP_KEY 只保存在服务端环境变量，不进入前端代码</li>
          <li>Token 由服务端获取并缓存，到期前 30 分钟自动更换；失效时自动重取</li>
          <li>计费接口默认拒绝，服务端显式开启 ALLOW_BILLABLE 后才放行</li>
          <li>AI 生成内容对外发布前添加「AI生成」显式标识</li>
        </ul></div>
      <div class="card"><div class="card__title"><h2>两种运行环境</h2></div>
        <div class="table-scroll"><table class="table"><thead><tr><th scope="col"><span class="sr-only">对比项</span></th><th scope="col">演示环境</th><th scope="col">真实环境</th></tr></thead><tbody>
          <tr><th scope="row">数据来源</th><td>本地样例</td><td>如影平台线上接口</td></tr>
          <tr><th scope="row">费用</th><td>不产生</td><td>按平台计费</td></tr>
          <tr><th scope="row">凭据</th><td>不需要</td><td>服务端配置</td></tr>
          <tr><th scope="row">适用</th><td>演示、培训</td><td>集成验证、生产</td></tr>
        </tbody></table></div>
        <a class="btn card__foot-btn" href="#settings" data-view="settings">前往环境设置</a></div>
    </div>
    <div class="page-body"><div class="card"><div class="card__title"><h2>开放接口</h2></div>
      <p class="muted">已开通的客户可以从自己的系统直接调用：企业管理员在「API 接入」里签发 API 密钥，用 <code>Authorization: Bearer &lt;密钥&gt;</code> 调用 <code>/open/v1</code> 下的接口。平台再用如影的凭据转发，客户不需要也拿不到如影的凭据。</p>
      <ul class="check-list">
        <li>每个企业有独立的额度（视频时长、语音字数、其他调用次数），门户与接口共用，失败自动退回</li>
        <li>沙箱模式（<code>X-Ruying-Mode: sandbox</code>）返回样例结果、不扣额度，方便联调</li>
        <li>按企业开通的能力与有效期鉴权；每个密钥可单独吊销、设置有效期</li>
      </ul></div></div>
  </div>`;
}

/* ============ 内容区：工作台 ============ */
export function sidenav(s) {
  const active = s.view.startsWith('admin/tenant') ? 'admin/tenants' : s.view === 'experience' ? 'catalog' : s.view;
  return `<nav class="sidenav" aria-label="工作台">${navFor(s.me?.user?.role).map((sec) => `
    <div class="nav-group"><div class="nav-group__label" aria-hidden="true">${sec.label}</div>
      ${sec.items.map((it) => `<a class="nav-item ${active === it.id ? 'is-active' : ''}" href="#${it.id}" data-view="${it.id}" ${active === it.id ? 'aria-current="page"' : ''}>
        <span class="nav-item__icon" aria-hidden="true">${it.icon}</span><span>${it.label}</span>
        ${it.id === 'tasks' && s.works.length ? `<em aria-label="${s.works.length} 个作品">${s.works.length}</em>` : ''}
      </a>`).join('')}
    </div>`).join('')}
    <button class="nav-collapse" type="button" data-action="nav-collapse" title="${s.navCollapsed ? '展开菜单' : '收起菜单'}">
      <span class="nav-collapse__icon" aria-hidden="true">${s.navCollapsed ? '»' : '«'}</span><span>${s.navCollapsed ? '' : '收起菜单'}</span>
    </button>
  </nav>`;
}

export function consoleBar(s, title) {
  return `<div class="console-bar"><h1>${esc(title)}</h1>
    <div class="console-bar__right"><span class="pill ${isReal(s) ? 'pill--ok' : 'pill--mock'}">${isReal(s) ? '真实环境 · 可能计费' : '演示环境 · 不计费'}</span></div></div>`;
}

export function overviewView(s) {
  const recent = s.works.slice(0, 5);
  const kbCount = s.kb.loaded ? s.kb.docs.length : '—';
  return `<div class="console">
    <div class="kpi-grid">
      <div class="kpi"><span>可用能力</span><b>${allowedModules(s).length}</b><small>共 ${CAPABILITIES.length} 项平台能力</small></div>
      <div class="kpi"><span>我的作品</span><b>${s.works.length}</b><small>保存在本机 · 7 天有效</small></div>
      <div class="kpi"><span>知识库资料</span><b>${kbCount}</b><small>仅你自己可见</small></div>
      <div class="kpi"><span>运行环境</span><b class="kpi__mode">${isReal(s) ? '真实' : '演示'}</b><small><a href="#settings" data-view="settings">切换环境</a></small></div>
    </div>
    <div class="grid-2">
      <div class="card"><div class="card__title"><h2>快速开始</h2></div>
        <div class="quick-list">${EXPERIENCES.filter((e) => canUse(s, SHORTCUT_MODULE[e.id])).map((e) => `
          <button class="quick-item" type="button" data-experience="${e.id}"><span class="quick-item__icon" aria-hidden="true">${e.icon}</span>
            <span><b>${esc(e.name)}</b><small>${esc(e.desc)}</small></span></button>`).join('') || '<p class="muted">你的企业没有开通创作中心的快捷能力，可以在能力目录里查看已开通的能力。</p>'}</div></div>
      <div class="card"><div class="card__title"><h2>我的额度</h2></div>
        ${quotaCardHtml(s)}</div>
    </div>
    <div class="card"><div class="card__title"><h2>最近作品</h2>${recent.length ? '<a class="btn btn--sm" href="#tasks" data-view="tasks">查看全部</a>' : ''}</div>
      ${recent.length ? worksTable(recent) : emptyState('还没有作品', '在创作中心生成一条视频或语音，点「保存到作品」就会出现在这里。', '<a class="btn btn--primary btn--sm" href="#create" data-view="create">去创作中心</a>')}</div>
  </div>`;
}

/** 我的额度：按 /api/me 返回的企业额度台账展示（已分配 / 已用 / 剩余） */
const QUOTA_LABELS = {
  video_seconds: { label: '视频时长', unit: '秒' },
  tts_chars: { label: '语音合成字数', unit: '字' },
  api_calls: { label: '其他能力调用', unit: '次' },
};

function quotaCardHtml(s) {
  const q = s.me?.quota;
  if (!q || !q.items) return `<p class="muted">登录后可查看你所在企业的剩余额度。</p><a class="btn card__foot-btn" href="#login" data-view="login">去登录</a>`;
  const meters = Object.keys(QUOTA_LABELS);
  const anyAllocated = meters.some((m) => (q.items[m]?.allocated || 0) > 0);
  if (!anyAllocated) return `<p class="muted">你的企业尚未分配额度，请联系企业管理员或商予科技。</p><a class="btn card__foot-btn" href="${PRODUCT.consoleUrl}" target="_blank" rel="noreferrer">打开如影控制台<span class="sr-only">（新窗口打开）</span></a>`;
  const rows = meters.map((m) => {
    const v = q.items[m] || { allocated: 0, used: 0, remaining: 0 };
    const pct = v.allocated > 0 ? Math.min(100, Math.round((v.used / v.allocated) * 100)) : 0;
    const low = (q.low || []).includes(m);
    const hasQuota = v.allocated > 0;
    return `<div class="quota-row${low ? ' quota-row--low' : ''}">
      <div class="quota-row__head"><b>${QUOTA_LABELS[m].label}</b>
        <span class="quota-row__remain">${hasQuota ? `剩余 <b>${v.remaining}</b> ${QUOTA_LABELS[m].unit}` : '未分配'}</span></div>
      <div class="quota-bar" role="img" aria-label="${QUOTA_LABELS[m].label}已用 ${pct}%"><i style="width:${pct}%"></i></div>
      <div class="quota-row__meta">已用 ${v.used} / 共 ${v.allocated} ${QUOTA_LABELS[m].unit}${low ? ' · <span class="quota-row__warn">即将用完，请联系管理员追加</span>' : ''}</div>
    </div>`;
  }).join('');
  return `${rows}<p class="muted quota-note">数字为本平台内部台账（管理员分配、真实调用消耗，失败自动退回），底层厂商额度以如影控制台为准。</p><a class="btn card__foot-btn" href="${PRODUCT.consoleUrl}" target="_blank" rel="noreferrer">打开如影控制台<span class="sr-only">（新窗口打开）</span></a>`;
}

function emptyState(title, text, action = '') {
  return `<div class="empty"><p class="empty__title">${esc(title)}</p><p>${esc(text)}</p>${action ? `<div class="empty__action">${action}</div>` : ''}</div>`;
}

function workOpen(w) {
  return w.kind === 'text'
    ? `<button class="btn btn--sm" type="button" data-work-view="${w.id}">查看</button>`
    : `<a class="btn btn--sm" href="${esc(w.url)}" target="_blank" rel="noreferrer">打开<span class="sr-only">${esc(w.title)}（新窗口）</span></a>`;
}

function worksTable(list, { withDelete = false } = {}) {
  return `<ul class="work-list">${list.map((w) => `<li class="work-item">
      <div class="work-item__main"><b>${esc(w.title)}</b>
        <span class="work-item__meta">${esc(w.type)} · ${w.mode === 'real' ? '真实环境' : '演示样例'} · ${esc(w.createdAt)} · 剩余 ${w.days} 天</span></div>
      <div class="work-item__actions">${workOpen(w)}${withDelete ? `<button class="btn btn--sm" type="button" data-del="${w.id}" aria-label="删除作品：${esc(w.title)}">删除</button>` : ''}</div>
    </li>`).join('')}</ul>`;
}

export function createView(s) {
  const tabs = EXPERIENCES.filter((e) => canUse(s, SHORTCUT_MODULE[e.id]));
  if (!tabs.length) return `<div class="console"><div class="card">${emptyState('创作中心没有可用的能力', '你的企业没有开通视频口播、语音合成或知识库问答。可以在能力目录里查看已开通的能力。', '<a class="btn btn--primary btn--sm" href="#catalog" data-view="catalog">打开能力目录</a>')}</div></div>`;
  const active = tabs.some((e) => e.id === s.createTab) ? s.createTab : tabs[0].id;
  return `<div class="console">
    <div class="create-tabs" role="tablist" aria-label="创作类型">${tabs.map((e) => `<button class="create-tab ${active === e.id ? 'is-active' : ''}" type="button" role="tab" aria-selected="${active === e.id}" data-create="${e.id}"><span aria-hidden="true">${e.icon}</span> ${esc(e.name)}</button>`).join('')}</div>
    <div role="tabpanel">${active === 'video' ? videoPanel(s) : active === 'voice' ? voicePanel(s) : kbPanel(s)}</div>
  </div>`;
}

function videoPanel(s) {
  const v = s.video;
  const n = words(v.text);
  const busy = v.phase === 'tts' || v.phase === 'submit' || v.phase === 'poll';
  const stage = { tts: '正在合成配音', submit: '正在提交生成任务', poll: v.stage || '等待平台开始' }[v.phase];
  return `<div class="card"><div class="card__title"><h2><label for="video-text">口播文案</label></h2>
      <span class="pill ${n > 200 ? 'pill--err' : 'pill--info'}" id="video-count">${n} / 200 字 · 约 ${estimateSeconds(v.text)} 秒</span></div>
    <textarea class="editor" id="video-text" data-bind="video.text" rows="4" maxlength="400" ${busy ? 'disabled' : ''} placeholder="例如：新款智能手表上市，支持全天心率监测与运动记录…">${esc(v.text)}</textarea>
    <p class="field-hint">${isReal(s) ? '使用服务端配置的平台音色与数字人形象生成。' : '演示环境使用本地样例音频与视频，不调用平台。'}</p>
    ${isReal(s) ? `<div class="form-field"><label for="video-image">数字人形象图地址</label>
      <input class="input" id="video-image" data-bind="video.imageUrl" value="${esc(v.imageUrl || '')}" placeholder="https://…/portrait.png" ${busy ? 'disabled' : ''} />
      <p class="field-hint">一张人像照片地址，需可公网访问；留空则用管理员在「厂商凭据」里配置的默认形象图。</p></div>` : ''}
    <div class="actions">
      <button class="btn" type="button" data-action="fill-sample" ${busy ? 'disabled' : ''}>填入示例</button>
      <button class="btn btn--primary" type="button" data-action="run-video" ${busy ? 'disabled aria-busy="true"' : ''}>${busy ? '生成中…' : '生成视频'}</button>
    </div>
    ${v.inputError ? `<p class="field-error" role="alert">${esc(v.inputError)}</p>` : ''}
    ${busy ? taskProgress({ stage, elapsed: v.startedAt ? Date.now() - v.startedAt : 0, queued: v.queued, stopAction: v.phase === 'poll' ? 'stop-video' : '', key: 'video' }) : ''}
    ${v.error ? errorBlock(v.error, { retry: 'run-video', resume: 'resume-video' }) : ''}
  </div>
  ${v.result ? `<div class="card" id="video-result"><div class="card__title"><h2>生成结果</h2>${resultModeTag(v.result.mode)}</div>
    <video controls playsinline preload="metadata" ${v.result.thumbUrl ? `poster="${esc(v.result.thumbUrl)}"` : ''} src="${esc(v.result.videoUrl)}" class="media-video" aria-label="生成的数字人口播视频"></video>
    <div class="actions"><button class="btn" type="button" data-action="save-video">保存到作品</button>
      <a class="btn" href="${esc(v.result.videoUrl)}" download>下载视频</a>
      <button class="btn" type="button" data-action="run-video">重新生成</button></div>
    ${interpret(INTERPRET.avatar(v.result))}</div>` : ''}`;
}

function interpret(lines) {
  return `<dl class="interpret">${lines.map((l) => `<div class="line"><dt>${esc(l.label)}</dt><dd>${esc(l.text)}</dd></div>`).join('')}</dl>`;
}

function voicePanel(s) {
  const v = s.voice;
  const n = words(v.text);
  return `<div class="card"><div class="card__title"><h2><label for="voice-text">要合成的文字</label></h2><span class="pill ${n > 200 ? 'pill--err' : 'pill--info'}" id="voice-count">${n} / 200 字</span></div>
    <textarea class="editor" id="voice-text" data-bind="voice.text" rows="3" maxlength="400" ${v.busy ? 'disabled' : ''}>${esc(v.text)}</textarea>
    <p class="field-hint">${isReal(s) ? '使用服务端配置的平台音色（QID）合成。' : '演示环境返回本地样例音频，时长按字数估算。'}</p>
    <div class="actions"><button class="btn btn--primary" type="button" data-action="run-voice" ${v.busy ? 'disabled aria-busy="true"' : ''}>${v.busy ? '合成中…' : '合成语音'}</button></div>
    ${v.inputError ? `<p class="field-error" role="alert">${esc(v.inputError)}</p>` : ''}
    ${v.busy ? loadingBlock(isReal(s) ? '平台正在合成配音，通常需要几秒到几十秒…' : '正在合成…') : ''}
    ${v.error ? errorBlock(v.error, { retry: 'run-voice' }) : ''}
    ${v.result ? `<div class="result-block"><div class="result-block__head">${resultModeTag(v.result.mode)}</div>
      <audio controls src="${esc(v.result.audio_url)}" class="media-audio" aria-label="合成的语音"></audio>
      <div class="actions"><button class="btn" type="button" data-action="save-voice">保存到作品</button>
        <a class="btn" href="${esc(v.result.audio_url)}" download>下载音频</a></div>
      ${interpret(INTERPRET.voice(v.result))}</div>` : ''}
  </div>`;
}

function kbPanel(s) {
  const k = s.kb;
  const c = s.chat;
  const docs = k.docs;
  const docList = !k.loaded
    ? (k.loadError ? errorBlock(k.loadError, { retry: 'kb-reload' }) : loadingBlock('正在读取知识库…'))
    : docs.length
      ? `<ul class="doc-list">${docs.map((d) => `<li class="doc-item"><div><b>${esc(d.name)}</b><span class="muted">${d.chars.toLocaleString()} 字 · ${d.chunkCount} 个片段</span></div>
          <button class="btn btn--sm" type="button" data-kb-del="${d.id}" ${k.deleting === d.id ? 'disabled' : ''} aria-label="删除资料：${esc(d.name)}">${k.deleting === d.id ? '删除中…' : '删除'}</button></li>`).join('')}</ul>`
      : emptyState('知识库还是空的', '上传一份产品手册、FAQ 或课程讲义（.txt / .md），问答会只依据这些资料回答。');
  const uploads = k.uploads.map((u) => `<li class="upload-item ${u.state}">
      <span class="upload-item__name">${esc(u.name)}</span>
      ${u.state === 'uploading' ? `<span class="upload-bar" role="progressbar" aria-valuenow="${u.progress}" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(u.name)} 上传进度"><i style="width:${u.progress}%"></i></span><span class="muted">${u.progress}%</span>` : ''}
      ${u.state === 'done' ? '<span class="ok">已加入知识库</span>' : ''}
      ${u.state === 'error' ? `<span class="upload-item__err">${esc(u.message)}</span>` : ''}
    </li>`).join('');

  const empty = k.loaded && !docs.length;
  const messages = c.messages.length
    ? c.messages.map((m) => `<div class="msg msg--${m.role}"><span class="msg__role">${m.role === 'user' ? '我' : '助手'}</span>
        <div class="msg__body">${m.notice ? `<p class="msg__notice">${esc(m.notice)}</p>` : ''}${m.text ? `<div class="msg__text">${esc(m.text)}</div>` : (c.streaming && m.pending ? `<span class="typing">${spinner} 正在检索资料…</span>` : '')}
          ${m.sources?.length ? `<div class="msg__sources">依据：${m.sources.map((x) => `<span>《${esc(x.docName)}》${x.heading && x.heading !== x.docName.replace(/\.[^.]+$/, '') ? ` · ${esc(x.heading)}` : ''}</span>`).join('')}</div>` : ''}
          ${m.error ? errorBlock(m.error, { retry: 'chat-retry' }) : ''}</div></div>`).join('')
    : (empty ? emptyState('先上传资料，再来提问', '知识库为空时无法回答问题。上传后可以问资料里的任何内容。')
      : emptyState('问一个资料里的问题', '回答只依据你上传的资料；资料里没有的内容，会直接告诉你没有。'));

  return `<div class="kb-layout">
    <section class="card kb-docs" aria-labelledby="kb-title"><div class="card__title"><h2 id="kb-title">我的知识库</h2>${k.loaded ? `<span class="pill pill--info">${docs.length} 份</span>` : ''}</div>
      <label class="dropzone ${k.dragging ? 'is-drag' : ''}" for="kb-file" data-dropzone>
        <input class="sr-only" type="file" id="kb-file" accept=".txt,.md,.markdown,text/plain,text/markdown" multiple />
        <b>拖拽文件到这里，或点击选择</b>
        <span>支持 .txt / .md，UTF-8 编码，单个文件 1MB 以内</span>
      </label>
      ${uploads ? `<ul class="upload-list" aria-live="polite">${uploads}</ul>` : ''}
      ${docList}
      <p class="field-hint">资料只保存在本服务器，按浏览器隔离，其他访客看不到。</p>
    </section>
    <section class="card kb-chat" aria-labelledby="chat-title"><div class="card__title"><h2 id="chat-title">基于资料提问</h2>
        <span class="pill ${c.streaming ? 'pill--warn' : 'pill--info'}">${c.streaming ? '回答中' : isReal(s) && s.config?.llmConfigured ? '大模型作答' : '原文摘录'}</span></div>
      <div class="chat" id="chat-box" aria-live="polite">${messages}</div>
      <div class="chat-input">
        <label class="sr-only" for="chat-input">输入问题</label>
        <input class="input" id="chat-input" data-bind="chat.input" placeholder="${empty ? '请先上传资料' : '输入问题，按回车发送'}" value="${esc(c.input)}" maxlength="500" ${c.streaming ? 'disabled' : ''} />
        ${c.streaming
          ? '<button class="btn" type="button" data-action="chat-stop">停止</button>'
          : `<button class="btn btn--primary" type="button" data-action="chat-send" ${empty ? 'disabled' : ''}>发送</button>`}
      </div>
      <p class="field-hint">${isReal(s) && s.config?.llmConfigured ? '真实环境：检索到相关资料后由 DeepSeek 依据资料生成回答。' : '当前不调用大模型：检索到相关资料后直接摘录原文作答。'}</p>
    </section>
  </div>`;
}

export function tasksView(s) {
  const ws = s.works;
  return `<div class="console"><div class="card"><div class="card__title"><h2>我的作品</h2>
      ${ws.length ? `<button class="btn btn--sm" type="button" data-action="works-clear">全部清空</button>` : ''}</div>
    ${ws.length ? worksTable(ws, { withDelete: true }) : emptyState('还没有保存的作品', '在创作中心或能力体验里生成结果后，点「保存到作品」即可在这里找回。', '<a class="btn btn--primary btn--sm" href="#create" data-view="create">去创作中心</a>')}
    <p class="hint-block">作品记录保存在本机浏览器，7 天后自动清除，最多保留 30 条；清除浏览器数据会一并删除。真实环境的文件链接有效期以如影平台为准。</p></div></div>`;
}

export function catalogView(s) {
  const filter = s.capFilter || 'all';
  const list = filter === 'all' ? CAPABILITIES : CAPABILITIES.filter((c) => c.group === filter);
  return `<div class="console">${filterRow(filter)}${capTable(list, s)}
    ${s.me?.access?.kind === 'tenant' ? `<p class="hint-block">已开通 ${allowedModules(s).length} / ${CAPABILITIES.length} 项能力；未开通的能力请联系企业管理员或商予科技。</p>` : ''}</div>`;
}

export function settingsView(s) {
  const cfg = s.config;
  if (!cfg) return `<div class="console">${s.configError ? errorBlock(s.configError, { retry: 'reload-config' }) : loadingBlock('正在读取环境配置…')}</div>`;
  const real = isReal(s);
  const t = s.token;
  const yes = (v, a = '已配置', b = '未配置') => (v ? `<span class="ok">${a}</span>` : `<span class="muted">${b}</span>`);
  let tokenBody;
  if (s.me?.user?.role !== 'super_admin' && s.me?.user) {
    tokenBody = '<p class="muted">平台 Token 由商予科技统一从如影获取并管理，你和企业成员不需要处理，也看不到 Token 原文。</p>';
  } else if (!s.me?.user) {
    tokenBody = '<p class="muted">访客只能使用演示环境，不需要 Token。</p>';
  } else if (!real) {
    tokenBody = '<p class="muted">演示环境不调用如影平台，因此不需要 Token。切换到真实环境后，这里会显示 Token 的状态与过期时间，并可以在线获取。各厂商凭据的 Token 可在「厂商凭据」页查看。</p>';
  } else if (t.loading && !t.data) {
    tokenBody = loadingBlock('正在读取 Token 状态…');
  } else {
    const d = t.data || {};
    const remain = d.remainSec ? `${Math.floor(d.remainSec / 3600)} 小时 ${Math.floor((d.remainSec % 3600) / 60)} 分` : '—';
    const time = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
    tokenBody = `<table class="table kv-table"><tbody>
        <tr><th scope="row">状态</th><td>${d.hasToken ? '<span class="ok">有效</span>' : '<span class="muted">尚未获取</span>'}</td></tr>
        <tr><th scope="row">Token</th><td><code>${esc(d.tokenMasked || '—')}</code></td></tr>
        <tr><th scope="row">剩余有效期</th><td>${remain}</td></tr>
        <tr><th scope="row">过期时间</th><td>${time(d.expiresAt)}</td></tr>
        <tr><th scope="row">计划更换</th><td>${d.hasToken ? `${time(d.refreshAt)}（过期前 30 分钟）` : '—'}</td></tr>
        <tr><th scope="row">最近一次失败</th><td>${d.lastError ? `<span class="warn">${esc(d.lastError.message)}（${time(d.lastError.at)}）</span>` : '无'}</td></tr>
      </tbody></table>
      <div class="actions">
        <button class="btn btn--primary" type="button" data-action="token-fetch" ${t.loading ? 'disabled aria-busy="true"' : ''}>${t.loading ? '获取中…' : d.hasToken ? '刷新状态' : '获取 Token'}</button>
        ${d.hasToken ? `<button class="btn" type="button" data-action="token-force" ${t.loading ? 'disabled' : ''}>立即更换 Token</button>` : ''}
      </div>
      ${t.error ? errorBlock(t.error, { retry: 'token-fetch' }) : ''}`;
  }
  return `<div class="console">
    <div class="grid-2">
      <div class="card"><div class="card__title"><h2>运行环境</h2></div>
        <p class="muted">只影响你当前的浏览器。真实环境会调用如影平台线上接口，生成类操作可能产生费用。</p>
        <div class="mode-cards" role="radiogroup" aria-label="运行环境">
          <button class="mode-card ${!real ? 'is-on' : ''}" type="button" role="radio" aria-checked="${!real}" data-mode="mock" ${s.modeSwitching ? 'disabled' : ''}><b>演示环境</b><span>本地样例 · 不计费 · 免配置</span></button>
          <button class="mode-card ${real ? 'is-on' : ''}" type="button" role="radio" aria-checked="${real}" data-mode="real" ${s.modeSwitching || !cfg.realAvailable ? 'disabled' : ''}><b>真实环境</b><span>${cfg.realAvailable ? '线上接口 · 按量计费' : esc(cfg.realReason || (s.me?.user ? '服务端未配置凭据，暂不可用' : '登录并开通后可用'))}</span></button>
        </div>
        ${s.modeSwitching ? loadingBlock('正在切换环境…') : ''}
        ${s.modeError ? errorBlock(s.modeError) : ''}
      </div>
      <div class="card"><div class="card__title"><h2>接入状态</h2></div>
        <table class="table kv-table"><tbody>
          <tr><th scope="row">平台凭据</th><td>${cfg.vendorManaged ? (cfg.realAvailable ? '<span class="ok">已由商予科技分配</span>' : '<span class="muted">未分配</span>') : cfg.realAvailable ? `<code>${esc(cfg.appIdMasked)}</code>` : '<span class="muted">未配置</span>'}</td></tr>
          <tr><th scope="row">配音音色</th><td>${yes(cfg.ttsConfigured)}</td></tr>
          <tr><th scope="row">数字人形象图</th><td>${yes(cfg.avatarImageConfigured)}</td></tr>
          <tr><th scope="row">问答大模型</th><td>${yes(cfg.llmConfigured, '已配置 DeepSeek')}</td></tr>
          <tr><th scope="row">计费接口</th><td>${cfg.allowBillable ? '<span class="warn">已放行</span>' : '<span class="ok">受保护（拒绝调用）</span>'}</td></tr>
        </tbody></table>
        <p class="field-hint">所有凭据只保存在服务端环境变量中，这里仅显示是否配置。</p>
      </div>
    </div>
    <div class="card"><div class="card__title"><h2>平台 Token</h2>${real ? '<span class="pill pill--ok">真实环境</span>' : '<span class="pill pill--mock">演示环境</span>'}</div>${tokenBody}</div>
  </div>`;
}

/* ============ 覆盖层 ============ */
export function modeDialog(s) {
  const toReal = s.mode !== 'real';
  return `<div class="sheet-mask" data-action="close-dialog"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="mode-dialog-title">
    <h3 id="mode-dialog-title">切换到${toReal ? '真实环境' : '演示环境'}？</h3>
    <p class="muted">${toReal
      ? (s.config?.realAvailable ? '真实环境会调用如影平台线上接口，生成视频等操作会产生费用。只影响你当前的浏览器。' : s.me?.user ? (s.config?.realReason ? `暂时无法切换：${s.config.realReason}。需要开通请联系商予科技。` : '服务端还没有配置如影平台凭据，暂时无法切换到真实环境。') : '访客只能使用演示环境。已开通真实环境的客户请先登录。')
      : '演示环境使用本地样例，不调用平台、不产生费用。'}</p>
    <div class="actions">
      ${toReal && !s.config?.realAvailable ? '' : `<button class="btn btn--primary" type="button" data-action="confirm-mode" data-autofocus>确认切换</button>`}
      <button class="btn" type="button" data-action="close-dialog" ${toReal && !s.config?.realAvailable ? 'data-autofocus' : ''}>${toReal && !s.config?.realAvailable ? '知道了' : '取消'}</button>
    </div></div>`;
}

export function workDialog(w) {
  return `<div class="sheet-mask" data-action="close-dialog"></div>
  <div class="sheet sheet--wide" role="dialog" aria-modal="true" aria-labelledby="work-dialog-title">
    <h3 id="work-dialog-title">${esc(w.title)}</h3>
    <pre class="json-block">${esc(w.text)}</pre>
    <div class="actions"><button class="btn btn--primary" type="button" data-action="close-dialog" data-autofocus>关闭</button></div></div>`;
}

export function tourCard(index) {
  const step = TOUR_STEPS[index];
  return `<div class="tour-card" role="dialog" aria-labelledby="tour-title"><h4 id="tour-title">${index + 1}/${TOUR_STEPS.length} · ${esc(step.title)}</h4><p>${esc(step.text)}</p>
    <div class="actions"><button class="btn btn--primary btn--sm" type="button" data-action="tour-next">${index + 1 === TOUR_STEPS.length ? '完成' : '下一步'}</button>
    <button class="btn btn--sm" type="button" data-action="tour-skip">跳过</button></div></div>`;
}
