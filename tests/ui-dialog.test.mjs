// ui-dialog.test.mjs —— 页面内确认/输入弹窗（src/lib/ui.js）与字段错误挂载（src/lib/fields.js）
// 用最小假 DOM 在 Node 里跑，不需要浏览器。假 DOM 只实现被测代码真正用到的那几个方法。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

class FakeEl {
  constructor(tag = 'div') { this.tag = tag; this.value = ''; this.hidden = true; this.textContent = ''; this.attrs = {}; this.children = []; this.parent = null; this.id = ''; this.className = ''; this.focused = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  get parentElement() { return this.parent; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; }
  closest(sel) { return sel === '.form-field' ? (this.isField ? this : this.parent?.closest(sel) ?? null) : null; }
  querySelector(sel) { const m = sel.match(/^#(.+)$/); if (!m) return null; const want = m[1].replace(/\\/g, ''); const walk = (n) => { for (const c of n.children) { if (c.id === want) return c; const r = walk(c); if (r) return r; } return null; }; return walk(this); }
}
const mainEl = new FakeEl('main');
globalThis.HTMLElement = FakeEl;
globalThis.CSS = { escape: (s) => String(s).replace(/([^\w-])/g, '\\$1') };       // Node 没有 CSS.escape
globalThis.document = { activeElement: mainEl, contains: () => true, getElementById: () => mainEl, createElement: (t) => new FakeEl(t) };

// 假 DOM 自检：被测代码依赖的这几个行为，一旦假 DOM 被改坏就在这里先红，而不是让后面的用例给出误导性的绿/红
test('假 DOM 自检', () => {
  const p = new FakeEl(); const c = new FakeEl(); c.id = 'x-y'; p.appendChild(c);
  assert.equal(p.querySelector('#x-y'), c, 'querySelector 能找到带 - 的 id'); assert.equal(c.parentElement, p);
  c.remove(); assert.equal(p.querySelector('#x-y'), null, 'remove 之后查不到');
  assert.equal(globalThis.CSS.escape('a b'), 'a\\ b');
});

const ui = await import('../src/lib/ui.js');
const fields = await import('../src/lib/fields.js');

let state, renders;
beforeEach(() => {
  state = { dialog: null }; renders = 0;
  ui.cancelAsk();                       // 清掉上一条用例可能遗留的未决弹窗
  ui.initUi({ setDialog: (d) => { state.dialog = d; }, clearDialog: () => { state.dialog = null; }, getDialog: () => state.dialog, render: () => { renders += 1; } });
});
const root = (input, err) => ({ querySelector: (s) => (s === '[data-ask-input]' ? input : s === '[data-ask-error]' ? err : null) });

test('确认：打开 → 点确定返回 true 并关闭', async () => {
  const p = ui.askConfirm('删除？', { danger: true });
  assert.ok(ui.isAskOpen()); assert.equal(state.dialog.type, 'confirm');
  ui.acceptAsk(root());
  assert.equal(await p, true); assert.equal(ui.isAskOpen(), false); assert.equal(state.dialog, null);
});

test('确认：取消 / Esc 返回 false', async () => {
  const p = ui.askConfirm('删除？'); ui.cancelAsk();
  assert.equal(await p, false); assert.equal(ui.isAskOpen(), false);
});

test('输入：校验失败时弹窗保持打开，错误显示在弹窗内；修正后返回输入值', async () => {
  const input = new FakeEl('input'), err = new FakeEl('small');
  const p = ui.askPrompt('改名', { value: '旧', validate: (v) => (v.trim() ? '' : '名字不能为空') });
  input.value = '  '; ui.acceptAsk(root(input, err));
  assert.ok(ui.isAskOpen(), '校验不过不能关闭');
  assert.equal(err.textContent, '名字不能为空'); assert.equal(err.hidden, false); assert.equal(input.getAttribute('aria-invalid'), 'true'); assert.ok(input.focused);
  input.value = '新名字'; ui.acceptAsk(root(input, err));
  assert.equal(await p, '新名字'); assert.equal(ui.isAskOpen(), false);
});

test('输入：取消返回 null（不是空字符串）', async () => {
  const p = ui.askPrompt('改名', { value: 'x' }); ui.cancelAsk();
  assert.equal(await p, null);
});

test('连续弹出：前一个按取消处理，后一个接管', async () => {
  const p1 = ui.askConfirm('A'); const p2 = ui.askConfirm('B');
  assert.equal(await p1, false); assert.ok(ui.isAskOpen());
  ui.acceptAsk(root()); assert.equal(await p2, true);
});

test('弹窗 HTML：危险确认默认焦点在「取消」；普通确认在「确定」；标题与输入值已转义', () => {
  const danger = ui.askDialogHtml({ type: 'confirm', title: '<b>x</b>', message: 'a\nb', okText: '删除', cancelText: '取消', danger: true });
  assert.match(danger, /role="alertdialog"/);
  assert.match(danger, /data-action="ask-no" data-autofocus/, '危险操作默认聚焦取消，防止回车误删');
  assert.match(danger, /btn--danger-solid/); assert.ok(danger.includes('&lt;b&gt;'));
  assert.match(ui.askDialogHtml({ type: 'confirm', title: 't', message: 'm', okText: '确定', cancelText: '取消', danger: false }), /type="submit" data-autofocus/);
  const prompt = ui.askDialogHtml({ type: 'prompt', title: 't', message: 'm', value: '"><script>', okText: '确定', cancelText: '取消', placeholder: '', hint: '' });
  assert.ok(!prompt.includes('"><script>'), '输入框 value 必须转义');
  assert.match(prompt, /data-ask-input data-autofocus/); assert.match(prompt, /role="alert"/); assert.match(prompt, /aria-describedby="ask-desc ask-error"/);
});

test('字段错误：设置 → aria-invalid + aria-describedby 追加；清除后还原，保留原有 describedby', () => {
  const form = new FakeEl('form'); const field = new FakeEl('div'); field.isField = true; field.className = 'form-field';
  const input = new FakeEl('input'); input.id = 'pw-new'; input.setAttribute('aria-describedby', 'pw-hint');
  field.appendChild(input); form.appendChild(field);
  fields.setFieldError(form, 'pw-new', '密码至少 8 位');
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.getAttribute('aria-describedby'), 'pw-hint pw-new-err', '保留原有提示并追加错误');
  const box = field.children.find((c) => c.id === 'pw-new-err');
  assert.equal(box.textContent, '密码至少 8 位'); assert.equal(box.getAttribute('role'), 'alert');
  fields.setFieldError(form, 'pw-new', '另一条错误');
  assert.equal(field.children.filter((c) => c.id === 'pw-new-err').length, 1, '重复设置只更新文字，不重复插入');
  fields.setFieldError(form, 'pw-new', '');
  assert.equal(input.getAttribute('aria-invalid'), null); assert.equal(input.getAttribute('aria-describedby'), 'pw-hint', '清除后恢复原样');
  assert.ok(!field.children.some((c) => c.id === 'pw-new-err'));
});

test('applyErrors：聚焦第一个出错字段，返回是否有错；汇总文案', () => {
  const form = new FakeEl('form'); const mk = (id) => { const f = new FakeEl('div'); f.isField = true; const i = new FakeEl('input'); i.id = id; f.appendChild(i); form.appendChild(f); return i; };
  const a = mk('a'), b = mk('b'), c = mk('c');
  assert.equal(fields.applyErrors(form, { b: 'bad', c: 'bad2' }, ['a', 'b', 'c']), true);
  assert.ok(b.focused && !a.focused && !c.focused, '聚焦的是排在最前的出错字段');
  assert.equal(fields.applyErrors(form, {}, ['a', 'b', 'c']), false); assert.equal(b.getAttribute('aria-invalid'), null, '全部通过时清掉旧错误');
  assert.equal(fields.summaryText({ a: 1, b: 2 }), '有 2 项需要修改，已定位到第一项。'); assert.equal(fields.summaryText({}), '');
});
