// views.js —— 视图渲染（纯函数：state → HTML）
// 外壳（顶栏/页脚，含双 logo）只在启动时渲染一次；这里的函数只负责动态内容区与覆盖层。
import { PRODUCT, BRAND_LOGOS, MODE_NOTICE, navFor, navById, SHORTCUT_MODULE, roleLabel } from './product.js';
import { GROUPS, CAPABILITIES, SCENARIOS, INTEGRATION_STEPS, GUIDED_PATH, capsOf, stats, capById, groupOf, OUTPUT_LABEL } from './capabilities.js';
import { backLabelFor } from './navstack.js';
import { INTERPRET, TOUR_STEPS } from './guide.js';
import { EXPERIENCES, estimateSeconds } from './wizard.js';
import { experienceView } from './experience.js'; // 创作中心后两个快捷入口嵌通用体验器（experience.js 只在调用时用 views 的 errorBlock，循环引用安全）
import { esc, words } from './html.js';
import { downloadName } from './works.js';

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
  const school = !!me.teaching?.isSchool;
  const home = u.role === 'super_admin' ? 'admin' : u.role === 'tenant_admin' ? 'org' : 'account';
  return `<a class="user-chip" href="#${home}" data-view="${home}" title="${esc(roleLabel(u.role, school))}">
      <span class="user-chip__avatar" aria-hidden="true">${esc((u.displayName || u.username).slice(0, 1).toUpperCase())}</span>
      <span class="user-chip__text"><b>${esc(u.displayName || u.username)}</b><small>${esc(me.tenant?.name || roleLabel(u.role, school))}</small></span></a>`;
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
/** 加载块；tipKey 非空时在行内留一个等待提示位（由每秒走字的 ticker 按 WAIT_TIPS 档位填文案） */
export function loadingBlock(text, tipKey = '', variant = 'spinner') {
  if (variant === 'skeleton') {
    // 骨架屏：装饰块对读屏隐藏，文字说明保留在 sr-only 里；rows 控制行数
    return `<div class="loading loading--skeleton" role="status" aria-busy="true"><span class="sr-only">${esc(text)}</span><div aria-hidden="true"><span class="skeleton skeleton--line" style="width:38%"></span><span class="skeleton skeleton--row"></span><span class="skeleton skeleton--row"></span><span class="skeleton skeleton--row"></span></div></div>`;
  }
  return `<div class="loading" role="status">${spinner}<span>${esc(text)}</span>${tipKey ? ` <span data-wait-tip="${tipKey}"></span>` : ''}</div>`;
}
/** 列表/整页首次加载用骨架屏的简写 */
export const skeletonBlock = (text) => loadingBlock(text, '', 'skeleton');
const fmtElapsed = (ms) => { const s = Math.floor(ms / 1000); return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`; };

/** 进行中的任务：阶段、已等待时间、平台排队提示、停止等待；等待提示位由 ticker 按档位填文案 */
function taskProgress({ stage, elapsed = 0, queued = false, stopAction, key }) {
  return `<div class="task-progress" role="status" aria-live="polite">
    <div class="task-progress__head">${spinner}<b>${esc(stage)}</b><span class="muted" data-elapsed="${key}">已等待 ${fmtElapsed(elapsed)}</span>
      ${stopAction ? `<button class="btn btn--sm btn--ghost" data-action="${stopAction}">停止等待</button>` : ''}</div>
    <span class="task-progress__tip" data-wait-tip="${key}"></span>
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
          <a class="btn btn--lg btn--outline" href="#create" data-view="create">查看全部能力</a>
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
        <p>6 大类 24 项能力：从形象、音色到成片、互动，可单独调用，也可组合集成。</p></div>
        <a class="btn" href="#create" data-view="create">全部能力</a></div>
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

/** 能力矩阵「需要准备」列：每项能力的前置条件，一眼看出要先准备什么 */
function needsHtml(c) {
  const reqs = c.experience?.requires || [];
  if (!reqs.length) return '—';
  return reqs.map((r) => esc(r.text)).join('<br>');
}

function capTable(list, s) {
  return `<div class="table-scroll"><table class="table cap-table">
    <caption class="sr-only">能力列表</caption>
    <thead><tr><th scope="col">能力</th><th scope="col">所属</th><th scope="col">说明 / 场景</th><th scope="col">输出</th><th scope="col">接口</th><th scope="col">需要准备</th><th scope="col"><span class="sr-only">操作</span></th></tr></thead>
    <tbody>${list.map((c) => `<tr>
      <td data-label="能力"><b>${esc(c.name)}</b>${c.tag ? `<span class="tag">${esc(c.tag)}</span>` : ''}</td>
      <td data-label="所属">${esc(groupOf(c.group)?.name ?? '')}</td>
      <td data-label="说明"><span class="muted">${esc(c.desc)}</span><small class="cell-scene">${esc(c.scene)}</small></td>
      <td data-label="输出"><span class="status st-ready">${OUTPUT_LABEL[c.experience?.output] || '文本'}</span></td>
      <td data-label="接口"><code class="code-sm">${esc(c.api)}</code></td>
      <td data-label="需要准备"><small class="cell-needs">${needsHtml(c)}</small></td>
      <td>${canUse(s, c.id) ? `<button class="btn btn--sm btn--primary" type="button" data-use="${c.id}" aria-label="体验${esc(c.name)}">体验</button>` : `<span class="pill pill--lock" title="你的企业未开通这项能力">未开通</span>`}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function filterRow(filter) {
  return `<div class="filter-row" role="group" aria-label="按能力大类筛选">
    <button class="chip ${filter === 'all' ? 'is-on' : ''}" type="button" data-filter="all" aria-pressed="${filter === 'all'}">全部 ${CAPABILITIES.length}</button>
    ${GROUPS.map((g) => `<button class="chip ${filter === g.id ? 'is-on' : ''}" type="button" data-filter="${g.id}" aria-pressed="${filter === g.id}">${esc(g.name)} ${capsOf(g.id).length}</button>`).join('')}
  </div>`;
}

/** 能力矩阵已并进创作中心下方：推荐上手顺序 + 大类筛选 + 7 列能力表，原样复用 */
function matrixSection(s) {
  const filter = s.capFilter || 'all';
  const list = filter === 'all' ? CAPABILITIES : CAPABILITIES.filter((c) => c.group === filter);
  // 推荐上手顺序原先在能力目录里：能力目录与能力矩阵是同一张表，已合并，入口只剩创作中心
  const guided = filter === 'all' ? `<div class="card guided-path"><div class="card__title"><h2>推荐上手顺序</h2><span class="pill pill--info">第一次用，按这个顺序走</span></div>
    <ol class="steps-grid">${GUIDED_PATH.map((step, i) => { const c = capById(step.cap); return `<li class="step-card"><span class="step-card__n" aria-hidden="true">${i + 1}</span><h3>${esc(c?.name || step.cap)}</h3><p>${esc(step.why)}</p>${c ? `<button class="btn btn--sm btn--primary" type="button" data-use="${c.id}">去体验</button>` : ''}</li>`; }).join('')}</ol></div>` : '';
  return `<div class="card"><div class="card__title"><h2>全部能力</h2><span class="pill pill--info">${CAPABILITIES.length} 项</span></div>
    <p class="muted">上面五个是常用的快捷入口；下面是平台全部 ${CAPABILITIES.length} 项能力，按 6 大类列出，点一下直接去体验。</p></div>
    ${guided}${filterRow(filter)}${capTable(list, s)}
    <p class="hint-block">能力口径依据如影平台官方产品文档整理。演示环境返回本地样例，真实环境的可用范围以你的平台账号开通情况为准。</p>`;
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
  const active = s.view.startsWith('admin/tenant') ? 'admin/tenants' : s.view === 'experience' ? 'create' : s.view;
  return `<nav class="sidenav" aria-label="工作台">${navFor(s.me?.user?.role, { isSchool: !!s.me?.teaching?.isSchool }).map((sec) => `
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

/** 返回按钮的目标：有历史回上一个页面；没历史时体验页回创作中心、后台深层页回父列表；其余不显示 */
export function backTargetFor(s) {
  const stack = s.backStack || [];
  if (stack.length) return { target: stack[stack.length - 1], label: backLabelFor(stack[stack.length - 1]) };
  if (s.view === 'experience') return { target: 'create', label: '返回创作中心' };
  if (s.view && s.view.includes('/')) {
    const parent = s.view.slice(0, s.view.lastIndexOf('/'));
    if (navById(parent)) return { target: parent, label: backLabelFor(parent) };
  }
  return null;
}

export function consoleBar(s, title) {
  const back = backTargetFor(s);
  return `<div class="console-bar"><div class="console-bar__left">${back ? `<button class="btn btn--sm" type="button" data-action="nav-back">← ${esc(back.label)}</button>` : ''}<h1>${esc(title)}</h1></div>
    <div class="console-bar__right"><span class="pill ${isReal(s) ? 'pill--ok' : 'pill--mock'}">${isReal(s) ? '真实环境 · 可能计费' : '演示环境 · 不计费'}</span></div></div>`;
}

export function overviewView(s) {
  const recent = s.works.slice(0, 5);
  const kbCount = s.kb.loaded ? s.kb.docs.length : '—';
  return `<div class="console">
    <div class="kpi-grid">
      <div class="kpi"><span>可用能力</span><b>${allowedModules(s).length}</b><small>共 ${CAPABILITIES.length} 项平台能力</small></div>
      <div class="kpi"><span>我的作品</span><b>${s.works.length}</b><small>${s.me?.user ? '保存在账号里 · 换电脑不丢' : '保存在本机 · 7 天有效'}</small></div>
      <div class="kpi"><span>知识库资料</span><b>${kbCount}</b><small>${s.me?.access?.kind === 'tenant' ? `本${s.me?.teaching?.isSchool ? '校' : '企业'}成员共享` : '仅你自己可见'}</small></div>
      <div class="kpi"><span>运行环境</span><b class="kpi__mode">${isReal(s) ? '真实' : '演示'}</b><small><a href="#settings" data-view="settings">切换环境</a></small></div>
    </div>
    <div class="grid-2">
      <div class="card"><div class="card__title"><h2>快速开始</h2></div>
        <div class="quick-list">${EXPERIENCES.filter((e) => canUse(s, SHORTCUT_MODULE[e.id])).map((e) => `
          <button class="quick-item" type="button" data-experience="${e.id}"><span class="quick-item__icon" aria-hidden="true">${e.icon}</span>
            <span><b>${esc(e.name)}</b><small>${esc(e.desc)}</small></span></button>`).join('') || '<p class="muted">你的企业没有开通创作中心的快捷能力，可以在<a href="#create" data-view="create">创作中心</a>下方查看已开通的能力。</p>'}</div></div>
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
  // 未登录才提示去登录；已登录但拿不到额度是后端问题，不能再让人去登录。
  if (!s.me?.user) return `<p class="muted">登录后可查看你所在企业的剩余额度。</p><a class="btn card__foot-btn" href="#login" data-view="login">去登录</a>`;
  if (!q || !q.items) return `<p class="muted">暂时无法获取额度信息，请稍后刷新重试。</p>`;
  if (q.error && (!Array.isArray(q.items) || q.items.length === 0)) return `<p class="muted">${esc(q.error)}</p>`;
  // 两种形状统一成数组：租户是按计量键的对象，超级管理员是厂商实时额度的数组。
  const items = Array.isArray(q.items)
    ? q.items
    : Object.keys(QUOTA_LABELS).map((m) => ({ key: m, label: QUOTA_LABELS[m].label, unit: QUOTA_LABELS[m].unit, ...(q.items[m] || { allocated: 0, used: 0, remaining: 0 }) }));
  const anyAllocated = items.some((it) => (it.allocated || 0) > 0);
  if (q.kind === 'tenant' && !anyAllocated) return `<p class="muted">你的企业尚未分配额度，请联系企业管理员或商予科技。</p><a class="btn card__foot-btn" href="${PRODUCT.consoleUrl}" target="_blank" rel="noreferrer">打开如影控制台<span class="sr-only">（新窗口打开）</span></a>`;
  const rows = items.map((v) => {
    const pct = v.allocated > 0 ? Math.min(100, Math.round((v.used / v.allocated) * 100)) : 0;
    const low = (q.low || []).includes(v.key);
    const hasQuota = v.allocated > 0;
    return `<div class="quota-row${low ? ' quota-row--low' : ''}">
      <div class="quota-row__head"><b>${esc(v.label)}</b>
        <span class="quota-row__remain">${hasQuota ? `剩余 <b>${v.remaining}</b> ${esc(v.unit)}` : '未开通'}</span></div>
      <div class="quota-bar" role="img" aria-label="${esc(v.label)}已用 ${pct}%"><i style="width:${pct}%"></i></div>
      <div class="quota-row__meta">已用 ${v.used} / 共 ${v.allocated} ${esc(v.unit)}${low ? ' · <span class="quota-row__warn">即将用完，请联系管理员追加</span>' : ''}</div>
    </div>`;
  }).join('');
  const note = q.kind === 'vendor'
    ? '数字为如影厂商实时额度（直接向平台查询，含已用与剩余），厂商侧如有调整以如影控制台为准。'
    : '数字为本平台内部台账（管理员分配、真实调用消耗，失败自动退回），底层厂商额度以如影控制台为准。';
  return `${rows}<p class="muted quota-note">${note}</p><a class="btn card__foot-btn" href="${PRODUCT.consoleUrl}" target="_blank" rel="noreferrer">打开如影控制台<span class="sr-only">（新窗口打开）</span></a>`;
}

function emptyState(title, text, action = '') {
  return `<div class="empty"><p class="empty__title">${esc(title)}</p><p>${esc(text)}</p>${action ? `<div class="empty__action">${action}</div>` : ''}</div>`;
}

function workOpen(w) {
  if (w.kind === 'text') return `<button class="btn btn--sm" type="button" data-work-view="${w.id}">查看</button>`;
  // 视频/音频/图片：页内预览弹窗，不再直接跳新窗口
  return `<button class="btn btn--sm" type="button" data-work-view="${w.id}">预览</button>`;
}

/** 作品的教学状态：未提交 / 已提交待批改 / 已批改（含分数） */
function workStatusPill(w) {
  if (w.review) return `<span class="pill pill--ok">已批改 · ${w.review.score} 分</span>`;
  if (w.submittedAt) return '<span class="pill pill--info">已提交 · 待批改</span>';
  return '';
}

/** 作品标题展示：旧版硬截 20 字无省略号（如“…监测与”），展示时补 …；新版已带 …，不重复。 */
const workDisplayTitle = (w) => {
  const t = String(w.title || '');
  return t.length === 20 && !/[。！？…]$/.test(t) ? t + '…' : t;
};
function worksTable(list, { withDelete = false, canSubmit = false } = {}) {
  return `<ul class="work-list">${list.map((w) => `<li class="work-item">
      <div class="work-item__main"><span class="work-item__title"><b>${esc(workDisplayTitle(w))}</b>${workStatusPill(w)}</span>
        <span class="work-item__meta">${esc(w.type)} · ${w.mode === 'real' ? '真实环境' : '演示样例'} · ${esc(w.createdAt)}${w.remote ? '' : ` · 剩余 ${w.days} 天`}</span>
        ${w.review?.comment ? `<span class="work-item__comment">评语：${esc(w.review.comment)}</span>` : ''}</div>
      <div class="work-item__actions">${workOpen(w)}${w.url && w.kind !== 'text' ? `<a class="btn btn--sm" href="${esc(w.url)}" download="${esc(downloadName(w, w.url, w.kind === 'audio' ? 'mp3' : w.kind === 'image' ? 'png' : 'mp4'))}">下载</a>` : ''}${withDelete ? `${
        canSubmit && w.remote && !w.submittedAt ? `<button class="btn btn--sm btn--primary" type="button" data-action="work-submit" data-id="${w.id}" aria-label="提交给老师：${esc(w.title)}">提交给老师</button>` : ''}${
        w.submittedAt && !w.review ? `<button class="btn btn--sm" type="button" data-action="work-withdraw" data-id="${w.id}" aria-label="撤回提交：${esc(w.title)}">撤回</button>` : ''
      }<button class="btn btn--sm" type="button" data-rename="${w.id}" aria-label="给作品改名：${esc(w.title)}">改名</button>${
        w.review ? '' : `<button class="btn btn--sm" type="button" data-del="${w.id}" aria-label="删除作品：${esc(w.title)}">删除</button>`}` : ''}</div>
    </li>`).join('')}</ul>`;
}

export function createView(s) {
  const tabs = EXPERIENCES.filter((e) => canUse(s, SHORTCUT_MODULE[e.id]));
  // 能力矩阵已并进本页下方：快捷入口在上，全部能力（推荐顺序 + 筛选 + 全量表）在下
  const allCaps = matrixSection(s);
  if (!tabs.length) return `<div class="console"><div class="card">${emptyState('创作中心没有可用的快捷入口', '你的企业没有开通视频口播、语音合成或知识库问答。下面的全部能力里可以查看已开通的能力。', '')}</div>${allCaps}</div>`;
  const active = tabs.some((e) => e.id === s.createTab) ? s.createTab : tabs[0].id;
  const tab = EXPERIENCES.find((e) => e.id === active);
  // 带 cap 的快捷入口嵌通用体验器（与能力体验页同一套表单与提交链路）
  const panel = active === 'video' ? videoPanel(s) : active === 'voice' ? voicePanel(s) : active === 'chat' ? kbPanel(s) : experienceView(s, capById(tab?.cap || ''), { embedded: true });
  return `<div class="console">
    <div class="create-tabs" role="tablist" aria-label="创作类型">${tabs.map((e) => `<button class="create-tab ${active === e.id ? 'is-active' : ''}" type="button" role="tab" aria-selected="${active === e.id}" data-create="${e.id}"><span aria-hidden="true">${e.icon}</span> ${esc(e.name)}</button>`).join('')}</div>
    <div role="tabpanel">${panel}</div>
    ${allCaps}
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
      <a class="btn" href="${esc(v.result.videoUrl)}" download="${esc(downloadName({ title: String(v.text || '').slice(0, 20) || '视频口播', taskId: v.taskId || '' }, v.result.videoUrl, 'mp4'))}">下载视频</a>
      <button class="btn" type="button" data-action="run-video">重新生成</button></div>
    ${interpret(INTERPRET.avatar(v.result))}</div>` : ''}`;
}

function interpret(lines) {
  return `<dl class="interpret">${lines.map((l) => `<div class="line"><dt>${esc(l.label)}</dt><dd>${esc(l.text)}</dd></div>`).join('')}</dl>`;
}

function voicePanel(s) {
  const v = s.voice;
  const n = words(v.text);
  // 发音人下拉与体验页 voice-tts 同源（/api/voice/list）；未加载时只显示占位，失败时退回默认音色
  const voices = s.voiceOptions;
  const voiceOpts = !voices
    ? '<option value="">正在加载发音人列表…</option>'
    : `<option value="">默认音色（晓悦）</option>${voices.map((x) => `<option value="${esc(x.qid)}" ${v.qid === x.qid ? 'selected' : ''}>${esc(x.materialName || x.voiceName || x.qid)}</option>`).join('')}`;
  const slider = (key, label, min, max, step, minL, maxL, def) => {
    const val = v[key] ?? def;
    return `<div class="form-field"><label for="voice-${key}">${label}</label><div class="range-row"><span class="range-ends" aria-hidden="true">${minL}</span><input class="exp-range" id="voice-${key}" type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-bind="voice.${key}" ${v.busy ? 'disabled' : ''} /><span class="range-ends" aria-hidden="true">${maxL}</span><output class="range-value">${val}</output></div></div>`;
  };
  return `<div class="card"><div class="card__title"><h2><label for="voice-text">要合成的文字</label></h2><span class="pill ${n > 2000 ? 'pill--err' : 'pill--info'}" id="voice-count">${n} / 2000 字</span></div>
    <textarea class="editor" id="voice-text" data-bind="voice.text" rows="3" maxlength="2000" ${v.busy ? 'disabled' : ''}>${esc(v.text)}</textarea>
    <div class="form-field"><label for="voice-qid">发音人</label><select class="input" id="voice-qid" data-bind="voice.qid" ${v.busy ? 'disabled' : ''}>${voiceOpts}</select><p class="field-hint">平台发音人列表（321 项）；留空用默认音色晓悦。${s.voiceListFailed ? '列表加载失败，可直接输入 QID。' : ''}</p></div>
    <div class="form-field"><label for="voice-qid-input">或直接输入 QID</label><input class="input" id="voice-qid-input" data-bind="voice.qidInput" value="${esc(v.qidInput || '')}" placeholder="粘贴发音人 QID（为空时用上方选择）" ${v.busy ? 'disabled' : ''} /><p class="field-hint">对应控制台「输入」模式；填了就以这里为准。</p></div>
    ${slider('speed', '语速', 0.5, 2, 0.05, '快', '慢', 1.25)}
    ${slider('volume', '音量', 1, 400, 1, '小', '大', 200.5)}
    ${slider('pitch', '语调', -60, 60, 1, '低沉', '尖锐', 0)}
    <p class="field-hint">${isReal(s) ? '使用平台发音人合成；语速、音量、语调与控制台一致。' : '演示环境返回本地样例音频，时长按字数估算。'}</p>
    <div class="actions"><button class="btn btn--primary" type="button" data-action="run-voice" ${v.busy ? 'disabled aria-busy="true"' : ''}>${v.busy ? '合成中…' : '合成语音'}</button></div>
    ${v.inputError ? `<p class="field-error" role="alert">${esc(v.inputError)}</p>` : ''}
    ${v.busy ? loadingBlock(isReal(s) ? '平台正在合成配音，通常需要几秒到几十秒…' : '正在合成…', 'voice') : ''}
    ${v.error ? errorBlock(v.error, { retry: 'run-voice' }) : ''}
    ${v.result ? `<div class="result-block"><div class="result-block__head">${resultModeTag(v.result.mode)}</div>
      <audio controls src="${esc(v.result.audio_url)}" class="media-audio" aria-label="合成的语音"></audio>
      <div class="actions"><button class="btn" type="button" data-action="save-voice">保存到作品</button>
        <a class="btn" href="${esc(v.result.audio_url)}" download="${esc(downloadName({ title: String(v.text || '').slice(0, 20) || '语音合成', taskId: '' }, v.result.audio_url, 'mp3'))}">下载音频</a></div>
      ${interpret(INTERPRET.voice(v.result))}</div>` : ''}
  </div>`;
}

function kbPanel(s) {
  const k = s.kb;
  const c = s.chat;
  const docs = k.docs;
  const docList = !k.loaded
    ? (k.loadError ? errorBlock(k.loadError, { retry: 'kb-reload' }) : skeletonBlock('正在读取知识库…'))
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
        <div class="msg__body">${m.notice ? `<p class="msg__notice">${esc(m.notice)}</p>` : ''}${m.text ? `<div class="msg__text">${esc(m.text)}</div>` : (c.streaming && m.pending ? `<span class="typing">${spinner} ${esc(m.tip || '正在检索资料…')}</span>` : '')}
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
  const signedIn = !!s.me?.user;
  const t = s.me?.teaching || {};
  const student = t.isSchool && s.me?.user?.role === 'member';
  const classNote = !student ? '' : t.canSubmit
    ? `<div class="alert alert--info" role="note"><div class="alert__body"><b>你在 ${esc(s.me.user.className)}</b><p>完成实训后，在作品右侧点「提交给老师」。老师批改前可以撤回；批改后这里会显示分数和评语，作品会留档、不能删除。</p></div></div>`
    : '<div class="alert alert--warn" role="note"><div class="alert__body"><b>你还没有被分到班级</b><p>作品可以正常保存，但暂时不能提交。请联系任课教师或学校管理员把你加入班级。</p></div></div>';
  const importNote = signedIn && s.localWorkCount ? `<div class="alert alert--info" role="note"><div class="alert__body"><b>这台电脑上还有 ${s.localWorkCount} 条未登录时保存的作品</b><p>它们只存在这台电脑的浏览器里，7 天后会自动清除。如果是你的作品，可以导入到账号里长期保存。</p></div>
      <button class="btn btn--sm" type="button" data-action="works-import-local">导入到我的账号</button></div>` : '';
  // 2 天内过期提醒（仅本机作品层：未登录时作品只存本机 7 天；登录用户的服务端作品链接有效期以如影平台为准，见下方说明）
  const expiring = !signedIn ? ws.filter((w) => !w.remote && typeof w.days === 'number' && w.days <= 2) : [];
  const expiringNote = expiring.length ? `<div class="alert alert--warn" role="note"><div class="alert__body"><b>有 ${expiring.length} 条本机作品将在 2 天内过期</b><p>本机作品只保存 7 天，到期自动清除，请及时下载留存；登录后保存的作品会进入账号长期保留。</p></div></div>` : '';
  return `<div class="console">${classNote}${importNote}${expiringNote}
    ${s.worksError ? errorBlock(s.worksError, { retry: 'works-reload' }) : ''}
    <div class="card"><div class="card__title"><h2>我的作品</h2>
      ${ws.length ? `<button class="btn btn--sm" type="button" data-action="works-clear">全部清空</button>` : ''}</div>
    ${ws.length ? worksTable(ws, { withDelete: true, canSubmit: !!t.canSubmit }) : emptyState('还没有保存的作品', '在创作中心或能力体验里生成结果后，点「保存到作品」即可在这里找回。', '<a class="btn btn--primary btn--sm" href="#create" data-view="create">去创作中心</a>')}
    <p class="hint-block">${signedIn
      ? '作品保存在你的账号里，换一台电脑登录也能找回，最多保留 500 条。这里保存的是作品记录与文件链接，文件本身仍在如影平台，真实环境的文件链接有效期以如影平台为准，重要作品请及时下载留存。'
      : '你还没有登录：作品记录保存在本机浏览器，7 天后自动清除，最多保留 30 条；清除浏览器数据会一并删除。<a href="#login" data-view="login">登录</a>后保存的作品会进入账号，换电脑也不丢。'}</p></div></div>`;
}

/** 任务中心：平台任务登记列表（创建即入库，重启不丢）；状态/能力筛选、搜索、刷新、保存到作品 */
export function taskCenterView(s) {
  const tc = s.taskCenter;
  const pill = (t) => t.status === 5 ? `<span class="pill pill--ok">${esc(t.statusText || '已完成')}</span>`
    : t.status === 9 ? `<span class="pill pill--err">${esc(t.statusText || '失败')}</span>`
    : t.status === 2 ? `<span class="pill pill--info">${esc(t.statusText || '生成中')}</span>`
    : `<span class="pill pill--warn">${esc(t.statusText || '未开始')}</span>`;
  const resultCell = (t) => {
    const r = t.result;
    if (!r) return '<span class="muted">—</span>';
    if (r.output === 'video' && r.videoUrl) return `<a href="${esc(r.videoUrl)}" target="_blank" rel="noreferrer">查看视频${r.duration ? `（${esc(String(r.duration))} 秒）` : ''}</a>`;
    if (r.output === 'image' && r.imageUrl) return `<a href="${esc(r.imageUrl)}" target="_blank" rel="noreferrer">查看图片</a>`;
    if (r.output === 'audio' && r.audioUrl) return `<a href="${esc(r.audioUrl)}" target="_blank" rel="noreferrer">播放音频</a>`;
    if (r.output === 'json' && r.json?.qid) return `<span>音色 QID <code>${esc(r.json.qid)}</code></span>`;
    if (r.output === 'json' && r.json?.faceFeatureId) return `<span>形象 <code>${esc(r.json.faceFeatureId)}</code></span>`;
    if (r.output === 'json') return '<span class="muted">已完成，详情见平台控制台</span>';
    return '<span class="muted">—</span>';
  };
  const saveable = (t) => t.status === 5 && t.result && (t.result.videoUrl || t.result.imageUrl || t.result.audioUrl);
  const rows = (tc.list || []).map((t) => `<tr>
      <td><code>${esc(t.id)}</code></td><td>${esc(t.capabilityName)}</td><td>${esc(t.name || t.id)}</td><td>${pill(t)}</td>
      <td>${new Date(t.createdAt).toLocaleString('zh-CN', { hour12: false })}</td><td>${resultCell(t)}</td>
      <td><div class="actions actions--inline">${saveable(t) ? `<button class="btn btn--sm" type="button" data-action="taskcenter-save" data-task="${esc(t.id)}">保存到作品</button>` : ''}<button class="btn btn--sm" type="button" data-action="taskcenter-refresh-one" data-task="${esc(t.id)}">刷新</button></div></td>
    </tr>`).join('');
  return `<div class="console"><div class="card"><div class="card__title"><h2>任务中心</h2>
      <button class="btn btn--sm" type="button" data-action="taskcenter-refresh" ${tc.loading ? 'disabled aria-busy="true"' : ''}>${tc.loading ? '刷新中…' : '刷新状态'}</button></div>
    <p class="hint-block">平台任务登记：创建即入库，重启不丢。每次打开都会把未完成的任务向平台批量查一次最新状态；已完成的点「保存到作品」可进我的作品。首次打开还会把这台浏览器里存过的任务编号导入一次。</p>
    <div class="filter-row">
      <select class="input" data-bind="taskCenter.status" aria-label="按状态筛选">${[['all', '全部状态'], ['1', '未开始'], ['2', '生成中'], ['5', '已完成'], ['9', '失败']].map(([v, l]) => `<option value="${v}" ${tc.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="input" data-bind="taskCenter.cap" aria-label="按能力筛选"><option value="all" ${tc.cap === 'all' ? 'selected' : ''}>全部能力</option>${CAPABILITIES.map((c) => `<option value="${c.id}" ${tc.cap === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <input class="input" type="search" data-bind="taskCenter.q" value="${esc(tc.q || '')}" placeholder="按任务编号或任务名搜索" aria-label="按任务编号或任务名搜索" />
      <button class="btn btn--sm" type="button" data-action="taskcenter-search">搜索</button>
    </div>
    ${tc.error ? errorBlock(tc.error, { retry: 'taskcenter-refresh' }) : ''}
    ${tc.loading && !tc.list.length ? skeletonBlock('正在读取任务…')
      : tc.list.length ? `<div class="table-scroll"><table class="table"><thead><tr><th scope="col">任务编号</th><th scope="col">能力</th><th scope="col">任务名</th><th scope="col">状态</th><th scope="col">创建时间</th><th scope="col">结果</th><th scope="col">操作</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : emptyState('还没有任务', '在创作中心或能力体验里生成一次，结果就会出现在这里。', '<a class="btn btn--primary btn--sm" href="#create" data-view="create">去创作中心</a>')}
    <p class="hint-block">共 ${tc.total} 条${(tc.list || []).some((t) => t.status === 1 || t.status === 2) ? '；未完成的任务每 15 秒自动刷新一次状态，跑完自动停。' : '。'}</p></div></div>`;
}

/** 直播内测：按控制台 /company/live/liveTest 的 5 步复刻（创建 / 启动 / 观众互动模拟 / 麦克风接管 / 关闭）。
 * 按钮禁用均因未创建直播间——按控制台原样；演示环境只出样例会话，不创建真实直播间。 */
export function liveTestView(s) {
  const t = s.livetest;
  const hasSession = !!t.session?.sessionId;
  const sess = t.session || {};
  const elapsed = t.startedAt ? fmtElapsed(Date.now() - t.startedAt) : '—';
  const step = (n, title, pill, body) => `<div class="card"><div class="card__title"><h2>第 ${n} 步 · ${title}</h2>${pill ? `<span class="pill pill--info">${pill}</span>` : ''}</div>${body}</div>`;
  const dis = (ok) => (ok ? '' : 'disabled');
  const queueRows = (t.queue || []).map((q, i) => `<tr><td>${i + 1}</td><td>${esc(q.kind === 'audio' ? '音频' : '文字')}${q.stream === 'stream' ? ' · 流式' : ' · 非流式'}</td><td>${esc(q.content || q.audioUrl || '')}</td><td>${esc(q.status || '待发送')}</td>
    <td><div class="actions actions--inline"><button class="btn btn--sm btn--primary" type="button" data-action="livetest-queue-send" data-index="${i}" ${dis(hasSession && q.status === '待发送')}>发送</button><button class="btn btn--sm" type="button" data-action="livetest-queue-del" data-index="${i}">删除</button></div></td></tr>`).join('');
  return `<div class="console">
    <p class="hint-block">直播内测台：按如影控制台「直播内测」页的 5 步复刻。创建直播间即开始计时；开播后每 60 秒自动发送一次心跳，心跳丢失会在阈值后被动关闭；不用时请点第 5 步关播，否则占用路数。</p>
    ${t.error ? errorBlock(t.error, { retry: 'livetest-retry' }) : ''}
    <div class="grid-2"><div>
    ${step(1, '创建直播间', '创建即开始计时', `
      <div class="form-field"><label for="livetest-name">直播间名称</label><input class="input" id="livetest-name" data-bind="livetest.name" value="${esc(t.name)}" maxlength="64" /></div>
      <div class="form-field"><label for="livetest-script-file">直播脚本 JSON</label>
        <label class="dropzone" for="livetest-script-file"><input class="sr-only" type="file" id="livetest-script-file" accept=".json,application/json" data-livetest-file /><b>点击选择直播脚本 JSON</b><span>支持 liveScript_*.json</span></label>
        <p class="field-hint">上传控制台「导出直播脚本」的文件（liveScript_*.json）；本站只取其中第一场景的播报文案与发音人创建直播间。${t.scriptFileName ? `已选：${esc(t.scriptFileName)}` : '未选文件。'}</p>
        ${t.scriptText ? `<p class="field-hint">脚本播报内容：${esc(t.scriptText.slice(0, 80))}${t.scriptText.length > 80 ? '…' : ''}</p>` : ''}</div>
      <div class="actions"><button class="btn btn--primary" type="button" data-action="livetest-create" ${dis(t.scriptJson && !t.busy)}>${t.busy === 'create' ? '创建中…' : '点击创建'}</button></div>
      ${hasSession ? `<table class="table kv-table"><tbody>
        <tr><th scope="row">会话编号</th><td><code>${esc(sess.sessionId)}</code></td></tr>
        <tr><th scope="row">状态</th><td>${esc(sess.statusText || '')}</td></tr>
        <tr><th scope="row">拉流 RTMP</th><td><code>${esc(sess.pullRtmpUrl || '—')}</code></td></tr>
        <tr><th scope="row">拉流 FLV</th><td><code>${esc(sess.pullFlvUrl || '—')}</code></td></tr>
        <tr><th scope="row">拉流 HLS</th><td><code>${esc(sess.pullHlsUrl || '—')}</code></td></tr>
      </tbody></table>` : ''}`)}
    ${step(2, '启动直播', '每 60 秒心跳', `
      <p class="muted">开播后开始推流，心跳每 60 秒自动发送一次；心跳丢失会在阈值后被动关闭。</p>
      <div class="actions"><button class="btn btn--primary" type="button" data-action="livetest-start" ${dis(hasSession && !t.started && !t.busy)}>${t.busy === 'start' ? '启动中…' : t.started ? '已开播' : '点击开始'}</button></div>
      ${t.started ? `<p class="field-hint">已开播 ${t.startedAt ? new Date(t.startedAt).toLocaleString('zh-CN', { hour12: false }) : ''} · 上次心跳 ${t.lastHeartbeatAt ? new Date(t.lastHeartbeatAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}${t.heartbeatError ? ` · <span class="warn">心跳失败：${esc(t.heartbeatError)}</span>` : ''}</p>` : `<p class="field-hint">${hasSession ? '尚未开播。' : '请先创建直播间。'}</p>`}`)}
    ${step(3, '观众互动模拟', '接管走 liveCommand', `
      <div class="form-field"><span class="field-label">接管方式</span><div class="radio-row" role="radiogroup" aria-label="接管方式">
        <label><input type="radio" name="livetest-kind" data-bind="livetest.takeoverKind" value="text" ${t.takeoverKind !== 'audio' ? 'checked' : ''} /> 文字</label>
        <label><input type="radio" name="livetest-kind" data-bind="livetest.takeoverKind" value="audio" ${t.takeoverKind === 'audio' ? 'checked' : ''} /> 音频</label></div></div>
      <div class="form-field"><span class="field-label">播报方式</span><div class="radio-row" role="radiogroup" aria-label="播报方式">
        <label><input type="radio" name="livetest-stream" data-bind="livetest.takeoverStream" value="nonstream" ${t.takeoverStream !== 'stream' ? 'checked' : ''} /> 非流式</label>
        <label><input type="radio" name="livetest-stream" data-bind="livetest.takeoverStream" value="stream" ${t.takeoverStream === 'stream' ? 'checked' : ''} /> 流式</label></div></div>
      ${t.takeoverKind === 'audio'
        ? `<div class="form-field"><label for="livetest-audio">接管音频</label><input class="input" id="livetest-audio" data-bind="livetest.takeoverAudioUrl" value="${esc(t.takeoverAudioUrl || '')}" placeholder="https://…/audio.mp3" />
          <p class="field-hint">音频接管的接管参数口径文档未给出，本站暂不支持音频接管发送；如需用声音接管，可先在「语音合成 TTS」里合成音频。文字接管不受影响。</p></div>`
        : `<div class="form-field"><label for="livetest-text">接管文本</label><textarea class="editor" id="livetest-text" data-bind="livetest.takeoverText" rows="2" placeholder="输入要让数字人播报的话">${esc(t.takeoverText || '')}</textarea></div>`}
      <div class="form-field"><span class="field-label">替换前 / 背景（仅非流式有效）</span>
        <div class="grid-2"><div><label for="livetest-fg">前景文件 ID</label><input class="input" id="livetest-fg" data-bind="livetest.replaceFgFileId" value="${esc(t.replaceFgFileId || '')}" placeholder="前景素材文件 ID" ${dis(t.takeoverStream !== 'stream')} /></div>
        <div><label for="livetest-bg">背景文件 ID</label><input class="input" id="livetest-bg" data-bind="livetest.replaceBgFileId" value="${esc(t.replaceBgFileId || '')}" placeholder="背景素材文件 ID" ${dis(t.takeoverStream !== 'stream')} /></div></div>
        <p class="field-hint">替换走超级直播间接管控制接口（切换前景 / 背景）；流式播报时控制台也不允许替换。</p>
        <div class="actions"><button class="btn" type="button" data-action="livetest-replace" ${dis(hasSession && t.takeoverStream !== 'stream' && (t.replaceFgFileId || t.replaceBgFileId))}>替换前 / 背景</button></div></div>
      <div class="actions"><button class="btn btn--primary" type="button" data-action="livetest-queue-add" ${dis(hasSession && (t.queue || []).length < 10 && (t.takeoverKind === 'audio' ? !!t.takeoverAudioUrl : !!String(t.takeoverText || '').trim()))}>加入队列</button>
        <button class="btn" type="button" data-action="livetest-queue-clear" ${dis((t.queue || []).length > 0)}>取消全部</button></div>
      ${(t.queue || []).length ? `<div class="table-scroll"><table class="table"><thead><tr><th scope="col">顺序</th><th scope="col">方式</th><th scope="col">接管内容</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>${queueRows}</tbody></table></div>` : '<p class="field-hint">队列为空，最多 10 条；点「发送」逐条发给数字人播报。</p>'}`)}
    ${step(4, '麦克风接管', 'WebSocket 16k PCM', `
      <p class="muted">浏览器采集麦克风 → 重采样 16k 单声道 PCM → 走 WebSocket 发给平台。需要浏览器麦克风权限；只在真实环境可用（演示环境没有真实直播间）。</p>
      <div class="actions"><button class="btn btn--primary" type="button" data-action="livetest-mic-toggle" ${dis(hasSession && t.started && !t.busy)}>${t.micActive ? '关闭麦克风接管' : '开启麦克风接管'}</button>
      <button class="btn" type="button" data-action="livetest-mic-remaining" ${dis(t.micActive)}>查剩余</button>
      <button class="btn btn--sm" type="button" data-action="livetest-mic-revoke">撤回录音同意</button></div>
      <p class="field-hint">${t.micStatus ? esc(t.micStatus) : (hasSession ? (t.started ? '麦克风未开启。' : '请先开播。') : '请先创建直播间。')}</p>`)}
    ${step(5, '关闭', '', `
      <p class="muted">不用时请关播，否则占用直播路数；10 分钟无心跳平台也会自动断播。</p>
      <div class="actions"><button class="btn btn--primary" type="button" data-action="livetest-close" ${dis(hasSession && !t.busy)}>${t.busy === 'close' ? '关闭中…' : '点击退出'}</button></div>
      <p class="field-hint">旧版直播接口 demo 见如影控制台「直播内测」页：<a href="${PRODUCT.consoleUrl}" target="_blank" rel="noreferrer">打开如影控制台</a>。</p>`)}
    </div>
    <div><div class="card"><div class="card__title"><h2>直播输出预览</h2>${t.started ? '<span class="pill pill--ok">直播中</span>' : hasSession ? '<span class="pill pill--info">已创建 · 未开播</span>' : '<span class="pill pill--mock">未创建</span>'}</div>
      ${hasSession ? `<table class="table kv-table"><tbody>
        <tr><th scope="row">会话编号</th><td><code>${esc(sess.sessionId)}</code></td></tr>
        <tr><th scope="row">开播时长</th><td><span data-live-elapsed="livetest">${elapsed}</span></td></tr>
        <tr><th scope="row">拉流 RTMP</th><td><code>${esc(sess.pullRtmpUrl || '—')}</code> ${sess.pullRtmpUrl ? `<button class="btn btn--sm" type="button" data-action="copy-text" data-text="${esc(sess.pullRtmpUrl)}">复制</button>` : ''}</td></tr>
        <tr><th scope="row">拉流 FLV</th><td><code>${esc(sess.pullFlvUrl || '—')}</code> ${sess.pullFlvUrl ? `<button class="btn btn--sm" type="button" data-action="copy-text" data-text="${esc(sess.pullFlvUrl)}">复制</button>` : ''}</td></tr>
        <tr><th scope="row">拉流 HLS</th><td><code>${esc(sess.pullHlsUrl || '—')}</code> ${sess.pullHlsUrl ? `<button class="btn btn--sm" type="button" data-action="copy-text" data-text="${esc(sess.pullHlsUrl)}">复制</button>` : ''}</td></tr>
        ${sess.liveAddress ? `<tr><th scope="row">liveAddress</th><td><code>${esc(sess.liveAddress)}</code></td></tr>` : ''}
      </tbody></table>
      <p class="field-hint">本站不内置播放器：拉流地址可复制到播放器里看；没有播放器就只显示拉流地址与状态，不编造播放画面。</p>`
      : '<p class="muted">还没有直播间：按第 1 步上传直播脚本 JSON 并点击创建。</p>'}
    </div></div></div></div>`;
}

/** 视频互动直播测试：按控制台 /company/live/multiVideoInteractiveTest 的 5 步复刻 */
export function multiTestView(s) {
  const t = s.multitest;
  const hasSession = !!t.session?.sessionId;
  const sess = t.session || {};
  const elapsed = t.startedAt ? fmtElapsed(Date.now() - t.startedAt) : '—';
  const step = (n, title, pill, body) => `<div class="card"><div class="card__title"><h2>第 ${n} 步 · ${title}</h2>${pill ? `<span class="pill pill--info">${pill}</span>` : ''}</div>${body}</div>`;
  const dis = (ok) => (ok ? '' : 'disabled');
  const queueRows = (t.queue || []).map((q, i) => `<tr><td>${i + 1}</td><td>${esc(['语音播报', '语音输入', '接管脚本'][Number(q.type)] || q.type)}</td><td>${esc(q.content || q.audioUrl || q.scriptName || '')}</td><td>${esc(q.status || '排队中')}</td>
    <td>${q.local ? `<button class="btn btn--sm" type="button" data-action="multitest-queue-del" data-index="${i}">删除</button>` : '<span class="muted">—</span>'}</td></tr>`).join('');
  const matRows = (t.materials || []).map((mm, i) => `<tr><td>${i + 1}</td><td>${esc(mm.name || mm.materialId)}</td><td>${esc(mm.type || '')}</td><td>${esc(mm.status || '')}</td>
    <td><div class="actions actions--inline">
      <button class="btn btn--sm" type="button" data-action="multitest-mat-up" data-index="${i}" ${dis(i > 0)}>上移</button>
      <button class="btn btn--sm" type="button" data-action="multitest-mat-down" data-index="${i}" ${dis(i < (t.materials || []).length - 1)}>下移</button>
      <button class="btn btn--sm btn--primary" type="button" data-action="multitest-mat-switch" data-id="${esc(mm.materialId)}" ${dis(hasSession && t.started)}>切换</button>
    </div></td></tr>`).join('');
  return `<div class="console">
    <p class="hint-block">视频互动直播测试台：按如影控制台「视频互动直播测试」页的 5 步复刻。创建前先在「视频互动直播」里创建装修任务，拿到 FINISHED 素材的 materialId 再填进播放列表；播放列表没有单条删除接口（只有过渡视频素材删除），本站不提供删单条的按钮。</p>
    ${t.error ? errorBlock(t.error, { retry: 'multitest-retry' }) : ''}
    <div class="grid-2"><div>
    ${step(1, '创建', '上传 JSON + 开始创建', `
      <div class="form-field"><label for="multitest-name">直播间名称</label><input class="input" id="multitest-name" data-bind="multitest.name" value="${esc(t.name)}" maxlength="64" /></div>
      <div class="form-field"><label for="multitest-script-file">脚本 JSON</label>
        <label class="dropzone" for="multitest-script-file"><input class="sr-only" type="file" id="multitest-script-file" accept=".json,application/json" data-multitest-file /><b>点击选择脚本 JSON</b><span>支持装修脚本 JSON</span></label>
        <p class="field-hint">上传装修脚本 JSON（控制台第一步上传的文件）；${t.scriptFileName ? `已选：${esc(t.scriptFileName)}` : '未选文件（可不传，只填播放列表也能创建）。'}</p></div>
      <div class="form-field"><label for="multitest-materials">播放列表素材 ID（每行一个）</label><textarea class="editor" id="multitest-materials" data-bind="multitest.materialIds" rows="3" placeholder="mat_xxx&#10;mat_yyy">${esc(t.materialIds || '')}</textarea>
        <p class="field-hint">装修任务产出的 materialId，素材状态须为 FINISHED 才能用来创建直播。</p></div>
      <div class="form-field"><label for="multitest-rtmp">推流 RTMP 地址（可选）</label><input class="input" id="multitest-rtmp" data-bind="multitest.rtmpUrl" value="${esc(t.rtmpUrl || '')}" placeholder="rtmp://…" /></div>
      <div class="form-field"><label for="multitest-callback">回调地址 callbackUrl（可选）</label><input class="input" id="multitest-callback" data-bind="multitest.callbackUrl" value="${esc(t.callbackUrl || '')}" placeholder="https://…/callback" />
        <p class="field-hint">直播创建时可按任务传回调地址；本站平时用轮询，不依赖回调。</p></div>
      <div class="actions"><button class="btn btn--primary" type="button" data-action="multitest-create" ${dis(String(t.materialIds || '').trim() && !t.busy)}>${t.busy === 'create' ? '创建中…' : '开始创建'}</button></div>
      ${hasSession ? `<p class="field-hint">会话编号 <code>${esc(sess.sessionId)}</code> · ${esc(sess.statusText || sess.status || '')}</p>` : ''}`)}
    ${step(2, '启动', '每 60 秒心跳', `
      <p class="muted">开播后开始推流，心跳每 60 秒自动发送一次；心跳丢失会在阈值后被动关闭。</p>
      <div class="actions"><button class="btn btn--primary" type="button" data-action="multitest-start" ${dis(hasSession && !t.started && !t.busy)}>${t.busy === 'start' ? '启动中…' : t.started ? '已开播' : '开始直播'}</button></div>
      ${t.started ? `<p class="field-hint">已开播 ${t.startedAt ? new Date(t.startedAt).toLocaleString('zh-CN', { hour12: false }) : ''} · 上次心跳 ${t.lastHeartbeatAt ? new Date(t.lastHeartbeatAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}${t.heartbeatError ? ` · <span class="warn">心跳失败：${esc(t.heartbeatError)}</span>` : ''}</p>` : `<p class="field-hint">${hasSession ? '尚未开播。' : '请先创建直播间。'}</p>`}`)}
    ${step(3, '接管队列管理', 'command/queue', `
      <div class="form-field"><span class="field-label">接管类型</span><div class="radio-row" role="radiogroup" aria-label="接管类型">
        <label><input type="radio" name="multitest-qtype" data-bind="multitest.queueType" value="0" ${t.queueType !== '1' && t.queueType !== '2' ? 'checked' : ''} /> 文字接管</label>
        <label><input type="radio" name="multitest-qtype" data-bind="multitest.queueType" value="1" ${t.queueType === '1' ? 'checked' : ''} /> 音频接管</label>
        <label><input type="radio" name="multitest-qtype" data-bind="multitest.queueType" value="2" ${t.queueType === '2' ? 'checked' : ''} /> 接管脚本</label></div></div>
      ${t.queueType === '1'
        ? `<div class="form-field"><label for="multitest-qaudio">音频地址</label><input class="input" id="multitest-qaudio" data-bind="multitest.queueAudioUrl" value="${esc(t.queueAudioUrl || '')}" placeholder="https://…/audio.mp3" /></div>`
        : t.queueType === '2'
          ? `<div class="form-field"><label for="multitest-qscript">接管脚本 JSON</label><textarea class="editor" id="multitest-qscript" data-bind="multitest.queueScript" rows="3" placeholder='{"version":"0.0.1", …}'>${esc(t.queueScript || '')}</textarea></div>`
          : `<div class="form-field"><label for="multitest-qtext">接管文本</label><textarea class="editor" id="multitest-qtext" data-bind="multitest.queueText" rows="2" placeholder="输入要让数字人播报的话">${esc(t.queueText || '')}</textarea></div>`}
      <div class="form-field"><label for="multitest-qmat">数字人素材 ID</label><input class="input" id="multitest-qmat" data-bind="multitest.queueMaterialId" value="${esc(t.queueMaterialId || '')}" placeholder="用于接管的数字人素材 ID（可空）" /></div>
      <div class="form-field"><label for="multitest-qpri">优先级（0-100，默认 0）</label><input class="input" id="multitest-qpri" type="number" min="0" max="100" data-bind="multitest.queuePriority" value="${esc(String(t.queuePriority ?? 0))}" /></div>
      <div class="actions"><button class="btn btn--primary" type="button" data-action="multitest-queue-add" ${dis(hasSession && !t.busy)}>加入接管队列</button>
        <button class="btn" type="button" data-action="multitest-queue-refresh" ${dis(hasSession)}>手动刷新</button></div>
      ${(t.queue || []).length ? `<div class="table-scroll"><table class="table"><thead><tr><th scope="col">顺序</th><th scope="col">类型</th><th scope="col">接管内容</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead><tbody>${queueRows}</tbody></table></div>` : '<p class="field-hint">队列为空；加入后按顺序触发，同一 commandTraceId 60 秒内重复提交视为同一条。</p>'}`)}
    ${step(4, '播放素材顺序管理', '全量重排', `
      <div class="form-field"><span class="field-label">冲突策略（本站前端行为）</span><div class="radio-row" role="radiogroup" aria-label="冲突策略">
        <label><input type="radio" name="multitest-conflict" data-bind="multitest.conflict" value="force" ${t.conflict !== 'reject' ? 'checked' : ''} /> 强制切换（默认）</label>
        <label><input type="radio" name="multitest-conflict" data-bind="multitest.conflict" value="reject" ${t.conflict === 'reject' ? 'checked' : ''} /> 接管中拒绝切换</label></div>
        <p class="field-hint">选「接管中拒绝切换」时，接管队列非空就不发切换请求并说明原因。</p></div>
      <div class="actions"><button class="btn" type="button" data-action="multitest-playback-refresh" ${dis(hasSession)}>刷新</button>
        <button class="btn btn--primary" type="button" data-action="multitest-playback-save" ${dis(hasSession && (t.materials || []).length > 0)}>快速排序（提交当前顺序）</button></div>
      ${(t.materials || []).length ? `<div class="table-scroll"><table class="table"><thead><tr><th scope="col">顺序</th><th scope="col">素材名称</th><th scope="col">类型</th><th scope="col">播放状态</th><th scope="col">操作</th></tr></thead><tbody>${matRows}</tbody></table></div>` : '<p class="field-hint">还没有播放列表：点「刷新」从平台拉取；上移 / 下移调整顺序后点「快速排序」全量提交。</p>'}`)}
    ${step(5, '结束直播', '', `
      <p class="muted">不用时请关播，否则占用直播路数；10 分钟无心跳平台也会自动断播。</p>
      <div class="actions"><button class="btn btn--primary" type="button" data-action="multitest-close" ${dis(hasSession && !t.busy)}>${t.busy === 'close' ? '关闭中…' : '结束直播'}</button></div>`)}
    </div>
    <div><div class="card"><div class="card__title"><h2>直播输出预览</h2>${t.started ? '<span class="pill pill--ok">直播中</span>' : hasSession ? '<span class="pill pill--info">已创建 · 未开播</span>' : '<span class="pill pill--mock">未创建</span>'}</div>
      ${hasSession ? `<table class="table kv-table"><tbody>
        <tr><th scope="row">会话编号</th><td><code>${esc(sess.sessionId)}</code></td></tr>
        <tr><th scope="row">开播时长</th><td><span data-live-elapsed="multitest">${elapsed}</span></td></tr>
        <tr><th scope="row">拉流 RTMP</th><td><code>${esc(sess.pullRtmpUrl || '—')}</code> ${sess.pullRtmpUrl ? `<button class="btn btn--sm" type="button" data-action="copy-text" data-text="${esc(sess.pullRtmpUrl)}">复制</button>` : ''}</td></tr>
        <tr><th scope="row">拉流 FLV</th><td><code>${esc(sess.pullFlvUrl || '—')}</code> ${sess.pullFlvUrl ? `<button class="btn btn--sm" type="button" data-action="copy-text" data-text="${esc(sess.pullFlvUrl)}">复制</button>` : ''}</td></tr>
        <tr><th scope="row">拉流 HLS</th><td><code>${esc(sess.pullHlsUrl || '—')}</code> ${sess.pullHlsUrl ? `<button class="btn btn--sm" type="button" data-action="copy-text" data-text="${esc(sess.pullHlsUrl)}">复制</button>` : ''}</td></tr>
      </tbody></table>
      <p class="field-hint">本站不内置播放器：拉流地址可复制到播放器里看；没有播放器就只显示拉流地址与状态，不编造播放画面。</p>`
      : '<p class="muted">还没有直播间：按第 1 步填好播放列表素材 ID 并开始创建。</p>'}
    </div></div></div></div>`;
}

/** 账单用量档位：剩余 ≥25% 绿、10%–25% 黄、<10% 或已超 红；红档口径与总览“我的额度”卡的 low（剩余 <10%）一致 */
export function quotaLevel(used, allocated) {
  if (!allocated || allocated <= 0) return 'none';
  const remainRatio = (allocated - used) / allocated;
  if (remainRatio < 0.1) return 'low';
  if (remainRatio < 0.25) return 'warn';
  return 'ok';
}

/** 账单页签 → 厂商实时额度键（server/lib/ruying.mjs 的 resource() 返回键名）；声音合成与 ASR 合成按调用计费，无总量口径 */
const BILL_QUOTA_VENDOR = {
  avatar: 'genCharModel', video: 'genVideoDuration', live: 'liveDuration',
  multi: 'videoInteractiveLive', 'voice-model': 'genTtsCharVoiceModel',
  'image-avatar': 'genImageVideoDuration', 'image-edit': 'genEditImage',
};
/** 账单页签 → 租户内部台账计量键；只有这三项，映射不到的页签如实写没有 */
const BILL_QUOTA_TENANT = { video: 'video_seconds', tts: 'tts_chars' };
/** 演示环境样例额度：只用控制台实测过的数字，不编；没有实测数字的页签不在这里 */
const BILL_DEMO_QUOTA = {
  video: { label: '视频合成', used: 0.62, allocated: 20, unit: '分钟' },
  'image-avatar': { label: '图片数字人', used: 149.4, allocated: 120, unit: '秒' },
  avatar: { label: '人物形象模型', used: 0, allocated: 3, unit: '个' },
  'voice-model': { label: '个人音色模型', used: 0, allocated: 3, unit: '个' },
  live: { label: '互动直播', used: 0, allocated: 100, unit: '分钟' },
  'image-edit': { label: 'AI 图片编辑', used: 0, allocated: 0, unit: '个' },
};

/** 账单页用量展示：当前页签的已用 / 共 / 剩余 + 进度条（绿黄红三色）。查询账单时不新增接口调用，复用启动时已加载的 s.me.quota */
export function billUsageHtml(s) {
  const tab = s.bill.tab;
  let item = null;
  let source = '';
  if (s.mode === 'real') {
    const q = s.me?.quota;
    if (!s.me?.user || !q?.items) return '<p class="hint-block">暂时无法获取额度信息，请稍后刷新重试。</p>';
    if (Array.isArray(q.items)) {
      const key = BILL_QUOTA_VENDOR[tab];
      const found = key ? q.items.find((it) => it.key === key) : null;
      if (found) { item = found; source = '厂商实时额度'; }
      else if (tab === 'tts' || tab === 'asr') return '<p class="hint-block">声音合成与 ASR 合成按调用计费，无总量口径，合计用量见下方表格。</p>';
      else return '<p class="hint-block">当前页签在额度数据里没有对应的计量口径。</p>';
    } else {
      const meter = BILL_QUOTA_TENANT[tab];
      const m = meter ? q.items[meter] : null;
      if (m) { item = { label: QUOTA_LABELS[meter].label, unit: QUOTA_LABELS[meter].unit, ...m }; source = '内部台账'; }
      if (!item) return '<p class="hint-block">内部台账只有视频时长、语音合成字数、其他能力调用三项计量，当前页签没有对应的额度口径。</p>';
    }
  } else {
    const demo = BILL_DEMO_QUOTA[tab];
    if (!demo) return '<p class="hint-block">演示环境：当前页签没有实测的样例额度数字，不编用量条。声音合成与 ASR 合成按调用计费，无总量口径，合计用量见下方表格。</p>';
    item = demo;
    source = '样例';
  }
  const level = quotaLevel(item.used, item.allocated);
  if (level === 'none') {
    return `<div class="quota-row"><div class="quota-row__head"><b>${esc(item.label)}用量</b><span class="quota-row__remain">未开通</span></div>
      <div class="quota-row__meta">当前页签对应的额度总量为 0，未开通。</div></div>`;
  }
  const pct = Math.min(100, Math.max(0, Math.round((item.used / item.allocated) * 100)));
  const remain = Math.round((item.allocated - item.used) * 100) / 100;
  const levelText = level === 'ok' ? '剩余充足' : level === 'warn' ? '剩余不多，请留意' : (item.used > item.allocated ? '已超量，请联系管理员追加' : '即将用完，请联系管理员追加');
  const srcNote = source === '样例' ? '样例数据（演示环境），以如影控制台为准' : `数据来源：${source}`;
  return `<div class="quota-row quota-row--${level}">
      <div class="quota-row__head"><b>${esc(item.label)}用量</b>
        <span class="quota-row__remain">剩余 <b>${remain}</b> ${esc(item.unit)}</span></div>
      <div class="quota-bar" role="img" aria-label="${esc(item.label)}已用 ${pct}%"><i style="width:${pct}%"></i></div>
      <div class="quota-row__meta">已用 ${item.used} / 共 ${item.allocated} ${esc(item.unit)} · ${levelText} · ${srcNote}</div>
    </div>`;
}

/** 账单：控制台 /company/bill/bill 的 9 个页签 + 日期范围 + 本地导出 CSV + 发送邮箱（mailto）。
 * algoGroup 用服务端可配置常量（默认 1）；第一轮探测 count 0 未定论，页面只展示接口返回，不写“无数据”的定性。 */
export function billView(s) {
  const b = s.bill;
  const tabs = [
    { id: 'avatar', label: '人物形象模型生成' }, { id: 'video', label: '视频合成' },
    { id: 'live', label: '互动直播' }, { id: 'multi', label: '视频互动直播' },
    { id: 'tts', label: '声音合成' }, { id: 'asr', label: 'ASR合成' },
    { id: 'voice-model', label: '个人音色模型生成' }, { id: 'image-avatar', label: '图片数字人' },
    { id: 'image-edit', label: '图片编辑' },
  ];
  const isVoice = b.tab === 'tts' || b.tab === 'asr';
  const rows = (b.rows || []).map((r) => `<tr>
    <td>${esc(r.billingDate || '')}</td><td><code>${esc(String(r.id || ''))}</code></td><td>${esc(r.taskName || '')}</td>
    <td>${esc(String(r.algoType ?? ''))}</td><td>${esc(r.algoSubType1 || '')}</td><td>${esc(r.algoSubType2 || '')}</td>
    <td>${esc(String(r.billingValue ?? ''))}</td><td>${esc(String(r.billingUnit ?? ''))}</td>
    <td>${esc(r.startTime || '')}</td><td>${esc(r.endTime || '')}</td><td>${esc(String(r.status ?? ''))}</td></tr>`).join('');
  return `<div class="console"><div class="card"><div class="card__title"><h2>账单</h2>
      <span class="pill ${s.mode === 'real' ? 'pill--ok' : 'pill--mock'}">${s.mode === 'real' ? '真实环境 · 平台账单' : '演示环境 · 样例账单'}</span></div>
    <p class="hint-block">按如影控制台「账单」页的 9 个页签查询：任务类按 algoType 查明细，声音合成与 ASR 合成按日 / 月统计。查询参数 algoGroup=${esc(String(b.algoGroup ?? 1))}（服务端配置，探测中）；图片数字人与图片编辑在账单接口里没有独立的 algoType，见各页签说明。</p>
    <div class="filter-row" role="tablist" aria-label="账单页签">
      ${tabs.map((t) => `<button class="chip ${b.tab === t.id ? 'is-on' : ''}" type="button" role="tab" aria-selected="${b.tab === t.id}" data-bill-tab="${t.id}">${esc(t.label)}</button>`).join('')}
    </div>
    <div class="filter-row">
      <label>从 <input class="input" type="date" data-bind="bill.from" value="${esc(b.from)}" aria-label="开始日期" /></label>
      <label>到 <input class="input" type="date" data-bind="bill.to" value="${esc(b.to)}" aria-label="结束日期" /></label>
      ${isVoice ? `<label>统计 <select class="input" data-bind="bill.statRange" aria-label="统计范围">
        <option value="1" ${b.statRange !== '2' ? 'selected' : ''}>日账单</option>
        <option value="2" ${b.statRange === '2' ? 'selected' : ''}>月账单</option></select></label>
      <label>来源 <select class="input" data-bind="bill.algoSubType1" aria-label="来源">
        <option value="">全部</option>${['PAAS_HTTP', 'PAAS_WS', 'PAAS_VIDEO_2D', 'PAAS_VIDEO_MIX', 'PAAS_LIVE'].map((v) => `<option value="${v}" ${b.algoSubType1 === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>服务资源 <select class="input" data-bind="bill.algoSubType2" aria-label="服务资源">
        <option value="">全部</option>${(b.tab === 'tts' ? ['TTS3', 'TTS4', 'TTS5', 'TTS7', 'TTS8'] : ['ASR5']).map((v) => `<option value="${v}" ${b.algoSubType2 === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>` : ''}
      <button class="btn btn--primary btn--sm" type="button" data-action="bill-query" ${b.loading ? 'disabled aria-busy="true"' : ''}>${b.loading ? '<span class="spinner" aria-hidden="true"></span>' : ''}查询</button>
      <button class="btn btn--sm" type="button" data-action="bill-csv" ${b.loading || !(b.rows || []).length ? 'disabled' : ''}>本地导出 CSV</button>
      <button class="btn btn--sm" type="button" data-action="bill-mailto" ${!(b.rows || []).length ? 'disabled' : ''}>发送邮箱</button>
    </div>
    ${b.note ? `<div class="alert alert--info" role="note"><div class="alert__body"><p>${esc(b.note)}</p></div></div>` : ''}
    ${b.error ? errorBlock(b.error, { retry: 'bill-query' }) : ''}
    ${billUsageHtml(s)}
    <p class="muted bill-status" data-bill-status role="status">${b.loading ? '查询中…' : ''}</p>
    ${(b.rows || []).length ? `<div class="table-scroll"><table class="table"><thead><tr><th scope="col">账单日期</th><th scope="col">任务/账单ID</th><th scope="col">任务名称</th><th scope="col">algoType</th><th scope="col">来源</th><th scope="col">服务资源</th><th scope="col">用量</th><th scope="col">单位</th><th scope="col">开始时间</th><th scope="col">结束时间</th><th scope="col">状态</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint-block">共 ${b.pagination?.count ?? b.rows.length} 条${b.usedSum !== null && b.usedSum !== undefined ? ` · 合计用量 ${esc(String(b.usedSum))}` : ''}（用量与单位按平台原值展示，单位口径以平台为准）。</p>`
      : b.loading ? ''
      : emptyState('没有查到账单记录', '换一个日期范围或页签再查；如果控制台里明明有账单而这里是空的，很可能是 algoGroup 取值不对（正在探测），不是没有数据。', '')}
    <p class="hint-block">「发送邮箱」会打开你的邮箱客户端（mailto），由你自己发送，本站不代发邮件、不保存收件人。</p>
  </div></div>`;
}

/** 互动直播管理：脚本库（本站 live_scripts 存储）+ 直播会话列表（tasks 表，只列本站创建过的） */
export function liveScriptsView(s) {
  const ls = s.livescripts;
  const scriptRows = (ls.scripts || []).map((sc) => `<tr>
    <td><b>${esc(sc.name)}</b></td><td>${esc(sc.source || '')}</td><td>${new Date(sc.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
    <td><div class="actions actions--inline">
      <button class="btn btn--sm btn--primary" type="button" data-action="livescript-open" data-id="${esc(sc.id)}">在编辑器中打开</button>
      <button class="btn btn--sm" type="button" data-action="livescript-export" data-id="${esc(sc.id)}">导出 JSON</button>
      <button class="btn btn--sm" type="button" data-action="livescript-share" data-id="${esc(sc.id)}">复制分享链接</button>
      <button class="btn btn--sm" type="button" data-action="livescript-rename" data-id="${esc(sc.id)}">改名</button>
      <button class="btn btn--sm" type="button" data-action="livescript-del" data-id="${esc(sc.id)}">删除</button>
    </div></td></tr>`).join('');
  const sessRows = (ls.sessions || []).map((x) => `<tr>
    <td>${esc(x.name || x.id)}</td><td>${esc(x.capabilityName || x.capability)}</td><td><code>${esc(x.sessionId)}</code></td>
    <td>${esc(x.statusText)}</td><td>${new Date(x.startedAt).toLocaleString('zh-CN', { hour12: false })}</td>
    <td>${x.endedAt ? new Date(x.endedAt).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
    <td>${x.durationSec !== null && x.durationSec !== undefined ? `${Math.floor(x.durationSec / 60)} 分 ${x.durationSec % 60} 秒` : '—'}</td>
    <td>${esc(x.endReason || '')}</td></tr>`).join('');
  return `<div class="console">
    <div class="filter-row" role="tablist" aria-label="互动直播管理">
      <button class="chip ${ls.tab !== 'sessions' ? 'is-on' : ''}" type="button" role="tab" aria-selected="${ls.tab !== 'sessions'}" data-livescripts-tab="scripts">脚本库</button>
      <button class="chip ${ls.tab === 'sessions' ? 'is-on' : ''}" type="button" role="tab" aria-selected="${ls.tab === 'sessions'}" data-livescripts-tab="sessions">直播会话</button>
    </div>
    ${ls.error ? errorBlock(ls.error, { retry: 'livescripts-reload' }) : ''}
    ${ls.tab === 'sessions' ? `<div class="card"><div class="card__title"><h2>直播会话</h2>
        <button class="btn btn--sm" type="button" data-action="livescripts-reload" ${ls.loading ? 'disabled aria-busy="true"' : ''}>${ls.loading ? '刷新中…' : '刷新'}</button></div>
      <p class="hint-block">${esc(ls.note || '平台没有直播会话列表接口，这里只列本站创建过的直播会话。')}</p>
      ${ls.loading && !(ls.sessions || []).length ? skeletonBlock('正在读取会话…')
        : (ls.sessions || []).length ? `<div class="table-scroll"><table class="table"><thead><tr><th scope="col">名称</th><th scope="col">类型</th><th scope="col">会话编号</th><th scope="col">状态</th><th scope="col">开始时间</th><th scope="col">结束时间</th><th scope="col">直播时长</th><th scope="col">结束原因</th></tr></thead><tbody>${sessRows}</tbody></table></div>`
        : emptyState('还没有直播会话', '在「直播内测」或「视频互动直播测试」里创建一次直播间，这里就会出现记录。', '<a class="btn btn--primary btn--sm" href="#livetest" data-view="livetest">去直播内测</a>')}
    </div>` : `<div class="card"><div class="card__title"><h2>脚本库</h2>
        <button class="btn btn--sm" type="button" data-action="livescripts-reload" ${ls.loading ? 'disabled aria-busy="true"' : ''}>${ls.loading ? '刷新中…' : '刷新'}</button></div>
      <p class="hint-block">文档里没有互动直播脚本的创建 / 查询 / 列表接口，脚本不是平台独立资源（装修脚本随装修任务提交，接管脚本随接管队列提交）。本站用自己的脚本库保存直播脚本编辑器出的脚本；分享链接打开即进编辑器并载入该脚本。</p>
      ${ls.loading && !(ls.scripts || []).length ? skeletonBlock('正在读取脚本库…')
        : (ls.scripts || []).length ? `<div class="table-scroll"><table class="table"><thead><tr><th scope="col">名称</th><th scope="col">来源</th><th scope="col">创建时间</th><th scope="col">操作</th></tr></thead><tbody>${scriptRows}</tbody></table></div>`
        : emptyState('脚本库还是空的', '在「直播脚本编辑」里编好脚本后点「保存到脚本库」，或在这里上传脚本 JSON。', '<a class="btn btn--primary btn--sm" href="#experience/live-script" data-view="experience">去直播脚本编辑</a>')}
      <div class="form-field"><label for="livescripts-upload">上传脚本 JSON 到脚本库</label>
        <label class="dropzone" for="livescripts-upload"><input class="sr-only" type="file" id="livescripts-upload" accept=".json,application/json" data-livescripts-file /><b>点击选择脚本 JSON</b><span>支持 liveScript_*.json，按文件名存进脚本库</span></label>
        <p class="field-hint">上传控制台导出的直播脚本（liveScript_*.json），按文件名存进脚本库。</p></div>
    </div>`}
  </div>`;
}

export function settingsView(s) {
  const cfg = s.config;
  if (!cfg) return `<div class="console">${s.configError ? errorBlock(s.configError, { retry: 'reload-config' }) : skeletonBlock('正在读取环境配置…')}</div>`;
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
    <div class="card"><div class="card__title"><h2>回调地址与订单</h2></div>
      <p class="muted">回调地址与订单只能在如影控制台里查看和修改：平台没有提供设置回调地址或查询订单列表的接口（属于账号配置，需运营开通），本站也不会编造订单数据。</p>
      <table class="table kv-table"><tbody>
        <tr><th scope="row">任务回调地址</th><td>请在如影控制台设置；本站用轮询查询任务状态，不依赖回调</td></tr>
        <tr><th scope="row">直播回调地址</th><td>请在如影控制台设置；视频互动直播创建时可单独传 callbackUrl</td></tr>
        <tr><th scope="row">订单</th><td>请在如影控制台首页查看（服务期、订单号）</td></tr>
      </tbody></table>
      <a class="btn card__foot-btn" href="${PRODUCT.consoleUrl}" target="_blank" rel="noreferrer">打开如影控制台<span class="sr-only">（新窗口打开）</span></a></div>
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
  let body = '';
  if (w.kind === 'video' && w.url) body = `<video controls playsinline preload="metadata" src="${esc(w.url)}" class="media-video" aria-label="${esc(w.title)}"></video>`;
  else if (w.kind === 'audio' && w.url) body = `<audio controls src="${esc(w.url)}" class="media-audio" aria-label="${esc(w.title)}"></audio>`;
  else if (w.kind === 'image' && w.url) body = `<img src="${esc(w.url)}" alt="${esc(w.title)}" class="media-image">`;
  else body = `<pre class="json-block">${esc(w.text)}</pre>`;
  const links = w.url ? `${(w.kind === 'video' || w.kind === 'audio') ? `<a class="btn" href="${esc(w.url)}" download="${esc(downloadName(w, w.url, w.kind === 'audio' ? 'mp3' : 'mp4'))}">下载</a>` : ''}<a class="btn" href="${esc(w.url)}" target="_blank" rel="noreferrer">在新窗口打开</a>` : '';
  const who = w.student ? `<p class="muted">${esc(w.className || '')} · ${esc(w.student.name || w.student.username)}（${esc(w.student.username)}）</p>` : '';
  const review = w.review ? `<div class="review-box"><b>评分 ${w.review.score} 分</b>${w.review.reviewer ? `<small> · ${esc(w.review.reviewer)}</small>` : ''}${w.review.comment ? `<p>${esc(w.review.comment)}</p>` : ''}</div>` : '';
  return `<div class="sheet-mask" data-action="close-dialog"></div>
  <div class="sheet sheet--wide" role="dialog" aria-modal="true" aria-labelledby="work-dialog-title">
    <h3 id="work-dialog-title">${esc(w.title)}</h3>
    ${who}${body}${review}
    <div class="actions">${links}<button class="btn btn--primary" type="button" data-action="close-dialog" data-autofocus>关闭</button></div></div>`;
}

export function tourCard(index) {
  const step = TOUR_STEPS[index];
  return `<div class="tour-card" role="dialog" aria-labelledby="tour-title"><h4 id="tour-title">${index + 1}/${TOUR_STEPS.length} · ${esc(step.title)}</h4><p>${esc(step.text)}</p>
    <div class="actions"><button class="btn btn--primary btn--sm" type="button" data-action="tour-next">${index + 1 === TOUR_STEPS.length ? '完成' : '下一步'}</button>
    <button class="btn btn--sm" type="button" data-action="tour-skip">跳过</button></div></div>`;
}
