// consent.js —— 录音前告知并取得同意（麦克风接管用；课程 ch5 consent.js 的 createConsent 结构）
// 规则：第一次点“开启麦克风接管”前弹出说明，用户同意后才打开麦克风；不同意就不录音，可改用文字互动。
// 同意只记在本次浏览器会话（sessionStorage），关掉页面再打开会重新询问；随时可以撤回。
// 与界面无关：浏览器传 showConsentDialog（页面内对话框，返回 Promise）和 sessionStorage，
// 测试传假的 confirm 和内存存储。不用 window.confirm：Chromium 原生框只显示前几行，说明较长时最后一行要滚动。
import { esc } from './html.js';

export const CONSENT_KEY = 'ruying-mic-consent';
export const CONSENT_TEXT = [
  '麦克风接管说明（请先阅读）',
  '· 点“确定”后，页面会打开麦克风，把你的声音实时发送到如影直播间，由数字人替你说话。',
  '· 页面和平台都不保存这段录音；关掉麦克风接管就停止发送。',
  '· 请不要说出姓名、电话、证件号等个人信息。',
  '· 不同意请点“取消”，仍可以用文字互动。',
].join('\n');

/**
 * @param {object} o storage：sessionStorage 或内存存储；confirm(text) → boolean | Promise<boolean>
 * @returns {{ ensure(): Promise<boolean>, granted(): boolean, revoke(): void }}
 */
export function createConsent({ storage = null, confirm = () => false, text = CONSENT_TEXT } = {}) {
  const granted = () => storage?.getItem(CONSENT_KEY) === 'yes';
  return {
    granted,
    /** 录音前调用：已同意直接返回 true；否则弹出说明，同意才记下并返回 true */
    async ensure() {
      if (granted()) return true;
      const yes = !!(await confirm(text));
      if (yes) storage?.setItem(CONSENT_KEY, 'yes');
      return yes;
    },
    revoke() { storage?.removeItem(CONSENT_KEY); },
  };
}

/** 录音说明对话框（平台 state.dialog 覆盖层样式；第一行作标题，其余每行一段；
 * 点“确定”→ true，点“取消”/点遮罩/按 Esc → false；默认焦点在“取消”上） */
export function consentDialogHtml(title, lines) {
  return `<div class="sheet-mask" data-action="consent-no"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="consent-title">
    <h3 id="consent-title">${esc(title)}</h3>
    ${lines.map((l) => `<p>${esc(l)}</p>`).join('')}
    <div class="actions"><button class="btn" type="button" data-action="consent-no" data-autofocus>取消</button><button class="btn btn--primary" type="button" data-action="consent-yes">确定</button></div></div>`;
}
