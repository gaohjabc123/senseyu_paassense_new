// tts.js —— TTS 前的文本清洗（课程 ch5 tts.js speakable 原文）
// 大模型回答常带 **、#、- 列表与表情，直接朗读会念出符号；先去掉再合成。
// SSML 文本（含 <speak> 标签）不要清洗，两者互斥使用（见 server/index.mjs opTts）。

/** 去掉 Markdown 符号、表情等不适合朗读的字符 */
export function speakable(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*#>`_~]/g, '')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
