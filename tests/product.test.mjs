// product.test.mjs —— 产品化数据层与视图一致性测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT, NAV_SECTIONS, SITE_VIEWS, navById, DEFAULT_VIEW, MODE_NOTICE, BRAND_LOGOS } from '../src/lib/product.js';
import { GROUPS, CAPABILITIES, SCENARIOS, INTEGRATION_STEPS, capsOf, readyCaps, capById, groupOf, stats } from '../src/lib/capabilities.js';

test('product：品牌与导航结构完整', () => {
  assert.equal(PRODUCT.name, '如影 AI 能力开放平台');
  assert.equal(PRODUCT.vendor, '商予科技');
  assert.deepEqual(BRAND_LOGOS.map((l) => l.id), ['sensetime', 'senseyu'], '顶栏与页脚必须是商汤 + 商予双 logo');
  assert.ok(PRODUCT.docsUrl.startsWith('https://'));
  assert.equal(NAV_SECTIONS.length, 2);
  assert.ok(NAV_SECTIONS.find((s) => s.id === 'site'));
  assert.ok(NAV_SECTIONS.find((s) => s.id === 'console'));
  assert.ok(navById(DEFAULT_VIEW));
  assert.match(MODE_NOTICE.mock, /不产生费用/);
});

test('capabilities：每个能力都有合法分组、状态与文档出处', () => {
  for (const c of CAPABILITIES) {
    assert.ok(c.id && c.name && c.desc && c.api && c.doc && c.scene, `${c.id} 字段不完整`);
    assert.ok(groupOf(c.group), `${c.id} 分组 ${c.group} 不存在`);
    assert.equal(c.status, 'ready', `${c.id} 应为可体验状态`);
  }
  // id 唯一
  assert.equal(new Set(CAPABILITIES.map((c) => c.id)).size, CAPABILITIES.length);
});

test('capabilities：能力矩阵覆盖 6 大类且统计自洽', () => {
  assert.equal(GROUPS.length, 6);
  for (const g of GROUPS) assert.ok(capsOf(g.id).length > 0, `${g.name} 无能力项`);
  assert.ok(readyCaps().length >= 4, '至少要有多条可体验能力');
  const st = stats();
  assert.equal(st.groups, GROUPS.length);
  assert.equal(st.capabilities, CAPABILITIES.length);
  assert.equal(st.ready, readyCaps().length);
  assert.equal(st.scenarios, SCENARIOS.length);
});

test('capabilities：场景引用的能力 id 都真实存在', () => {
  for (const sc of SCENARIOS) {
    assert.ok(sc.name && sc.desc && sc.icon);
    for (const id of sc.caps) assert.ok(capById(id), `${sc.name} 引用了不存在的 ${id}`);
  }
});

test('capabilities：接入流程四步且与官方快速集成一致', () => {
  assert.equal(INTEGRATION_STEPS.length, 4);
  assert.deepEqual(INTEGRATION_STEPS.map((x) => x.n), ['01', '02', '03', '04']);
  assert.match(INTEGRATION_STEPS[0].desc, /凭据|APP_ID/);
  assert.match(INTEGRATION_STEPS[1].desc, /Token|签名/);
});

test('product：全部能力可体验且体验规格完整（都接入）', () => {
  assert.equal(readyCaps().length, CAPABILITIES.length, '所有能力都应为 ready（用户要求「都接入 可体验」）');
  const outputs = new Set(['video', 'audio', 'image', 'json', 'text', 'chat']);
  for (const c of CAPABILITIES) {
    const ex = c.experience;
    assert.ok(ex, `${c.id} 缺少 experience 体验规格`);
    assert.ok(outputs.has(ex.output), `${c.id} output 类型非法：${ex.output}`);
    assert.ok(ex.submit && ex.mockTitle && ex.notes, `${c.id} 体验规格字段不完整`);
    assert.ok(!(ex.fields || []).some((f) => f.key === 'voice'), `${c.id} 不应再有不生效的音色下拉`);
    assert.ok(Array.isArray(ex.fields) && ex.fields.length > 0, `${c.id} 没有输入字段`);
    for (const f of ex.fields) {
      assert.ok(f.key && f.label && f.type, `${c.id} 字段定义不完整`);
      assert.ok(['text', 'textarea', 'select', 'number', 'images', 'toggle', 'slider', 'avatarPicker'].includes(f.type), `${c.id} 字段类型非法`);
      if (f.type === 'select' || f.type === 'avatarPicker') assert.ok((Array.isArray(f.options) && f.options.length) || f.optionsFrom, `${c.id} 下拉/选择器缺少选项`);
      // 滑块步长 step 必须是数字：步骤分组用 section 键，禁止复用 step（曾导致步长被「人物设置」覆盖、2.5 吸附成 2.1）
      if (f.type === 'slider') assert.ok(typeof f.step === 'number' && f.step > 0, `${c.id} 滑块 ${f.key} 的 step 必须是正数`);
    }
    assert.ok(c.realApi === null || typeof c.realApi === 'string', `${c.id} realApi 定义非法`);
    assert.equal(typeof c.billable, 'boolean');
  }
});

test('版本号只在 package.json 定义，源码里没有手写版本号', async () => {
  const fs = await import('node:fs');
  const { VERSION } = await import('../server/lib/version.mjs');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  for (const f of ['server/index.mjs', 'src/lib/product.js', 'src/main.js']) {
    const src = fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.ok(!src.includes(`'${pkg.version}'`), `${f} 里不应写死版本号`);
  }
});

test('布局回归：开关轨道不被表单 label 规则盖掉，能力表按钮不换行', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');
  // .form-field label 是 (0,1,1)，单写 .switch (0,1,0) 会输：轨道 0 宽、圆点压住「开启」文字
  assert.match(css, /\.form-field label\.switch\s*\{[^}]*display:\s*inline-flex/, '开关选择器必须盖过 .form-field label 的 display:block');
  // 能力矩阵 / 能力目录的「体验」按钮曾被挤成「体/验」两行
  assert.match(css, /\.cap-table td:last-child[^{]*\{[^}]*white-space:\s*nowrap/, '能力表操作列必须不换行');
  assert.match(css, /\.table td \.btn\s*\{[^}]*white-space:\s*nowrap/, '表内按钮必须不换行');
});

test('导航按角色与客户类别：院校多出教学与班级管理，企业保持不变', async () => {
  const { navFor, roleLabel, ORG_TYPES } = await import('../src/lib/product.js');
  const ids = (role, isSchool) => navFor(role, { isSchool }).flatMap((s) => s.items.map((i) => i.id));
  assert.ok(!ids('tenant_admin', false).includes('teach'), '企业管理员没有批改入口');
  assert.ok(!ids('tenant_admin', false).includes('org/classes'));
  assert.ok(ids('teacher', true).includes('teach'));
  assert.ok(!ids('teacher', true).includes('org/users'), '教师不能管理账号');
  assert.ok(ids('tenant_admin', true).includes('org/classes') && ids('tenant_admin', true).includes('teach'));
  assert.ok(!ids('member', true).includes('teach'), '学生没有批改入口');
  for (const id of new Set([...ids('tenant_admin', true), ...ids('super_admin', false)])) assert.ok(navById(id), `${id} 应能被路由识别`);
  assert.equal(roleLabel('member', true), '学生'); assert.equal(roleLabel('member', false), '成员');
  assert.deepEqual(ORG_TYPES.map((t) => t.id), ['enterprise', 'vocational', 'applied', 'university']);
});

test('批量导入名单解析：逗号 / 中文逗号 / 制表符，跳过表头与空行', async () => {
  const { parseRoster } = await import('../src/lib/admin.js');
  const rows = parseRoster('学号,姓名,班级\n20260101, 张三 , 数媒1班\n\n20260102\t李四\t数媒1班\nwang_lei，王磊\n');
  assert.deepEqual(rows, [
    { username: '20260101', displayName: '张三', className: '数媒1班' },
    { username: '20260102', displayName: '李四', className: '数媒1班' },
    { username: 'wang_lei', displayName: '王磊', className: '' },
  ]);
  assert.deepEqual(parseRoster('  \n'), []);
});

test('导航去重：能力目录已并进能力矩阵', () => {
  const ids = NAV_SECTIONS.flatMap((sec) => sec.items.map((i) => i.id));
  assert.ok(!ids.includes('catalog'), '导航里不应再有能力目录');
  assert.ok(ids.includes('capabilities'), '能力矩阵仍在导航里');
  assert.equal(navById('catalog'), undefined, '旧的 catalog 路由不应再被识别为导航项');
});

test('能力矩阵在工作台区：总览之后，产品区只剩对外介绍', () => {
  const site = NAV_SECTIONS.find((s) => s.id === 'site').items.map((i) => i.id);
  const consoleIds = NAV_SECTIONS.find((s) => s.id === 'console').items.map((i) => i.id);
  assert.deepEqual(site, ['home', 'scenarios', 'integration'], '产品区只剩首页、应用场景、接入指南');
  assert.deepEqual(consoleIds, ['overview', 'capabilities', 'create', 'taskcenter', 'tasks', 'settings'], '工作台动线是总览 → 矩阵 → 创作 → 任务 → 作品 → 环境与配置');
  assert.equal(navById('capabilities').section, 'console', '能力矩阵的导航分组应是工作台');
  assert.ok(SITE_VIEWS.includes('capabilities'), '能力矩阵渲染仍是站内页（自带标题，不显示工作台标题栏）');
});
