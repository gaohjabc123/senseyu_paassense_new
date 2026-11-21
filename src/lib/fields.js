// fields.js —— 把校验结果"挂到字段上"（行内错误 + aria-invalid + 聚焦首个错误）。
// 不整页重渲染：直接改 DOM，所以失焦/输入时不会打断用户正在输入的内容。
// 同时给 render() 之后用：re-apply(errors) 会在重渲染后把错误重新挂回去。

const errId = (id) => `${id}-err`;

/** 给单个字段设置 / 清除错误 */
export function setFieldError(root, id, message) {
  const input = root.querySelector(`#${CSS.escape(id)}`);
  if (!input) return;
  const field = input.closest('.form-field') || input.parentElement;
  let box = field.querySelector(`#${CSS.escape(errId(id))}`);
  if (message) {
    if (!box) {
      box = document.createElement('small');
      box.id = errId(id); box.className = 'field-error'; box.setAttribute('role', 'alert');
      field.appendChild(box);
    }
    box.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    // 保留原有 aria-describedby（如密码提示），把错误追加进去
    const ids = new Set((input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)); ids.add(errId(id));
    input.setAttribute('aria-describedby', [...ids].join(' '));
  } else {
    box?.remove();
    input.removeAttribute('aria-invalid');
    const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== errId(id));
    if (ids.length) input.setAttribute('aria-describedby', ids.join(' ')); else input.removeAttribute('aria-describedby');
  }
}

/** 一次性应用整张表的错误：先清掉旧的，再挂新的；聚焦第一个出错字段；返回是否有错 */
export function applyErrors(root, errors, allIds, { focus = true } = {}) {
  for (const id of allIds) setFieldError(root, id, errors[id] || '');
  const first = allIds.find((id) => errors[id]);
  if (first && focus) {
    const el = root.querySelector(`#${CSS.escape(first)}`);
    el?.focus?.(); el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }
  return !!first;
}

/** 汇总文案：用于 aria-live，读屏用户能一次听到"有 N 项需要修改" */
export const summaryText = (errors) => {
  const n = Object.keys(errors).length;
  return n ? `有 ${n} 项需要修改，已定位到第一项。` : '';
};
