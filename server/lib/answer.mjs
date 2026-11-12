// answer.mjs —— 知识库问答：检索 → （真实环境且配置了 DeepSeek）大模型流式作答 / 否则资料原文摘录
// 原则：库里没有就诚实说没有，不让大模型脱离资料自由发挥。
import { extractiveAnswer } from './kb.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const MESSAGES = {
  emptyKb: '知识库还是空的。先上传一份 .txt 或 .md 资料，我会只根据资料内容回答。',
  noHit: '知识库里没有找到和这个问题相关的内容。可以换个说法、用资料里出现过的关键词再问一次，或上传包含答案的资料。',
  tooGeneric: '这个问题太笼统了，资料里没法定位。请带上具体的关键词再问，比如「视频合成怎么计费」。',
};

const SYSTEM_PROMPT = '你是如影 AI 能力开放平台的知识库问答助手。只能依据用户提供的「资料片段」回答，用简体中文，简洁准确。'
  + '如果资料片段不足以回答，就直接说「资料里没有提到」，不要编造。回答末尾不需要列出出处。';

/** 逐段推送一段已知文本（摘录式回答使用） */
async function streamText(text, onDelta, delayMs) {
  for (const piece of text.match(/[\s\S]{1,8}/g) || []) { onDelta(piece); if (delayMs) await sleep(delayMs); }
}

/** 调 DeepSeek（OpenAI 兼容）流式接口 */
export async function streamDeepSeek(cfg, question, hits, onDelta, { fetchImpl = (...a) => fetch(...a), signal } = {}) {
  const context = hits.map((h, i) => `【片段${i + 1}｜${h.docName}｜${h.heading}】\n${h.text}`).join('\n\n');
  const resp = await fetchImpl(`${cfg.deepseekBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.deepseekKey}` },
    body: JSON.stringify({
      model: cfg.deepseekModel, stream: true, temperature: 0.2,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: `资料片段：\n${context}\n\n问题：${question}` }],
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
  });
  if (!resp.ok || !resp.body) throw Object.assign(new Error(`DeepSeek HTTP ${resp.status}`), { upstreamStatus: resp.status });
  const dec = new TextDecoder();
  let buf = '', answer = '';
  for await (const chunk of resp.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') return answer;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) { answer += delta; onDelta(delta); }
      } catch { /* 跳过不完整行 */ }
    }
  }
  return answer;
}

/**
 * emit(event, data)：meta / message / done / error
 * 返回最终答案文本
 */
export async function answerQuestion({ kb, ws, question, mode, cfg, emit, signal, deps = {} }) {
  const docs = kb.list(ws);
  const delay = cfg.mockSseDelayMs ?? 15;
  if (!docs.length) {
    emit('meta', { hit: false, reason: 'empty-kb', sources: [], engine: 'none' });
    await streamText(MESSAGES.emptyKb, (d) => emit('message', { delta: d }), delay);
    return MESSAGES.emptyKb;
  }
  const { hits, reason } = kb.search(ws, question, { topK: 3 });
  if (!hits.length) {
    const msg = reason === 'query-too-generic' ? MESSAGES.tooGeneric : MESSAGES.noHit;
    emit('meta', { hit: false, reason, sources: [], engine: 'none' });
    await streamText(msg, (d) => emit('message', { delta: d }), delay);
    return msg;
  }
  const sources = hits.map((h) => ({ docName: h.docName, heading: h.heading, score: h.score }));
  const useLlm = mode === 'real' && !!cfg.deepseekKey;
  if (useLlm) {
    emit('meta', { hit: true, sources, engine: 'deepseek' });
    let started = false;
    try {
      return await streamDeepSeek(cfg, question, hits, (d) => { started = true; emit('message', { delta: d }); }, { fetchImpl: deps.fetchImpl, signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (started) {
        emit('error', { message: '回答中途中断了。', hint: '大模型服务连接不稳定，已显示的内容保留，可以重新提问。', action: 'retry' });
        return '';
      }
      // 大模型不可用：退回资料原文摘录，并明确告知
      emit('meta', { hit: true, sources, engine: 'extract', notice: '大模型服务暂时不可用，以下为资料原文摘录。' });
    }
  } else {
    emit('meta', { hit: true, sources, engine: 'extract', notice: mode === 'real' ? '未配置大模型（DEEPSEEK_API_KEY），以下为资料原文摘录。' : '演示环境不调用大模型，以下为资料原文摘录。' });
  }
  const text = extractiveAnswer(question, hits);
  await streamText(text, (d) => emit('message', { delta: d }), delay);
  return text;
}
