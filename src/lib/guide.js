// guide.js —— 新手引导（仅工作台首次进入）与结果解读
export const TOUR_STEPS = [
  { selector: '.create-tabs', title: '三条快捷链路', text: '视频口播、语音合成、知识库问答，点标签切换。' },
  { selector: '[data-action="fill-sample"]', title: '不会写文案？', text: '点「填入示例」自动填一段，再改成你的内容。' },
  { selector: '[data-action="run-video"]', title: '点一下生成', text: '先配音、再合成，进度会实时显示。' },
  { selector: '.sidenav [data-view="catalog"]', title: '全部 15 项能力', text: '能力目录里每一项都可以单独体验。' },
];
const TOUR_KEY = 'ruying_tour_done_v3';
export function nextTourStep(index) { return index + 1 < TOUR_STEPS.length ? index + 1 : -1; }
export function shouldShowTour(storage) { try { return storage.getItem(TOUR_KEY) !== '1'; } catch { return false; } }
export function markTourDone(storage) { try { storage.setItem(TOUR_KEY, '1'); } catch { /* ignore */ } }

export const INTERPRET = {
  avatar: (r) => [
    { label: '看到了什么', text: `一支${r?.duration ? `约 ${Math.round(r.duration * 10) / 10} 秒的` : ''}数字人口播成片，画面带「AI生成」标识` },
    { label: '它说明什么', text: '文案先被合成为配音，再驱动图片数字人的口型，最后编码成视频' },
    { label: '怎样算对', text: '能正常播放；口型与配音同步；时长与文案长度相当' },
    { label: '不对先查什么', text: '① 文案是否通顺 ② 配音是否成功 ③ 任务是否仍在平台排队' },
  ],
  voice: (r) => [
    { label: '看到了什么', text: `可以播放的音频${r?.duration_ms ? `，时长约 ${(r.duration_ms / 1000).toFixed(1)} 秒` : ''}` },
    { label: '它说明什么', text: '文字被逐字合成为语音，时长与字数基本成正比' },
    { label: '怎样算对', text: '能播放；读音正确；时长约等于字数 ÷ 3.8 秒' },
    { label: '不对先查什么', text: '① 文字是否至少 4 个字 ② 是否有生僻字或多音字 ③ 网络是否正常' },
  ],
};
