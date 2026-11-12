// product.js —— 产品元信息与导航（单一数据源）
// 版本号唯一来源是 package.json：构建时由 vite.config.js 注入为 __APP_VERSION__。
/* global __APP_VERSION__, __BRAND_LOGOS__ */
export const VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';

export const PRODUCT = {
  name: '如影 AI 能力开放平台',
  shortName: '如影开放平台',
  vendor: '商予科技',
  version: VERSION,
  tagline: '把数字人能力，变成你的产品能力',
  description: '面向客户与合作方的数字人 PaaS 能力门户：在线体验 6 大类 15 项能力，查看接入路径，演示与真实环境一键切换。',
  docsUrl: 'https://senseavatar.feishu.cn/wiki/space/7652622993675324361',
  consoleUrl: 'https://aigc.softsugar.com/#/company/nav',
};

/**
 * 顶栏与页脚的双 logo（商汤 SenseTime + 商予 SenseYu，并排，不可删减）。
 * 官方 logo 文件放在 public/brand/ 下（sensetime.svg|png、senseyu.svg|png）；
 * 构建时检测到文件就用图片，没有文件时显示文字标识，避免请求不存在的资源。
 */
const FOUND = typeof __BRAND_LOGOS__ === 'object' && __BRAND_LOGOS__ ? __BRAND_LOGOS__ : {};
export const BRAND_LOGOS = [
  { id: 'sensetime', src: FOUND.sensetime || '', alt: '商汤科技 SenseTime', zh: '商汤', en: 'SenseTime' },
  { id: 'senseyu', src: FOUND.senseyu || '', alt: '商予科技 SenseYu', zh: '商予', en: 'SenseYu' },
];

/** 一级导航：官网 + 工作台 */
export const NAV_SECTIONS = [
  {
    id: 'site', label: '产品', items: [
      { id: 'home', label: '首页', icon: '⌂' },
      { id: 'capabilities', label: '能力矩阵', icon: '◈' },
      { id: 'scenarios', label: '应用场景', icon: '◎' },
      { id: 'integration', label: '接入指南', icon: '⇄' },
    ],
  },
  {
    id: 'console', label: '工作台', items: [
      { id: 'overview', label: '总览', icon: '▦' },
      { id: 'create', label: '创作中心', icon: '✦' },
      { id: 'tasks', label: '我的作品', icon: '▤' },
      { id: 'catalog', label: '能力目录', icon: '◈' },
      { id: 'settings', label: '环境与配置', icon: '⚙' },
    ],
  },
];

/** 后台导航：按角色追加 */
export const ORG_NAV = { id: 'org', label: '企业管理', items: [
  { id: 'org', label: '企业概览', icon: '▣' },
  { id: 'org/users', label: '成员管理', icon: '☺' },
  { id: 'org/api', label: 'API 接入', icon: '⌘' },
  { id: 'org/logs', label: '使用日志', icon: '≡' },
] };
export const ADMIN_NAV = { id: 'admin', label: '平台管理', items: [
  { id: 'admin', label: '运营总览', icon: '▣' },
  { id: 'admin/tenants', label: '客户管理', icon: '☷' },
  { id: 'admin/vendors', label: '厂商凭据', icon: '⚿' },
  { id: 'admin/logs', label: '全部日志', icon: '≡' },
] };
export const ACCOUNT_NAV = { id: 'account', label: '我的账号', items: [{ id: 'account', label: '账号与密码', icon: '⚙' }] };

/** 当前角色可见的导航分组 */
export function navFor(role) {
  const out = [...NAV_SECTIONS];
  if (role === 'tenant_admin') out.push(ORG_NAV);
  if (role === 'super_admin') out.push(ADMIN_NAV);
  if (role) out.push(ACCOUNT_NAV);
  return out;
}

export const ALL_NAV = [...NAV_SECTIONS, ORG_NAV, ADMIN_NAV, ACCOUNT_NAV].flatMap((s) => s.items.map((i) => ({ ...i, section: s.id, sectionLabel: s.label })));
export const navById = (id) => ALL_NAV.find((n) => n.id === id);
export const SITE_VIEWS = NAV_SECTIONS[0].items.map((i) => i.id);
export const DEFAULT_VIEW = 'home';
export const ROLE_LABEL = { super_admin: '超级管理员', tenant_admin: '企业管理员', member: '成员' };
/** 创作中心三条快捷链路依赖的能力模块（与服务端 SHORTCUT_MODULE 一致） */
export const SHORTCUT_MODULE = { video: 'video-image', voice: 'voice-tts', chat: 'nlp-chat' };

/** 环境说明（全站统一口径） */
export const MODE_NOTICE = {
  mock: '当前是演示环境：使用本地模拟数据，不调用如影平台、不产生费用；结果仅供体验。',
  real: '当前是真实环境：调用如影平台线上接口，生成类操作可能产生费用。',
};
