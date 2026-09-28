// 发往 QQ（清单 §7.5、§10）：一律传元素数组；任何错误都不重试（LLBot 超时时消息可能已经发出，S21）。
// 例外：QQ 机器人没连上时请求肯定没发出，最多等到 60 秒上限（DECISIONS 第 8 条）。

import { Universal } from 'koishi'
import type { Element } from 'koishi'
import { describeError } from '../log'
import { defaultSleep } from '../discord/api'

export type QQResult =
  | { ok: true; messageId: string }
  | { ok: false; reason: string; maybeSent: boolean }

export function qqOnline(bot: any) {
  return !!bot && bot.status === Universal.Status.ONLINE && typeof bot.internal?._request === 'function'
}

function notConnected(error: unknown) {
  return error instanceof TypeError && /_request is not a function/.test(error.message)
}

export async function sendQQ(
  getBot: () => any,
  groupId: string,
  elements: Element[],
  options: { signal: AbortSignal; deadline: number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> },
): Promise<QQResult> {
  const sleep = options.sleep ?? defaultSleep
  while (true) {
    const bot = getBot()
    if (!qqOnline(bot)) {
      if (Date.now() >= options.deadline || options.signal.aborted) return { ok: false, reason: 'QQ 未连接', maybeSent: false }
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
      return { ok: false, reason: describeError(error), maybeSent: true }
    }
  }
}
