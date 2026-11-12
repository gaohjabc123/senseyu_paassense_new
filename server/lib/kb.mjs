// kb.mjs —— 工作台知识库：切块 + BM25 检索（标题/首段加权）+ 按访客隔离的持久化
// 无第三方依赖。中文按字二元组（bigram）切词，英文/数字按词。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const LIMITS = {
  maxFileChars: 500_000,      // 单文件约 1MB 以内的纯文本
  maxDocs: 30,                // 每个工作区最多文档数
  maxTotalChars: 2_000_000,   // 每个工作区总字数
  allowedExt: ['.txt', '.md', '.markdown'],
};
const TARGET_CHUNK = 320;
const MAX_CHUNK = 520;

/* ---------------- 切词 ---------------- */
const ZH_STOP = new Set(('什么 怎么 怎样 如何 是否 可以 能否 能不 不能 一个 这个 那个 这些 那些 我们 你们 他们 它们 是不 不是 没有 有没 '
  + '哪些 哪个 多少 为什 么是 请问 一下 吗？ 的是 是什 了吗 还是 或者 以及 然后 就是 因为 所以 但是 如果 已经 关于 对于 '
  + '的话 有什 么样 介绍 告诉 知道 需要 应该').split(/\s+/));
const EN_STOP = new Set('the a an is are was were be to of and or in on for with what how why when which who does do can could should would please about this that these those it its'.split(' '));
// 虚词/疑问词作为分隔符：避免「生成视频要多久」切出「频要」「要多」这类跨词噪声
const ZH_STOP_CHARS = new Set('的了吗呢吧啊呀么是在有和与及或也都就还又把被让给对从向这那个些能做会怎要该请问什哪谁您你我他她它们吗嘛呗'.split(''));

export function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  for (const m of s.matchAll(/[a-z0-9][a-z0-9._+-]*/g)) {
    const w = m[0].replace(/[._-]+$/, '');
    if (w.length > 1 && !EN_STOP.has(w)) out.push(w);
  }
  for (const m of s.matchAll(/[\u3400-\u9fff]+/g)) {
    for (const run of [...m[0]].reduce((acc, ch) => {
      if (ZH_STOP_CHARS.has(ch)) acc.push(''); else acc[acc.length - 1] += ch;
      return acc;
    }, [''])) {
      if (!run) continue;
      if (run.length === 1) { out.push(run); continue; }
      for (let i = 0; i < run.length - 1; i++) {
        const bg = run.slice(i, i + 2);
        if (!ZH_STOP.has(bg)) out.push(bg);
      }
    }
  }
  return out;
}

/* ---------------- 切块 ---------------- */
const HEADING_RE = /^(#{1,6}\s+.+|[一二三四五六七八九十百]+[、.．].{1,40}|第[一二三四五六七八九十百\d]+[章节部分篇条].{0,40}|\d+(\.\d+)*[、.．]\s*\S.{0,38}|【.{1,30}】)$/;

function isHeading(line) {
  const t = line.trim();
  if (t.length > 46) return false;
  if (/[。！？；;!?]$/.test(t) && !t.startsWith('#')) return false;
  return HEADING_RE.test(t);
}
const cleanHeading = (t) => t.trim().replace(/^#{1,6}\s+/, '').replace(/^【|】$/g, '');

function splitSentences(p) {
  return p.match(/[^。！？!?；;\n]+[。！？!?；;]*/g)?.map((x) => x.trim()).filter(Boolean) || [p];
}

/** 把一篇文档切成带标题的块：按标题分节 → 段落合并到 ~320 字 → 超长段按句子切开并保留一句重叠 */
export function chunkText(content, title) {
  const lines = String(content).replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let cur = { heading: title, paras: [] };
  let buf = [];
  const flushPara = () => { const p = buf.join('').trim(); if (p) cur.paras.push(p); buf = []; };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); continue; }
    if (isHeading(line)) {
      flushPara();
      if (cur.paras.length) sections.push(cur);
      cur = { heading: cleanHeading(line), paras: [] };
      continue;
    }
    // 中文文本常见「一行一段」：以句末标点结尾的行视为段落结束
    buf.push(line);
    if (/[。！？!?]$/.test(line)) flushPara();
  }
  flushPara();
  if (cur.paras.length) sections.push(cur);

  const chunks = [];
  for (const sec of sections) {
    let acc = '';
    const push = (t) => { const x = t.trim(); if (x) chunks.push({ heading: sec.heading, text: x }); };
    for (const p of sec.paras) {
      if (p.length > MAX_CHUNK) {
        push(acc); acc = '';
        const sents = splitSentences(p);
        let piece = '';
        for (let i = 0; i < sents.length; i++) {
          if (piece && (piece + sents[i]).length > TARGET_CHUNK) {
            push(piece);
            piece = sents[i - 1] && sents[i - 1].length < 120 ? sents[i - 1] : ''; // 一句重叠，避免答案被切断
          }
          piece += sents[i];
        }
        push(piece);
        continue;
      }
      if (acc && (acc + '\n' + p).length > TARGET_CHUNK) { push(acc); acc = p; } else acc = acc ? acc + '\n' + p : p;
    }
    push(acc);
  }
  return chunks.map((c, i) => ({ ...c, order: i }));
}

/* ---------------- 检索 ---------------- */
/**
 * BM25 + 标题加权 + 首段加权；并要求问题里的关键词有足够覆盖率，否则判为「库里没有」。
 * docs: [{ id, name, title, chunks:[{heading,text,order}] }]
 */
export function search(docs, query, { topK = 3 } = {}) {
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length) return { hits: [], reason: 'query-too-generic' };
  const units = [];
  for (const d of docs) for (const c of d.chunks) {
    const tokens = tokenize(c.text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    units.push({ doc: d, chunk: c, len: tokens.length || 1, tf, head: new Set(tokenize(`${d.title} ${c.heading}`)) });
  }
  if (!units.length) return { hits: [], reason: 'empty-kb' };

  const N = units.length;
  const avgLen = units.reduce((s, u) => s + u.len, 0) / N;
  const df = new Map(qTerms.map((t) => [t, units.filter((u) => u.tf.has(t) || u.head.has(t)).length]));
  const idf = (t) => Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
  const k1 = 1.2, b = 0.75;
  // 命中门槛：问题里的关键词至少覆盖 30%，且在库中出现过的关键词至少命中一半（最少 1 个）
  const known = qTerms.filter((t) => df.get(t) > 0).length;
  if (!known) return { hits: [], reason: 'no-match', terms: qTerms };
  const required = Math.max(1, Math.ceil(known * 0.5), Math.ceil(qTerms.length * 0.3));

  const scored = [];
  for (const u of units) {
    let score = 0, matched = 0;
    for (const t of qTerms) {
      const f = u.tf.get(t) || 0;
      const inHead = u.head.has(t);
      if (!f && !inHead) continue;
      matched += 1;
      if (f) score += idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * u.len / avgLen));
      if (inHead) score += idf(t) * 0.8; // 标题命中加权
    }
    if (matched < required) continue;
    if (u.chunk.order === 0) score *= 1.15; // 首段加权
    score *= 0.6 + 0.4 * (matched / qTerms.length); // 覆盖越全越靠前
    scored.push({ docId: u.doc.id, docName: u.doc.name, heading: u.chunk.heading, text: u.chunk.text, score: Math.round(score * 1000) / 1000, matched, order: u.chunk.order });
  }
  scored.sort((a, b2) => b2.score - a.score);
  return { hits: scored.slice(0, topK), reason: scored.length ? 'ok' : 'no-match', terms: qTerms };
}

/** 摘录式回答（不调用大模型）：从命中块里挑出包含关键词最多的句子 */
export function extractiveAnswer(query, hits, maxChars = 220) {
  const terms = new Set(tokenize(query));
  const picks = [];
  for (const h of hits) {
    for (const s of splitSentences(h.text)) {
      const n = tokenize(s).filter((t) => terms.has(t)).length;
      if (n) picks.push({ s, n, h });
    }
  }
  picks.sort((a, b) => b.n - a.n);
  let out = '';
  const used = new Set();
  for (const p of picks) {
    if (used.has(p.s) || out.length + p.s.length > maxChars) continue;
    used.add(p.s); out += p.s;
  }
  return out || hits[0]?.text.slice(0, maxChars) || '';
}

/* ---------------- 存储：按工作区隔离 ---------------- */
export class KbStore {
  constructor(dir, { log = () => {} } = {}) {
    this.dir = dir;
    this.log = log;
    this.mem = new Map(); // wsId -> { docs, touchedAt }
    this.persist = true;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { this.persist = false; log(`[kb] 目录不可写，知识库仅保存在内存：${e.code}`); }
  }

  static validWorkspace(id) { return typeof id === 'string' && /^[a-z0-9-]{8,64}$/i.test(id); }
  file(ws) { return path.join(this.dir, `kb-${ws}.json`); }

  load(ws) {
    if (this.mem.has(ws)) return this.mem.get(ws);
    let data = { docs: [], touchedAt: Date.now() };
    if (this.persist) {
      try { data = JSON.parse(fs.readFileSync(this.file(ws), 'utf8')); } catch { /* 新工作区 */ }
    }
    this.mem.set(ws, data);
    return data;
  }

  save(ws) {
    const data = this.mem.get(ws);
    data.touchedAt = Date.now();
    if (!this.persist) return;
    const f = this.file(ws);
    try {
      fs.writeFileSync(f + '.tmp', JSON.stringify(data));
      fs.renameSync(f + '.tmp', f);
    } catch (e) { this.log(`[kb] 写入失败（仅保留内存）：${e.code}`); }
  }

  list(ws) {
    return this.load(ws).docs.map(({ id, name, chars, chunks, uploadedAt }) => ({ id, name, chars, chunkCount: chunks.length, uploadedAt }));
  }

  /** 返回 { doc } 或抛出 { kbCode, message } */
  add(ws, { name, content }) {
    const fail = (kbCode, message, extra = {}) => { throw Object.assign(new Error(message), { kbCode, ...extra }); };
    const fileName = String(name || '').trim().slice(0, 120);
    const ext = path.extname(fileName).toLowerCase();
    if (!fileName) fail('NO_NAME', '缺少文件名');
    if (!LIMITS.allowedExt.includes(ext)) fail('BAD_TYPE', `暂只支持 ${LIMITS.allowedExt.join(' / ')} 纯文本文件`);
    const text = String(content ?? '');
    if (text.includes('\uFFFD')) fail('BAD_ENCODING', '文件编码无法识别，请另存为 UTF-8 编码后再上传');
    if (!text.trim()) fail('EMPTY', '文件是空的，没有可以检索的内容');
    if (text.length > LIMITS.maxFileChars) fail('TOO_LARGE', `单个文件最多 ${LIMITS.maxFileChars / 10000} 万字，请拆分后上传`);

    const kb = this.load(ws);
    const hash = crypto.createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex');
    const dup = kb.docs.find((d) => d.hash === hash);
    if (dup) fail('DUPLICATE', `这份内容已经上传过（《${dup.name}》），无需重复上传`, { existing: dup.id });
    const same = kb.docs.find((d) => d.name === fileName);
    if (same) fail('SAME_NAME', `已有同名文件《${fileName}》，内容不同。如需更新，请先删除旧文件再上传`, { existing: same.id });
    if (kb.docs.length >= LIMITS.maxDocs) fail('TOO_MANY', `知识库最多 ${LIMITS.maxDocs} 个文件，请先删除不用的文件`);
    const total = kb.docs.reduce((s, d) => s + d.chars, 0);
    if (total + text.length > LIMITS.maxTotalChars) fail('QUOTA', '知识库总字数已达上限，请先删除不用的文件');

    const title = fileName.replace(/\.[^.]+$/, '');
    const chunks = chunkText(text, title);
    if (!chunks.length) fail('EMPTY', '没有从文件中解析出可检索的段落');
    const doc = { id: `doc_${crypto.randomBytes(6).toString('hex')}`, name: fileName, title, hash, chars: text.length, chunks, uploadedAt: new Date().toISOString() };
    kb.docs.push(doc);
    this.save(ws);
    return { id: doc.id, name: doc.name, chars: doc.chars, chunkCount: chunks.length, uploadedAt: doc.uploadedAt };
  }

  remove(ws, id) {
    const kb = this.load(ws);
    const before = kb.docs.length;
    kb.docs = kb.docs.filter((d) => d.id !== id);
    if (kb.docs.length === before) return false;
    this.save(ws);
    return true;
  }

  search(ws, query, opts) { return search(this.load(ws).docs, query, opts); }

  /** 清理长期未使用的工作区文件（默认 30 天） */
  prune(maxAgeMs = 30 * 86400000) {
    if (!this.persist) return 0;
    let n = 0;
    for (const f of fs.readdirSync(this.dir)) {
      if (!/^kb-.+\.json$/.test(f)) continue;
      const p = path.join(this.dir, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) { fs.unlinkSync(p); n += 1; } } catch { /* ignore */ }
    }
    return n;
  }
}
