// errors.mjs —— 把各种失败统一成「发生了什么 / 为什么 / 下一步」三段式，不把原始错误码甩给用户
// action：retry=可以立即重试 · later=稍后再试 · config=需要管理员调整配置 · contact=联系对接人 · fix=修改输入后重试
//
// PLATFORM_HINTS：平台业务码 → 中文排查提示（以飞书文档《用户接入及通用数据结构》错误码表与
// 2026-11-11 复测口径为准；课程自建码不收：回调类 401901–401904 / 500901 与代理类 403002
// 是课程项目自用的码，平台没有这些接口，不编进表里）。

export class AppError extends Error {
  constructor({ code, message, hint = '', action = 'retry', detail = '', codeHint = '' }) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.action = action;
    this.detail = detail; // 仅写日志，不返回给前端
    this.codeHint = codeHint; // 平台业务码对应的中文排查提示（errorBody 会原样返回前端）
  }
}

/** 平台业务码 → 中文排查提示（节选自官方错误码表；未见过的码不编） */
export const PLATFORM_HINTS = {
  3333: '请求参数为空或格式错误：检查参数和 Content-Type 是否为 application/json',
  60102126: '账户不存在：检查 APP_ID 是否抄错',
  60102156: '账户不在有效期内：联系平台运营续期',
  60102158: 'appId 和 appKey 不匹配：检查 .env 中两项是否来自同一账号',
  60112160: '第三方系统验签失败：检查签名拼接顺序 appId+timestamp+appKey 与时间戳单位',
  60112161: 'refresh token 过于频繁：两次刷新间隔不得低于 3 小时',
  60112162: 'grantType 不合法：换取令牌固定填 sign，刷新固定填 refreshToken',
  60112505: '访问授权过期：重新获取 token',
  50107603: '不合法的签名（官方错误码表中另一个签名相关码）：本平台换令牌接口实测签名错返回 60112160，未出现此码（2026-11-11 复测）',
  84115943: 'token 不合法（官方错误码表中的码）：业务接口实测不带或带错 token 为 HTTP 401 空体；若出现此码，确认请求头为 Authorization: Bearer {token} 并重新换取',
  84115927: '请求参数不合法：对照接口文档检查必填字段',
  84115929: '任务/会话不存在：检查任务 id',
  84115949: '只有等待中或进行中的任务可以取消',
  84115966: '只有已取消或异常的任务才允许重新生成',
  80115983: '任务并发已达上限：稍后再试或减少同时提交的任务',
  89999999: '访问过于频繁：降低请求频率（客户端会自动退避重试）',
  99999997: '网关错误：稍后重试',
  82116818: '任务 id 不能为空：task/info 的 ids 必须是非空数组（2026-11-11 复测）',
  99999999: '系统内部错误：HTTP 403 时表示请求方法不对；若换令牌或 task/info 出现，先检查请求头 Accept-Language——Node 自带 fetch 默认发“*”，平台会把 60112160 等错误变成 99999999（2026-11-11 复测），显式写 zh-CN 即可看到真实错误码',
  415: 'Content-Type 不对：JSON 接口必须是 application/json',
};

/** 按平台业务码 + HTTP 状态取中文排查提示；查不到返回 ''（调用方用通用提示兜底） */
export function hintOf(code, httpStatus) {
  if (httpStatus === 403 && code === 99999999) return 'HTTP 403：请求方法不对（如该用 POST 却用了 GET）';
  if (httpStatus === 401) return 'HTTP 401：未带 token 或 token 已失效（业务接口响应体为空）';
  if (code === 'TIMEOUT') return '请求超时：检查网络或调大 timeout';
  if (code === 'NETWORK') return '网络错误：检查网络是否正常';
  return PLATFORM_HINTS[code] || '';
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
  upstream: (status, platformMsg, detail, platformCode) => {
    const codeHint = hintOf(platformCode, status);
    if (status >= 500) {
      return new AppError({
        code: 'UPSTREAM_ERROR',
        message: '如影平台暂时无法处理这次请求。',
        hint: codeHint || '这是平台侧的临时故障，请稍后重试。',
        action: 'later', detail, codeHint,
      });
    }
    return new AppError({
      code: 'UPSTREAM_REJECTED',
      message: platformMsg ? `平台未接受这次请求：${platformMsg}` : '平台未接受这次请求。',
      hint: codeHint || '请检查填写的参数（如素材地址是否可公网访问、时长是否至少 5 秒）后重试；仍失败请联系对接人。',
      action: 'fix', detail, codeHint,
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

/** 前端可见的错误体（codeHint：平台业务码对应的中文排查提示，没有时为空串） */
export function errorBody(e) {
  return { code: e.code, message: e.message, hint: e.hint, action: e.action, codeHint: e.codeHint || '', data: null };
}
