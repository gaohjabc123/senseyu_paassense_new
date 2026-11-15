// navstack.js —— 页面返回栈（纯函数）：记录用户在站内走过的页面，
// 让「返回」按钮回到上一个页面，而不是固定的父页面。
// 栈里存 hash 目标串（'capabilities'、'experience/voice-tts'、'admin/tenants/12'…）。
// 站内跳转（go）与浏览器前进/后退（hashchange）共用同一套栈，保持一致。
import { navById, DEFAULT_VIEW } from './product.js';
import { capById } from './capabilities.js';

export const MAX_NAV_STACK = 50;

/** 路由对象 → 栈用的 key（'experience/<id>' 或视图 id） */
export function routeKey(route) {
  if (!route) return DEFAULT_VIEW;
  if (route.view === 'experience' && route.capId) return `experience/${route.capId}`;
  return route.view || DEFAULT_VIEW;
}

/** 把上一个页面压栈：空、与目标相同、与栈顶相同都不压；超长截掉最旧的 */
export function pushNav(stack, prevKey, nextKey, max = MAX_NAV_STACK) {
  if (!prevKey || prevKey === nextKey) return stack;
  if (stack.length && stack[stack.length - 1] === prevKey) return stack;
  const next = [...stack, prevKey];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 弹栈顶；空栈返回 [null, stack] */
export function popNav(stack) {
  if (!stack.length) return [null, stack];
  return [stack[stack.length - 1], stack.slice(0, -1)];
}

/** 没有历史可回时的兜底：体验页回能力矩阵，深层后台回父列表，其余回首页 */
export function fallbackFor(key) {
  if (!key) return DEFAULT_VIEW;
  if (key.startsWith('experience/')) return 'capabilities';
  const i = key.lastIndexOf('/');
  if (i > 0) {
    const parent = key.slice(0, i);
    if (navById(parent)) return parent;
  }
  return DEFAULT_VIEW;
}

/** 决定「返回」去哪：有栈弹栈顶，没栈走兜底；返回 { target, stack } */
export function resolveBack(stack, currentKey) {
  const [top, rest] = popNav(stack || []);
  if (top && top !== currentKey) return { target: top, stack: rest };
  return { target: fallbackFor(currentKey), stack: rest };
}

/** 返回按钮的文案：优先叫出目标页的名字 */
export function backLabelFor(key) {
  if (!key) return '返回上页';
  if (key.startsWith('experience/')) {
    const cap = capById(key.slice(11));
    return cap ? `返回${cap.name}` : '返回能力矩阵';
  }
  const nav = navById(key);
  if (nav) return `返回${nav.label}`;
  return '返回上页';
}
