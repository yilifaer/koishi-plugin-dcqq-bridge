// 日志脱敏（清单 B17）：webhook token 换成 ***；QQ 发送错误只记类型、动作名和 retcode；
// Discord 错误只记状态码和 Discord 的错误 code；任何聊天内容都不进日志。

export function redact(text: string): string {
  return text.replace(/(\/webhooks\/\d+\/)[^/?\s"']+/g, '$1***')
}

/** 把一个错误变成可以写进日志的一句话（不含消息内容）。 */
export function describeError(error: unknown): string {
  const e = error as any
  if (!e || typeof e !== 'object') return redact(String(error))
  // cordis HTTP 错误
  if (e[Symbol.for('cordis.http.error')] || e.response || (typeof e.message === 'string' && /^fetch .* failed$/.test(e.message))) {
    if (e.response) {
      const data = e.response.data
      const code = data && typeof data === 'object' && 'code' in data ? ` code ${data.code}` : ''
      return `HTTP ${e.response.status}${code}`
    }
    if (e.code === 'ETIMEDOUT') return '请求超时'
    const cause = e.cause?.cause?.code ?? e.cause?.code
    if (cause) return `网络错误 ${cause}`
    return '网络错误'
  }
  // onebot 的 SenderError / TimeoutError：message 里有整条发送内容，不能记（R10）
  if (typeof e.url === 'string' && (typeof e.code === 'number' || /^(Timeout|Error) with request/.test(e.message ?? ''))) {
    const kind = e.constructor?.name && e.constructor.name !== 'Error' ? e.constructor.name
      : /^Timeout/.test(e.message ?? '') ? 'TimeoutError' : 'SenderError'
    return `${kind} ${e.url}${typeof e.code === 'number' ? ` retcode ${e.code}` : ''}`
  }
  if (e instanceof TypeError && /_request is not a function/.test(e.message)) return 'QQ 未连接'
  // bot.internal.* 抛出的 Error('[状态码] JSON')
  const match = /^\[(\d{3})\] ([\s\S]*)$/.exec(e.message ?? '')
  if (match) {
    let code = ''
    try {
      const data = JSON.parse(match[2])
      if (data && typeof data === 'object' && 'code' in data) code = ` code ${data.code}`
    } catch {}
    return `HTTP ${match[1]}${code}`
  }
  if (e.name === 'AbortError') return '已中止'
  return redact(`${e.name ?? 'Error'}: ${String(e.message ?? '').slice(0, 200)}`)
}

/** 从 bot.internal.* 的错误里取状态码和 Discord 错误 code。 */
export function internalErrorInfo(error: unknown): { status?: number; code?: number } {
  const e = error as any
  const match = /^\[(\d{3})\] ([\s\S]*)$/.exec(e?.message ?? '')
  if (!match) return {}
  let code: number | undefined
  try {
    code = JSON.parse(match[2])?.code
  } catch {}
  return { status: Number(match[1]), code }
}
