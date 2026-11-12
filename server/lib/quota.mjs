// quota.mjs —— 额度：A（如影）→ B（平台）→ C/D（客户）
//
//   采购入账 purchase   B 从 A 采购的量，由超级管理员按采购单手工登记（如影没有可查询的额度接口，这是 B 自己的台账）
//   分配     allocate   从厂商池的「未分配」划给某个客户，不能超过未分配余额
//   回收     reclaim    把客户未用完的额度退回厂商池
//   消耗     consume    真实环境调用时预扣；调用失败或平台任务失败时 refund 退回
// 演示环境与开放接口沙箱不扣额度。所有变动写入 quota_ledger 流水。
import { tx } from './db.mjs';
import { AppError } from './errors.mjs';
import { capById } from '../../src/lib/capabilities.js';

export const METERS = {
  video_seconds: { label: '视频时长', unit: '秒' },
  tts_chars: { label: '语音合成字数', unit: '字' },
  api_calls: { label: '其他能力调用', unit: '次' },
};
export const METER_IDS = Object.keys(METERS);
const VIDEO_CAPS = new Set(['video-image', 'video-tts']);
const words = (t) => [...String(t || '').replace(/\s/g, '')].length;
export const normalizeSeconds = (sec) => Math.max(5, Math.ceil(Number(sec) || 0));

/** 一次真实调用的计量：返回 { meter, amount }；不计量的返回 null */
export function costOf(kind, { capId, params = {}, text, duration } = {}) {
  if (kind === 'tts') return { meter: 'tts_chars', amount: Math.max(1, words(text)) };
  if (kind === 'avatar') return { meter: 'video_seconds', amount: normalizeSeconds(duration) };
  if (kind === 'chat') return { meter: 'api_calls', amount: 1 };
  if (kind === 'capability') {
    const cap = capById(capId);
    if (!cap) return null;
    if (capId === 'voice-tts') return { meter: 'tts_chars', amount: Math.max(1, words(params.text)) };
    if (capId === 'video-image') return { meter: 'video_seconds', amount: normalizeSeconds(params.duration) };
    if (capId === 'video-tts') return { meter: 'video_seconds', amount: normalizeSeconds(words(params.text) / 3.8) };
    if (VIDEO_CAPS.has(capId)) return { meter: 'video_seconds', amount: 5 };
    return cap.realApi ? { meter: 'api_calls', amount: 1 } : null;
  }
  return null;
}

const fail = (code, message, hint = '', action = 'fix') => new AppError({ code, message, hint, action });
const posInt = (n, what) => {
  const v = Number(n);
  if (!Number.isInteger(v) || v <= 0 || v > 1e12) throw fail('INVALID_INPUT', `${what}需为正整数`);
  return v;
};
const checkMeter = (m) => { if (!METERS[m]) throw fail('INVALID_INPUT', '未知的计量项'); return m; };

export function createQuota({ db, now = () => Date.now() }) {
  const q = (sql) => db.prepare(sql);
  const ledger = (e) => q('INSERT INTO quota_ledger (at, kind, meter, amount, vendor_id, tenant_id, ref, actor, note) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(now(), e.kind, e.meter, e.amount, e.vendorId ?? null, e.tenantId ?? null, e.ref ?? null, e.actor ?? null, e.note ? String(e.note).slice(0, 200) : null);
  const ensureVendor = (v, m) => q('INSERT OR IGNORE INTO quota_vendor (vendor_id, meter) VALUES (?, ?)').run(v, m);
  const ensureTenant = (t, m) => q('INSERT OR IGNORE INTO quota_tenant (tenant_id, meter) VALUES (?, ?)').run(t, m);

  function vendorPool(vendorId) {
    const rows = q('SELECT * FROM quota_vendor WHERE vendor_id = ?').all(vendorId);
    const used = q(`SELECT qt.meter, SUM(qt.used) AS used FROM quota_tenant qt JOIN tenants t ON t.id = qt.tenant_id WHERE t.vendor_id = ? GROUP BY qt.meter`).all(vendorId);
    return Object.fromEntries(METER_IDS.map((m) => {
      const r = rows.find((x) => x.meter === m) || { purchased: 0, allocated: 0 };
      return [m, { purchased: r.purchased, allocated: r.allocated, unallocated: r.purchased - r.allocated, consumed: used.find((u) => u.meter === m)?.used || 0 }];
    }));
  }

  function tenantQuota(tenantId) {
    const rows = q('SELECT * FROM quota_tenant WHERE tenant_id = ?').all(tenantId);
    return Object.fromEntries(METER_IDS.map((m) => {
      const r = rows.find((x) => x.meter === m) || { allocated: 0, used: 0 };
      return [m, { allocated: r.allocated, used: r.used, remaining: r.allocated - r.used }];
    }));
  }

  /** 客户剩余额度低于 10% 的计量项（已分配的才算） */
  function lowItems(tenantId) {
    return Object.entries(tenantQuota(tenantId)).filter(([, v]) => v.allocated > 0 && v.remaining < v.allocated * 0.1).map(([m]) => m);
  }

  function purchase(actor, vendorId, meter, amount, note) {
    checkMeter(meter);
    const n = Number(amount);
    if (!Number.isInteger(n) || n === 0) throw fail('INVALID_INPUT', '入账数量需为非零整数（负数表示冲减）');
    return tx(db, () => {
      ensureVendor(vendorId, meter);
      const r = q('SELECT * FROM quota_vendor WHERE vendor_id = ? AND meter = ?').get(vendorId, meter);
      if (r.purchased + n < r.allocated) throw fail('INVALID_INPUT', `冲减后采购总量会小于已分配量（已分配 ${r.allocated}）`, '先从客户回收额度。');
      q('UPDATE quota_vendor SET purchased = purchased + ? WHERE vendor_id = ? AND meter = ?').run(n, vendorId, meter);
      ledger({ kind: 'purchase', meter, amount: n, vendorId, actor: actor.username, note });
      return vendorPool(vendorId);
    });
  }

  function allocate(actor, tenant, meter, amount, note) {
    checkMeter(meter); const n = posInt(amount, '分配数量');
    if (!tenant.vendor_id) throw fail('NO_VENDOR', '这个客户还没有分配厂商凭据。', '额度从厂商凭据的额度池里划拨，请先在客户设置里分配凭据。');
    return tx(db, () => {
      ensureVendor(tenant.vendor_id, meter); ensureTenant(tenant.id, meter);
      const ok = q('UPDATE quota_vendor SET allocated = allocated + ? WHERE vendor_id = ? AND meter = ? AND purchased - allocated >= ?').run(n, tenant.vendor_id, meter, n).changes;
      if (!ok) {
        const r = q('SELECT purchased - allocated AS free FROM quota_vendor WHERE vendor_id = ? AND meter = ?').get(tenant.vendor_id, meter);
        throw fail('POOL_INSUFFICIENT', `厂商额度池的未分配${METERS[meter].label}不足（剩 ${r.free} ${METERS[meter].unit}）。`, '先在「厂商凭据」里登记新的采购，或从其他客户回收额度。');
      }
      q('UPDATE quota_tenant SET allocated = allocated + ? WHERE tenant_id = ? AND meter = ?').run(n, tenant.id, meter);
      ledger({ kind: 'allocate', meter, amount: n, vendorId: tenant.vendor_id, tenantId: tenant.id, actor: actor.username, note });
      return tenantQuota(tenant.id);
    });
  }

  function reclaim(actor, tenant, meter, amount, note) {
    checkMeter(meter); const n = posInt(amount, '回收数量');
    return tx(db, () => {
      ensureTenant(tenant.id, meter);
      const ok = q('UPDATE quota_tenant SET allocated = allocated - ? WHERE tenant_id = ? AND meter = ? AND allocated - used >= ?').run(n, tenant.id, meter, n).changes;
      if (!ok) throw fail('INVALID_INPUT', '回收数量超过了客户的剩余额度。');
      if (tenant.vendor_id) q('UPDATE quota_vendor SET allocated = allocated - ? WHERE vendor_id = ? AND meter = ?').run(n, tenant.vendor_id, meter);
      ledger({ kind: 'reclaim', meter, amount: -n, vendorId: tenant.vendor_id, tenantId: tenant.id, actor: actor.username, note });
      return tenantQuota(tenant.id);
    });
  }

  /** 客户删除前：未用完的额度退回厂商池 */
  function releaseTenant(actor, tenant) {
    tx(db, () => {
      for (const [m, v] of Object.entries(tenantQuota(tenant.id))) {
        if (v.remaining > 0 && tenant.vendor_id) {
          q('UPDATE quota_vendor SET allocated = allocated - ? WHERE vendor_id = ? AND meter = ?').run(v.remaining, tenant.vendor_id, m);
          ledger({ kind: 'reclaim', meter: m, amount: -v.remaining, vendorId: tenant.vendor_id, tenantId: tenant.id, actor: actor.username, note: '删除客户，自动回收' });
        }
      }
    });
  }

  const hasRemaining = (tenantId) => Object.values(tenantQuota(tenantId)).some((v) => v.remaining > 0);

  /** 预扣：余额不足抛出 QUOTA_EXHAUSTED */
  function consume(tenant, cost, ref, actorName) {
    if (!cost) return null;
    const ok = q('UPDATE quota_tenant SET used = used + ? WHERE tenant_id = ? AND meter = ? AND allocated - used >= ?').run(cost.amount, tenant.id, cost.meter, cost.amount).changes;
    if (!ok) {
      const left = tenantQuota(tenant.id)[cost.meter].remaining;
      throw fail('QUOTA_EXHAUSTED', `${METERS[cost.meter].label}额度不足：本次需要 ${cost.amount} ${METERS[cost.meter].unit}，剩余 ${left} ${METERS[cost.meter].unit}。`,
        '请联系你的企业管理员或商予科技追加额度；演示环境不消耗额度，可以继续体验。', 'contact');
    }
    ledger({ kind: 'consume', meter: cost.meter, amount: -cost.amount, vendorId: tenant.vendor_id, tenantId: tenant.id, ref, actor: actorName });
    return { ...cost, tenantId: tenant.id, vendorId: tenant.vendor_id, ref };
  }

  /** 退回预扣（调用失败 / 任务失败） */
  function refund(charge, reason) {
    if (!charge) return;
    q('UPDATE quota_tenant SET used = MAX(0, used - ?) WHERE tenant_id = ? AND meter = ?').run(charge.amount, charge.tenantId, charge.meter);
    ledger({ kind: 'refund', meter: charge.meter, amount: charge.amount, vendorId: charge.vendorId, tenantId: charge.tenantId, ref: charge.ref, note: reason });
  }

  function ledgerOf({ tenantId, vendorId, limit = 50 }) {
    const [col, val] = tenantId ? ['tenant_id', tenantId] : ['vendor_id', vendorId];
    return q(`SELECT l.*, t.name AS tenant_name FROM quota_ledger l LEFT JOIN tenants t ON t.id = l.tenant_id WHERE l.${col} = ? ORDER BY l.id DESC LIMIT ?`).all(val, Math.min(limit, 500));
  }

  return { vendorPool, tenantQuota, lowItems, purchase, allocate, reclaim, releaseTenant, hasRemaining, consume, refund, ledgerOf };
}
