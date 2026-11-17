// guide.js —— 新手引导（仅工作台首次进入）与结果解读
export const TOUR_STEPS = [
  { selector: '.create-tabs', title: '五条快捷链路', text: '视频口播、语音合成、知识库问答、文本驱动视频、视频脚本编辑，点标签切换。' },
  { selector: '[data-action="fill-sample"]', title: '不会写文案？', text: '点「填入示例」自动填一段，再改成你的内容。' },
  { selector: '[data-action="run-video"]', title: '点一下生成', text: '先配音、再合成，进度会实时显示。' },
  { selector: '.sidenav [data-view="create"]', title: '全部 24 项能力', text: '创作中心下方列出了全部 24 项能力，每一项都可以单独体验。' },
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

/** 等待提示：按已等待时长给不同的话（课程 ch5 guide.js WAIT_TIPS 的三档时点；文案按本站口径改写，不用课程的“小禾”） */
export const WAIT_TIPS = [
  { afterMs: 1200, text: '正在思考…' },
  { afterMs: 5000, text: '问题有点复杂，再等几秒～' },
  { afterMs: 12000, text: '网络有点慢，还在努力回答…' },
];

/** 给定已等待毫秒数，返回当前档位的提示（未到第一档返回 ''）；与“已等待 x 秒”并存 */
export function waitTipFor(elapsedMs) {
  let tip = '';
  for (const w of WAIT_TIPS) if (elapsedMs >= w.afterMs) tip = w.text;
  return tip;
}

/** 计时器版等待提示（课程 startTips/stopTips 结构）：到档位时调 onTip；stop() 清掉全部定时器。
 * 调用方收到首字/首包时立即 stop()，提示即消失。 */
export function createWaitTips(onTip, tips = WAIT_TIPS) {
  let timers = [];
  return {
    start() {
      this.stop();
      timers = tips.map((w) => setTimeout(() => onTip(w.text), w.afterMs));
    },
    stop() { timers.forEach(clearTimeout); timers = []; },
  };
}
