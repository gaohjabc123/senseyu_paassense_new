// experience.js —— 通用能力体验器（数据驱动：按 capabilities.js 的规格渲染任意能力）
import { groupOf, OUTPUT_LABEL } from './capabilities.js';
import { esc } from './html.js';
import { errorBlock } from './views.js';

export function experienceView(s, cap) {
  const ex = cap.experience || {};
  const g = groupOf(cap.group);
  const e = s.exp;
  const busy = e.running;
  const fields = (ex.fields || []).map((f) => {
    const id = `exp-${f.key}`;
    const val = e.params[f.key] ?? f.default ?? '';
    const common = `id="${id}" data-field="${esc(f.key)}" ${busy ? 'disabled' : ''} ${f.hint ? `aria-describedby="${id}-hint"` : ''}`;
    let control;
    if (f.type === 'textarea') control = `<textarea ${common} class="editor exp-input" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(val)}</textarea>`;
    else if (f.type === 'select') control = `<select ${common} class="input exp-input">${(f.options || []).map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    else control = `<input ${common} class="input exp-input" type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(val)}" placeholder="${esc(f.placeholder || '')}" />`;
    return `<div class="form-field"><label for="${id}">${esc(f.label)}</label>${control}${f.hint ? `<small class="field-hint" id="${id}-hint">${esc(f.hint)}</small>` : ''}</div>`;
  }).join('');

  return `<div class="console exp-shell">
    <nav class="exp-crumb" aria-label="位置"><a href="#catalog" data-view="catalog">能力目录</a><span aria-hidden="true">/</span><span>${esc(g?.name || '')}</span><span aria-hidden="true">/</span><b aria-current="page">${esc(cap.name)}</b></nav>
    <div class="grid-2 exp-grid">
      <div class="card"><div class="card__title"><h2>填写参数</h2><span class="pill pill--info">输出：${OUTPUT_LABEL[ex.output] || '文本'}</span></div>
        <div class="form-grid">${fields}</div>
        <div class="actions">
          <button class="btn btn--primary" type="button" data-action="exp-run" ${busy ? 'disabled aria-busy="true"' : ''}>${busy ? '运行中…' : esc(ex.submit || '运行')}</button>
          <button class="btn" type="button" data-action="exp-reset" ${busy ? 'disabled' : ''}>恢复默认参数</button>
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
    ${busy ? `<div class="card">${progressLine(e)}</div>` : ''}
    ${e.error ? `<div class="card">${errorBlock(e.error, { retry: 'exp-run', resume: 'exp-resume' })}</div>` : ''}
    ${e.result ? experienceResult(e.result) : ''}
  </div>`;
}

function progressLine(e) {
  const s = e.startedAt ? Math.floor((Date.now() - e.startedAt) / 1000) : 0;
  return `<div class="task-progress" role="status" aria-live="polite"><div class="task-progress__head"><span class="spinner" aria-hidden="true"></span>
    <b>${esc(e.stage || '已提交')}</b><span class="muted" data-elapsed="exp">已等待 ${s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`}</span>
    ${e.taskId ? '<button class="btn btn--sm btn--ghost" type="button" data-action="exp-stop">停止等待</button>' : ''}</div>
    ${e.queued ? '<p class="task-progress__note">平台侧队列可能在排队，任务还没开始生成。可以继续等待，也可以停止后稍后重试。</p>' : ''}</div>`;
}

export function experienceResult(r) {
  const out = r.output;
  let body = '';
  const save = '<button class="btn" type="button" data-action="exp-save">保存到作品</button>';
  if (out === 'video') {
    body = `<video controls playsinline preload="metadata" ${r.thumbUrl ? `poster="${esc(r.thumbUrl)}"` : ''} src="${esc(r.videoUrl)}" class="media-video" aria-label="${esc(r.title || '生成的视频')}"></video>
      <div class="actions"><a class="btn" href="${esc(r.videoUrl)}" download>下载视频</a>${save}</div>`;
  } else if (out === 'audio') {
    body = `<audio controls src="${esc(r.audioUrl)}" class="media-audio" aria-label="${esc(r.title || '生成的音频')}"></audio>
      <div class="actions"><a class="btn" href="${esc(r.audioUrl)}" download>下载音频</a>${save}</div>`;
  } else if (out === 'image') {
    body = `<img src="${esc(r.imageUrl)}" alt="${esc(r.title || '生成的图片')}（${r.mode === 'real' ? '平台生成' : '演示样例图'}）" class="media-image" />
      <div class="actions"><a class="btn" href="${esc(r.imageUrl)}" download>下载图片</a>${save}</div>`;
  } else if (out === 'json') {
    body = `<pre class="json-block" tabindex="0" aria-label="JSON 结果">${esc(r.jsonText || JSON.stringify(r.json, null, 2))}</pre>
      <div class="actions"><button class="btn" type="button" data-action="exp-copy">复制 JSON</button>${save}</div>`;
  } else {
    body = `<div class="text-result">${esc(r.text || '')}</div>
      <div class="actions"><button class="btn" type="button" data-action="exp-copy">复制文本</button>${save}</div>`;
  }
  const note = r.realModeNote || '';
  return `<div class="card" id="exp-result-card"><div class="card__title"><h2>运行结果</h2>
      ${r.mode === 'real' ? '<span class="pill pill--ok">真实环境结果</span>' : '<span class="pill pill--mock">演示结果 · 本地样例</span>'}</div>
    ${body}
    ${note ? `<p class="explain-card">${esc(note)}</p>` : ''}
    ${r.mode !== 'real' ? '<p class="field-hint">演示结果是预置样例，用来展示这项能力的输出形态，不代表真实生成效果。</p>' : ''}
  </div>`;
}
