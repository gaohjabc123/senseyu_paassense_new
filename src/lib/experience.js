// experience.js —— 通用能力体验器（数据驱动：按 capabilities.js 的规格渲染任意能力）
import { groupOf, OUTPUT_LABEL, capById } from './capabilities.js';
import { esc } from './html.js';
import { errorBlock } from './views.js';
import { recentForField } from './recent.js';
import { estimateProgress } from './api.js';
import { downloadName } from './works.js';

/** 上传按钮的文件选择器过滤（与服务端 media.mjs 白名单一致；服务端是最终校验） */
const UPLOAD_ACCEPT = {
  image: 'image/png,image/jpeg,image/webp,image/gif',
  audio: 'audio/mpeg,audio/wav,audio/mp4,audio/aac,.mp3,.wav,.m4a,.aac',
  video: 'video/mp4,video/quicktime,.mp4,.mov',
  media: 'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,.mp4,.mov',
  doc: 'text/plain,text/markdown,.txt,.md',
  srt: '.srt,text/plain',
};

/**
 * 结果卡上的「下一步」：把这次的成果直接带入下一个能力，不用复制粘贴。
 * 只在真实环境显示（演示结果是本地样例地址，带过去没法真用）。
 */
export const NEXT_STEPS = {
  'voice-tts': [{ label: '用这段音频做图片数字人', cap: 'video-image', params: (r) => ({ audioUrl: r.audioUrl || '' }) }],
  'avatar-train': [{ label: '用这个形象生成视频', cap: 'video-script', params: (r) => ({ faceFeatureId: r.json?.faceFeatureId || '' }) }],
  'nlp-kb': [{ label: '去问答试试', cap: 'nlp-chat', params: () => ({}) }],
};

function nextStepsHtml(r, cap) {
  if (!cap || r.mode !== 'real') return '';
  const steps = (NEXT_STEPS[cap.id] || []).filter((s) => {
    const p = s.params(r);
    return Object.values(p).every((v) => typeof v === 'string' && v.length > 0);
  });
  if (!steps.length) return '';
  return `<div class="actions next-steps"><span class="muted">下一步：</span>${steps.map((s) => `<button class="btn btn--primary btn--sm" type="button" data-action="exp-next" data-cap="${esc(s.cap)}">${esc(s.label)}</button>`).join('')}</div>`;
}

/** 前置条件里带 config 的那条：显示服务端配置状态（已配置 / 未配置）；配置没读到时不显示 */
function configStatus(cfg, key) {
  if (!key || !cfg) return '';
  return cfg[key]
    ? '<span class="pill pill--ok">服务端已配置</span>'
    : '<span class="pill pill--lock">未配置</span>';
}

function requiresCard(ex, cfg) {
  const reqs = ex.requires || [];
  if (!reqs.length) return '';
  return `<div class="card"><div class="card__title"><h2>开始之前</h2><span class="pill pill--info">按顺序准备，不容易跑一半失败</span></div>
    <ol class="req-list">${reqs.map((rq) => {
      const target = rq.cap ? capById(rq.cap) : null;
      return `<li><div class="req-list__head"><b>${esc(rq.text)}</b>${configStatus(cfg, rq.config)}${target ? `<a class="btn btn--sm" href="#experience/${esc(target.id)}" data-view="experience">去${esc(target.name)}</a>` : ''}</div>${rq.note ? `<span class="muted">${esc(rq.note)}</span>` : ''}</li>`;
    }).join('')}</ol></div>`;
}

/**
 * 过渡视频 / 预热素材的「查状态 + 批量删除」区（与创建表单分开，放在表单下方）。
 * 查状态只读不扣额度；删除二次确认（main.js 里 confirm），删完刷新上方的状态表。
 * 口径以飞书文档 V1.5.2 为准：
 * · 过渡视频：按任务查状态 POST .../transition-transcode-tasks/list（体 {taskIds}），
 *   批量删除 POST .../transition-transcode-tasks/delete（体 {taskIds}）；没有按素材 ID 查状态的接口。
 * · 预热素材：按 fileIds 批量查询 GET .../file/warming/query?fileIds=a,b，
 *   批量删除 POST .../file/warming/del（体 {fileIds}）；没有“列出全部预热素材”的接口，想查必须先有 fileId。
 */
function manageSection(s, cap) {
  const kind = cap.id === 'live-transition' ? 'transition' : cap.id === 'live-warming' ? 'warming' : null;
  if (!kind || !s.exp?.[kind]) return '';
  const t = s.exp[kind];
  const isWarming = kind === 'warming';
  const idLabel = isWarming ? '文件 ID' : '任务编号';
  const statusCols = isWarming
    ? '<th scope="col">文件 ID</th><th scope="col">任务 ID</th><th scope="col">状态</th><th scope="col">地址</th>'
    : '<th scope="col">任务 ID</th><th scope="col">素材 ID</th><th scope="col">状态</th>';
  const statusRows = (t.rows || []).map((r) => isWarming
    ? `<tr><td data-label="文件 ID">${esc(r.fileId || '')}</td><td data-label="任务 ID">${esc(r.taskId || '')}</td><td data-label="状态">${esc(r.statusText || '')}</td><td data-label="地址"><small class="muted">${esc(r.fileUrl || '')}</small></td></tr>`
    : `<tr><td data-label="任务 ID">${esc(r.taskId || '')}</td><td data-label="素材 ID">${esc(r.materialId || '')}</td><td data-label="状态">${esc(r.statusText || '')}</td></tr>`).join('');
  const note = isWarming
    ? '平台没有“列出全部预热素材”的接口，想查状态必须先有 fileId；查询与删除都是按 fileIds 列表批量走，没有单查 / 单删接口。'
    : '平台只提供按任务查状态，没有按素材 ID 查状态的接口；删除按任务编号批量删。';
  return `<div class="card"><div class="card__title"><h2>查状态</h2><span class="pill pill--info">只读，不扣额度</span></div>
      <p class="muted">输入${idLabel}（每行一个或逗号分隔，最多 10 个），查平台返回的状态。</p>
      <div class="form-field"><label for="manage-status-ids">${idLabel}</label>
        <textarea class="editor exp-input" id="manage-status-ids" data-bind="exp.${kind}.statusIds" rows="2" placeholder="${isWarming ? 'file_123\nfile_456' : '123456\n123457'}" ${t.loading ? 'disabled' : ''}>${esc(t.statusIds || '')}</textarea></div>
      <div class="actions"><button class="btn btn--primary" type="button" data-action="${kind}-status" ${t.loading ? 'disabled aria-busy="true"' : ''}>${t.loading ? '查询中…' : '查状态'}</button></div>
      ${t.error ? errorBlock(t.error, { retry: `${kind}-status` }) : ''}
      ${statusRows ? `<div class="table-scroll"><table class="table"><thead><tr>${statusCols}</tr></thead><tbody>${statusRows}</tbody></table></div>` : ''}
    </div>
    <div class="card"><div class="card__title"><h2>批量删除</h2><span class="pill pill--lock">删除后不可恢复</span></div>
      <p class="muted">输入${idLabel}（与上方同一格式，最多 10 个），删除后会刷新上方的状态表。${note}</p>
      <div class="form-field"><label for="manage-delete-ids">${idLabel}</label>
        <textarea class="editor exp-input" id="manage-delete-ids" data-bind="exp.${kind}.deleteIds" rows="2" placeholder="${isWarming ? 'file_123\nfile_456' : '123456\n123457'}" ${t.deleting ? 'disabled' : ''}>${esc(t.deleteIds || '')}</textarea></div>
      <div class="actions"><button class="btn" type="button" data-action="${kind}-delete" ${t.deleting ? 'disabled aria-busy="true"' : ''}>${t.deleting ? '删除中…' : '删除'}</button></div>
      ${t.deleteError ? errorBlock(t.deleteError, { retry: `${kind}-delete` }) : ''}
      ${t.deleteMsg ? `<p class="ok">${esc(t.deleteMsg)}</p>` : ''}
    </div>`;
}

/**
 * 通用能力体验器。opts.embedded=true 时只返回主体内容（不带外壳与面包屑），
 * 供创作中心快捷入口嵌在标签页里复用：表单、提交、轮询、结果与体验页是同一套。
 */
export function experienceView(s, cap, opts = {}) {
  const ex = cap.experience || {};
  const g = groupOf(cap.group);
  const e = s.exp;
  const busy = e.running;
  // 步骤分组（如影控制台的纵向步骤：基础 / 人物 / 人物设置 / 内容 / 装饰 / 文字 / 美颜）：
  // 字段带 step 时，在步骤切换处插一个带序号的分组标题；不带 step 的能力不受影响。
  const stepNames = [];
  let curStep = null;
  const fields = (ex.fields || []).map((f) => {
    let stepHead = '';
    if (f.section) {
      if (!stepNames.includes(f.section)) stepNames.push(f.section);
      if (f.section !== curStep) { stepHead = `<h3 class="exp-step"><span class="exp-step__num">${stepNames.indexOf(f.section) + 1}</span>${esc(f.section)}</h3>`; curStep = f.section; }
    }
    const id = `exp-${f.key}`;
    const val = e.params[f.key] ?? f.default ?? '';
    const maxAttr = f.maxLength && f.type !== 'select' && f.type !== 'toggle' ? `maxlength="${Number(f.maxLength)}"` : '';
    const reqAttr = f.required ? 'aria-required="true"' : '';
    const common = `id="${id}" data-field="${esc(f.key)}" ${busy ? 'disabled' : ''} ${maxAttr} ${reqAttr} ${f.hint ? `aria-describedby="${id}-hint"` : ''}`;
    let control;
    let upload = '';
    // 发音人下拉：选项来自服务端 /api/voice/list（平台 tts/list），加载中只显示一行占位
    let opts = f.options || [];
    if (f.optionsFrom === 'voiceList') {
      opts = !s.voiceOptions
        ? [['', '正在加载发音人列表…']]
        : [['', '默认音色（晓悦）'], ...s.voiceOptions.map((v) => [v.qid, v.materialName || v.voiceName || v.qid])];
    }
    if (f.type === 'avatarPicker') {
      // 系统形象选择器（下拉选择，滚动条翻 60 个）：选一个自动填入下面的编号与模型地址，并显示所选形象缩略图
      const avatars = s.avatarOptions;
      const selected = String(e.params.faceFeatureId || '');
      const picked = (avatars || []).find((a) => String(a.faceFeatureId || '') === selected);
      if (!avatars) {
        control = `<div class="avatar-picker__empty">正在加载系统形象列表…</div>`;
      } else if (!avatars.length) {
        control = `<div class="avatar-picker__empty">系统形象列表为空或加载失败，可直接在下方填写编号与模型地址。</div>`;
      } else {
        control = `<select ${common} class="input exp-input"><option value="">请选择系统形象（共 ${avatars.length} 个）</option>${avatars.map((a) => `<option value="${esc(a.faceFeatureId || '')}" ${String(a.faceFeatureId || '') === selected ? 'selected' : ''}>${esc(a.name || '')}${a.avatarType === 3 ? '（互动）' : a.avatarType === 4 ? '（动作编辑）' : ''}</option>`).join('')}</select>${picked ? `<span class="avatar-selected"><img src="${esc(picked.thumbnailUrl || '')}" alt="${esc(picked.name || '已选形象')}" /><span>已选：${esc(picked.name || '')}</span></span>` : ''}`;
      }
    } else if (f.type === 'images') {
      // 多图上传（对齐如影「图片编辑信息」弹窗）：上传框 + 缩略图 + 地址框。
      // 值仍是换行分隔的图片地址，与服务端 buildImageEditBody 的解析口径一致，请求体不动。
      const urls = String(val).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const maxed = urls.length >= (Number(f.maxItems) || 3);
      const thumbs = urls.map((u) => `<span class="img-thumb"><img src="${esc(u)}" alt="已上传图片" /><button class="img-thumb__remove" type="button" data-action="exp-images-remove" data-field="${esc(f.key)}" data-url="${esc(u)}" ${busy ? 'disabled' : ''} aria-label="移除这张图片">×</button></span>`).join('');
      control = `<div class="img-upload"><button class="img-upload-box" type="button" data-action="exp-upload" data-field="${esc(f.key)}" data-kind="${esc(f.upload || 'image')}" ${busy || maxed ? 'disabled' : ''} aria-label="上传图片">+</button>${thumbs}<input type="file" class="sr-only" data-upload-field="${esc(f.key)}" data-kind="${esc(f.upload || 'image')}" accept="${esc(f.accept || UPLOAD_ACCEPT[f.upload] || '')}" multiple tabindex="-1" /></div><textarea ${common} class="editor exp-input" rows="2" placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>`;
    } else if (f.type === 'toggle') {
      // 开关（对齐如影的图片水印开关）：值仍是「开启」/「关闭」，与请求体里的 watermark 口径一致。
      const on = String(val) !== '关闭';
      control = `<label class="switch"><input type="checkbox" ${common} data-on="开启" data-off="关闭" ${on ? 'checked' : ''} /><span class="switch-slider" aria-hidden="true"></span><span class="switch-label">${on ? '开启' : '关闭'}</span></label>`;
    } else if (f.type === 'slider') {
      // 滑块（语速/音量/语调）：与控制台 voiceTest 的三个滑块一致，值由 input 事件实时同步（见 main.js）
      const v = val === '' ? f.default : val;
      control = `<div class="range-row"><span class="range-ends" aria-hidden="true">${esc(f.minLabel || '')}</span><input ${common} class="exp-range" type="range" min="${f.min}" max="${f.max}" step="${f.step ?? 1}" value="${esc(v)}" /><span class="range-ends" aria-hidden="true">${esc(f.maxLabel || '')}</span><output class="range-value" for="${id}">${esc(v)}</output></div>`;
    } else if (f.type === 'textarea') control = `<textarea ${common} class="editor exp-input" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>`;
    else if (f.type === 'select') control = `<select ${common} class="input exp-input">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    else control = `<input ${common} class="input exp-input" type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}" />`;
    // 可上传的 URL 字段：右侧放「上传文件」，传完自动填入本站地址（多图字段自带上传框，不重复放按钮）
    if (f.upload && f.type !== 'images') upload = `<button class="btn btn--sm" type="button" data-action="exp-upload" data-field="${esc(f.key)}" data-kind="${esc(f.upload)}" ${busy ? 'disabled' : ''}>上传文件</button><input type="file" class="sr-only" data-upload-field="${esc(f.key)}" data-kind="${esc(f.upload)}" accept="${esc(UPLOAD_ACCEPT[f.upload] || '')}" tabindex="-1" />`;
    const row = upload ? `<div class="exp-field-row">${control}${upload}</div>` : control;
    // 上次的结果：字段空着时一键填入（上次合成的音频 / 上次训好的形象）
    const recent = recentForField(f.key, s.recent || {});
    const recentChip = recent && !String(val).trim()
      ? `<button class="btn btn--sm btn--ghost" type="button" data-action="exp-recent" data-field="${esc(f.key)}" data-value="${esc(recent.value)}" ${busy ? 'disabled' : ''}>${esc(recent.label)}</button>` : '';
    // 图片数字人：服务端有默认形象图时，显示缩略图并可一键填入
    const defaultAvatar = cap.id === 'video-image' && f.key === 'imageUrl' && s.config?.avatarImageUrl
      ? `<span class="default-avatar"><img src="${esc(s.config.avatarImageUrl)}" class="default-avatar-thumb" alt="服务端默认形象图" /><button class="btn btn--sm btn--ghost" type="button" data-action="exp-default-avatar" data-field="imageUrl" data-value="${esc(s.config.avatarImageUrl)}" ${busy ? 'disabled' : ''}>使用默认形象图</button></span>` : '';
    const extras = [recentChip, defaultAvatar].filter(Boolean).join('');
    const hintText = f.key === 'qid' && s.voiceListFailed ? '发音人列表加载失败，可直接输入 QID 或用默认音色' : f.hint;
    return `${stepHead}<div class="form-field"><label for="${id}">${f.required ? '<span class="req" aria-hidden="true">*</span>' : ''}${esc(f.label)}</label>${row}${extras ? `<div class="exp-field-extra">${extras}</div>` : ''}${hintText ? `<small class="field-hint" id="${id}-hint">${esc(hintText)}</small>` : ''}</div>`;
  }).join('');

  // 视频脚本 / 直播脚本：导入控制台导出的 JSON 回填表单（上传文件（.json）的同款入口）
  const scriptCap = cap.id === 'video-script' || cap.id === 'live-script';
  const exportName = cap.id === 'live-script' ? '导出直播脚本' : '导出视频合成脚本';
  const importRow = scriptCap
    ? `<div class="actions" style="margin-bottom:12px"><label class="btn" for="exp-import-json">导入 JSON</label><input type="file" id="exp-import-json" class="sr-only" accept=".json,application/json" data-import-json tabindex="-1" ${busy ? 'disabled' : ''} /><span class="field-hint">控制台「${exportName}」的文件，或本站下载的 JSON，都能导回表单。</span></div>`
    : '';
  const body = `${requiresCard(ex, s.config)}
    <div class="grid-2 exp-grid">
      <div class="card"><div class="card__title"><h2>${esc(ex.dialogTitle || '填写参数')}</h2><span class="pill pill--info">输出：${OUTPUT_LABEL[ex.output] || '文本'}</span></div>
        ${importRow}
        <div class="exp-form-grid">${fields}</div>
        <div class="actions">
          ${ex.dialogTitle
            ? `<button class="btn" type="button" data-action="nav-back" ${busy ? 'disabled' : ''}>取消</button>
          <button class="btn btn--primary" type="button" data-action="exp-run" ${busy ? 'disabled aria-busy="true"' : ''}>${busy ? '运行中…' : esc(ex.submit || '确定')}</button>`
            : `<button class="btn btn--primary" type="button" data-action="exp-run" ${busy ? 'disabled aria-busy="true"' : ''}>${busy ? '运行中…' : esc(ex.submit || '运行')}</button>
          <button class="btn" type="button" data-action="exp-reset" ${busy ? 'disabled' : ''}>恢复默认参数</button>`}
        </div>
        ${ex.notes ? `<p class="field-hint">${esc(ex.notes)}</p>` : ''}
      </div>
      <div class="card exp-side"><div class="card__title"><h2>能力说明</h2></div>
        <p class="exp-desc">${esc(cap.desc)}</p>
        <table class="table kv-table"><tbody>
          <tr><th scope="row">所属大类</th><td>${esc(g?.name || '')}</td></tr>
          <tr><th scope="row">适用场景</th><td>${esc(cap.scene)}</td></tr>
          <tr><th scope="row">平台接口</th><td><code class="code-sm">${esc(cap.api)}</code></td></tr>
          <tr><th scope="row">文档章节</th><td>${esc(cap.doc)}</td></tr>
          <tr><th scope="row">计费</th><td>${cap.billable ? '<span class="warn">真实环境调用会计费</span>' : '不计费'}</td></tr>
        </tbody></table>
      </div>
    </div>
    ${manageSection(s, cap)}
    ${busy ? `<div class="card">${progressLine(e)}</div>` : ''}
    ${e.error ? `<div class="card">${errorBlock(e.error, { retry: 'exp-run', resume: 'exp-resume' })}</div>` : ''}
    ${e.result ? experienceResult(e.result, cap, e.taskId || '') : ''}`;
  if (opts.embedded) return body;
  return `<div class="console exp-shell">
    <nav class="exp-crumb" aria-label="位置"><a href="#create" data-view="create">创作中心</a><span aria-hidden="true">/</span><span>${esc(g?.name || '')}</span><span aria-hidden="true">/</span><b aria-current="page">${esc(cap.name)}</b></nav>
    ${body}
  </div>`;
}

function progressLine(e) {
  const elapsedMs = e.startedAt ? Date.now() - e.startedAt : 0;
  const s = Math.floor(elapsedMs / 1000);
  // 百分比是估算（平台只给状态不给进度）：完成 100%，排队 10%，生成中按已等待时间逼近 90%
  const pct = estimateProgress(e.status ?? 1, elapsedMs, e.expectMs || 60000);
  return `<div class="task-progress" role="status" aria-live="polite"><div class="task-progress__head"><span class="spinner" aria-hidden="true"></span>
    <b>${esc(e.stage || '已提交')}</b><span class="muted" data-progress="exp">约 ${pct}%（估算）</span><span class="muted" data-elapsed="exp">已等待 ${s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`}</span>
    ${e.taskId ? '<button class="btn btn--sm btn--ghost" type="button" data-action="exp-stop">停止等待</button>' : ''}</div>
    <span class="task-progress__tip" data-wait-tip="exp"></span>
    ${e.queued ? '<p class="task-progress__note">平台侧队列可能在排队，任务还没开始生成。可以继续等待，也可以停止后稍后重试。</p>' : ''}</div>`;
}

export function experienceResult(r, cap, taskId = '') {
  const out = r.output;
  let body = '';
  const save = '<button class="btn" type="button" data-action="exp-save">保存到作品</button>';
  if (out === 'video') {
    body = `<video controls playsinline preload="metadata" ${r.thumbUrl ? `poster="${esc(r.thumbUrl)}"` : ''} src="${esc(r.videoUrl)}" class="media-video" aria-label="${esc(r.title || '生成的视频')}"></video>
      <div class="actions"><a class="btn" href="${esc(r.videoUrl)}" download="${esc(downloadName({ title: r.title || cap.name, taskId }, r.videoUrl, 'mp4'))}">下载视频</a>${save}</div>`;
  } else if (out === 'audio') {
    body = `<audio controls src="${esc(r.audioUrl)}" class="media-audio" aria-label="${esc(r.title || '生成的音频')}"></audio>
      <div class="actions"><a class="btn" href="${esc(r.audioUrl)}" download="${esc(downloadName({ title: r.title || cap.name, taskId }, r.audioUrl, 'mp3'))}">下载音频</a>${save}</div>`;
  } else if (out === 'image') {
    body = `<img src="${esc(r.imageUrl)}" alt="${esc(r.title || '生成的图片')}（${r.mode === 'real' ? '平台生成' : '演示样例图'}）" class="media-image" />
      <div class="actions"><a class="btn" href="${esc(r.imageUrl)}" download="${esc(downloadName({ title: r.title || cap.name, taskId }, r.imageUrl, 'png'))}">下载图片</a>${save}</div>`;
  } else if (out === 'json') {
    // 音色复刻：真实环境的 QID 可一键复制，并说明怎么用上
    const qidCopy = cap.id === 'voice-clone' && r.mode === 'real' && r.json?.qid
      ? `<button class="btn" type="button" data-action="exp-copy-qid" data-qid="${esc(r.json.qid)}">复制 QID</button>` : '';
    const qidNote = cap.id === 'voice-clone' && r.mode === 'real' && r.json?.qid
      ? '<p class="field-hint">把这个 QID 发给管理员配到服务端，语音合成就能用这个音色。</p>' : '';
    // 视频脚本 / 直播脚本：下载这份 param JSON（控制台「导出视频合成脚本」/「导出直播脚本」的同款文件）
    const dlJson = (cap.id === 'video-script' || cap.id === 'live-script')
      ? `<button class="btn" type="button" data-action="exp-download-json">下载 JSON</button>` : '';
    // 直播脚本：存进本站脚本库（文档里没有脚本的创建/列表接口，脚本库是本站自己的存储）
    const saveScript = cap.id === 'live-script'
      ? `<button class="btn" type="button" data-action="exp-save-script">保存到脚本库</button>` : '';
    body = `<pre class="json-block" tabindex="0" aria-label="JSON 结果">${esc(r.jsonText || JSON.stringify(r.json, null, 2))}</pre>
      ${qidNote}<div class="actions"><button class="btn" type="button" data-action="exp-copy">复制 JSON</button>${dlJson}${saveScript}${qidCopy}${save}</div>`;
  } else {
    body = `<div class="text-result">${esc(r.text || '')}</div>
      <div class="actions"><button class="btn" type="button" data-action="exp-copy">复制文本</button>${save}</div>`;
  }
  const note = r.realModeNote || '';
  return `<div class="card" id="exp-result-card"><div class="card__title"><h2>运行结果</h2>
      ${r.mode === 'real' ? '<span class="pill pill--ok">真实环境结果</span>' : '<span class="pill pill--mock">演示结果 · 本地样例</span>'}</div>
    ${body}
    ${note ? `<p class="explain-card">${esc(note)}</p>` : ''}
    ${nextStepsHtml(r, cap)}
    ${r.mode !== 'real' ? '<p class="field-hint">演示结果是预置样例，用来展示这项能力的输出形态，不代表真实生成效果。</p>' : ''}
  </div>`;
}
