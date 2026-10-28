// 发往 QQ（清单 §7.5、§10）：一律传元素数组；任何错误都不重试（LLBot 超时时消息可能已经发出，S21）。
// 例外：QQ 机器人没连上时请求肯定没发出，最多等到 60 秒上限（DECISIONS 第 8 条）。
// 超时后是否重发由调用方先去群里核对（verify.ts，0.4.1 V3）；这里只在结果里标出「是超时」「retcode 是多少」。

import { Universal } from 'koishi'
import type { Element } from 'koishi'
import { describeError } from '../log'
import { defaultSleep } from '../discord/api'

export type QQResult =
  | { ok: true; messageId: string }
  | { ok: false; reason: string; maybeSent: boolean; timedOut?: boolean; retcode?: number }

export function qqOnline(bot: any) {
  return !!bot && bot.status === Universal.Status.ONLINE && typeof bot.internal?._request === 'function'
}

function notConnected(error: unknown) {
  return error instanceof TypeError && /_request is not a function/.test(error.message)
}

/** onebot 适配器等不到 LLBot 回复时抛的超时错误（不是 LLBot 明确回复了失败）。 */
export function isTimeout(error: unknown): boolean {
  const e = error as any
  if (!e || typeof e !== 'object' || typeof e.url !== 'string') return false
  return e.constructor?.name === 'TimeoutError' || /^Timeout with request/.test(String(e.message ?? ''))
}

/** LLBot 明确回复了失败时的 retcode（SenderError.code）；其他错误没有。 */
export function retcodeOf(error: unknown): number | undefined {
  const e = error as any
  return e && typeof e === 'object' && typeof e.url === 'string' && typeof e.code === 'number' ? e.code : undefined
}

export type LoginState = 'in' | 'out' | 'unknown'

/**
 * 问 LLBot 机器人有没有登录 QQ（0.4.1 V9）：`get_status` 的 online 是 false，或者直接返回 retcode 1200，就是没登录；
 * 别的错误、超时、不认识的返回内容都说不准（unknown），调用方按「没变」处理。
 */
export async function probeLogin(bot: any, timeoutMs = 5000): Promise<LoginState> {
  let timer: NodeJS.Timeout | undefined
  try {
    const status: any = await Promise.race([
      Promise.resolve().then(() => bot.internal.getStatus()),
      new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), timeoutMs))),
    ])
    if (status === 'timeout') return 'unknown'
    return status && typeof status === 'object' && status.online === false ? 'out' : 'in'
  } catch (error) {
    return retcodeOf(error) === 1200 ? 'out' : 'unknown'
  } finally {
    clearTimeout(timer)
  }
}

export async function sendQQ(
  getBot: () => any,
  groupId: string,
  elements: Element[],
  options: {
    signal: AbortSignal
    deadline: number
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    /** 机器人没连上时，返回 true 就不再等它连上，马上按「QQ 未连接」失败（已经知道 QQ 掉线、这个桥又打开了掉线补发时用）。 */
    noWait?: () => boolean
  },
): Promise<QQResult> {
  const sleep = options.sleep ?? defaultSleep
  while (true) {
    const bot = getBot()
    if (!qqOnline(bot)) {
      if (Date.now() >= options.deadline || options.signal.aborted || options.noWait?.()) return { ok: false, reason: 'QQ 未连接', maybeSent: false }
      await sleep(Math.min(1000, Math.max(0, options.deadline - Date.now())), options.signal).catch(() => {})
      continue
    }
    try {
      const ids: string[] = await bot.sendMessage(groupId, elements)
      const id = ids?.find((x) => x)
      if (!id) return { ok: false, reason: 'QQ 没有返回消息 ID', maybeSent: true }
      return { ok: true, messageId: String(id) }
    } catch (error) {
      if (notConnected(error)) continue
      const retcode = retcodeOf(error)
      return {
        ok: false,
        reason: describeError(error),
        maybeSent: true,
        ...(isTimeout(error) ? { timedOut: true } : {}),
        ...(retcode !== undefined ? { retcode } : {}),
      }
    }
  }
}
