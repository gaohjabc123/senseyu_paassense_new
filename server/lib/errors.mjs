// errors.mjs —— 把各种失败统一成「发生了什么 / 为什么 / 下一步」三段式，不把原始错误码甩给用户
// action：retry=可以立即重试 · later=稍后再试 · config=需要管理员调整配置 · contact=联系对接人 · fix=修改输入后重试

export class AppError extends Error {
  constructor({ code, message, hint = '', action = 'retry', detail = '' }) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.action = action;
    this.detail = detail; // 仅写日志，不返回给前端
  }
}

export const E = {
  validation: (message, hint = '修改后再提交即可。') => new AppError({ code: 'INVALID_INPUT', message, hint, action: 'fix' }),
  notFound: (message, hint = '') => new AppError({ code: 'NOT_FOUND', message, hint, action: 'fix' }),
  billingGuard: () => new AppError({
    code: 'BILLING_GUARDED',
    message: '这项能力会产生平台费用，当前服务器未开放计费调用。',
    hint: '如需真实生成，请联系管理员在服务端开启 ALLOW_BILLABLE；也可以切回演示环境免费体验。',
    action: 'config',
  }),
  realUnavailable: () => new AppError({
    code: 'REAL_NOT_CONFIGURED',
    message: '真实环境尚未配置，暂时无法切换。',
    hint: '需要管理员在服务端配置如影平台的 APP_ID 与 APP_KEY。现在可以继续使用演示环境。',
    action: 'config',
  }),
  network: (detail) => new AppError({
    code: 'UPSTREAM_UNREACHABLE',
    message: '暂时连不上如影平台。',
    hint: '可能是网络波动或平台维护，请稍后重试；持续失败请联系你的商予科技对接人。',
    action: 'retry', detail,
  }),
  timeout: (detail) => new AppError({
    code: 'UPSTREAM_TIMEOUT',
    message: '如影平台响应超时。',
    hint: '平台可能正在高峰期，请稍等片刻再试。',
    action: 'later', detail,
  }),
  tokenFailed: (detail) => new AppError({
    code: 'AUTH_FAILED',
    message: '平台认证失败，无法完成这次调用。',
    hint: '服务端已自动重新获取过一次凭证仍未成功，可能是 APP_ID / APP_KEY 失效或账号受限，请联系管理员检查。',
    action: 'contact', detail,
  }),
  upstream: (status, platformMsg, detail) => {
    if (status >= 500) {
      return new AppError({
        code: 'UPSTREAM_ERROR',
        message: '如影平台暂时无法处理这次请求。',
        hint: '这是平台侧的临时故障，请稍后重试。',
        action: 'later', detail,
      });
    }
    return new AppError({
      code: 'UPSTREAM_REJECTED',
      message: platformMsg ? `平台未接受这次请求：${platformMsg}` : '平台未接受这次请求。',
      hint: '请检查填写的参数（如素材地址是否可公网访问、时长是否至少 5 秒）后重试；仍失败请联系对接人。',
      action: 'fix', detail,
    });
  },
  internal: (detail) => new AppError({
    code: 'INTERNAL',
    message: '服务暂时出了点问题。',
    hint: '请刷新页面后重试；持续出现请联系对接人。',
    action: 'retry', detail,
  }),
};

/** 把任意异常转成 AppError（网络错误、超时、未知异常） */
export function toAppError(e) {
  if (e instanceof AppError) return e;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return E.timeout(e.message);
  if (e?.name === 'TypeError' && /fetch failed|network/i.test(e.message || '')) return E.network(e.cause?.code || e.message);
  if (e?.cause?.code && /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH/.test(e.cause.code)) return E.network(e.cause.code);
  return E.internal(e?.message || String(e));
}

/** 前端可见的错误体 */
export function errorBody(e) {
  return { code: e.code, message: e.message, hint: e.hint, action: e.action, data: null };
}
