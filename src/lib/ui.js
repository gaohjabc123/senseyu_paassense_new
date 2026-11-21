// ui.js —— 页面内确认框 / 输入框，替换 window.confirm / window.prompt。
// 复用平台现有的 state.dialog 覆盖层（.sheet-mask + .sheet）与焦点陷阱、Esc 关闭逻辑。
// 与界面无关的部分只有 askConfirm / askPrompt 两个 Promise 接口，调用处几乎不用改：
//   if (!window.confirm('确认删除？')) return;          →  if (!await askConfirm('确认删除？', { danger: true })) return;
//   const name = window.prompt('改个名字', old);       →  const name = await askPrompt('改个名字', { value: old });
import { esc } from './html.js';

let pending = null;           // 当前等待用户回应的 { resolve, kind }
let lastFocus = null;         // 打开前的焦点，关闭后还回去

/** 由 main.js 注入：setDialog / clearDialog / getDialog / render */
let bridge = { setDialog() {}, clearDialog() {}, getDialog() { return null; }, render() {} };
export function initUi(b) { bridge = { ...bridge, ...b }; }

function open(dialog) {
  // 同一时间只保留一个提问；新的来了，旧的按"取消"处理
  if (pending) settle(pending.kind === 'prompt' ? null : false);
  lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  bridge.setDialog(dialog);
  bridge.render();
  return new Promise((resolve) => { pending = { resolve, kind: dialog.type === 'prompt' ? 'prompt' : 'confirm' }; });
}

function settle(value) {
  const p = pending; pending = null;
  if (!p) return;
  bridge.clearDialog();
  bridge.render();
  // 把焦点还给触发它的按钮（render 会重建 DOM，按 id 或 data-* 找不到就退回 main）
  const back = lastFocus && document.contains(lastFocus) ? lastFocus : document.getElementById('main');
  back?.focus?.({ preventScroll: true });
  p.resolve(value);
}

/** @returns {Promise<boolean>} */
export function askConfirm(message, { title = '请确认', okText = '确定', cancelText = '取消', danger = false } = {}) {
  return open({ type: 'confirm', title, message, okText, cancelText, danger });
}

/** @returns {Promise<string|null>} 取消返回 null；确定返回输入框里的原文（不 trim，由调用方决定） */
export function askPrompt(message, { title = '请输入', value = '', okText = '确定', cancelText = '取消', placeholder = '', hint = '', validate = null, danger = false } = {}) {
  return open({ type: 'prompt', title, message, value, okText, cancelText, placeholder, hint, validate, danger });
}

export function isAskOpen() { return !!pending; }
/** Esc / 点遮罩 / 点"取消" */
export function cancelAsk() { if (pending) settle(pending.kind === 'prompt' ? null : false); }
/** 点"确定"；prompt 会先校验，不通过就留在弹窗里提示 */
export function acceptAsk(root) {
  if (!pending) return;
  if (pending.kind === 'prompt') {
    const input = root.querySelector('[data-ask-input]');
    const err = root.querySelector('[data-ask-error]');
    const v = input?.value ?? '';
    const msg = bridge.getDialog?.()?.validate?.(v);
    if (msg) { if (err) { err.textContent = msg; err.hidden = false; } input?.setAttribute('aria-invalid', 'true'); input?.focus(); return; }
    settle(v);
  } else settle(true);
}

/** 弹窗 HTML：role=alertdialog（确认）/ dialog（输入）、标题与说明都有 aria 关联、危险操作默认焦点在"取消" */
export function askDialogHtml(d) {
  const isPrompt = d.type === 'prompt';
  const role = isPrompt ? 'dialog' : 'alertdialog';
  const lines = String(d.message || '').split('\n').map((l) => `<p class="muted">${esc(l)}</p>`).join('');
  const okCls = d.danger ? 'btn btn--primary btn--danger-solid' : 'btn btn--primary';
  const field = isPrompt
    ? `<div class="form-field"><input class="input" id="ask-input" data-ask-input data-autofocus type="text" value="${esc(d.value)}" placeholder="${esc(d.placeholder)}" aria-describedby="ask-desc ask-error" autocomplete="off" spellcheck="false">
       <small class="field-hint" id="ask-hint">${esc(d.hint)}</small>
       <small class="field-error" id="ask-error" data-ask-error role="alert" hidden></small></div>`
    : '';
  // 危险操作：默认聚焦"取消"，防止用户手快直接回车删掉东西；普通确认默认聚焦"确定"
  const cancelFocus = !isPrompt && d.danger ? ' data-autofocus' : '';
  const okFocus = !isPrompt && !d.danger ? ' data-autofocus' : '';
  return `<div class="sheet-mask" data-action="ask-no"></div>
  <form class="sheet" role="${role}" aria-modal="true" aria-labelledby="ask-title" aria-describedby="ask-desc" data-ask-form>
    <h3 id="ask-title">${esc(d.title)}</h3>
    <div id="ask-desc">${lines}</div>
    ${field}
    <div class="actions">
      <button class="btn" type="button" data-action="ask-no"${cancelFocus}>${esc(d.cancelText)}</button>
      <button class="${okCls}" type="submit"${okFocus}>${esc(d.okText)}</button>
    </div></form>`;
}
