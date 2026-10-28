// 发 QQ 超时后的核对（0.4.1 V3）：LLBot 超时时消息可能已经发出（S21），所以不能直接重发。
// 等几秒，取这个群最近 20 条消息，看机器人自己发的里有没有这一条（按正文开头比对）：
// 有 → 已送达；没有 → 可以重发一次；查询本身失败 → 说不准，不重发（宁可丢，不重复）。

import type { Element } from 'koishi'

/** 比对用的开头字数：前缀 + 换行之后再取这么多个字。 */
export const HEAD_BODY_CHARS = 30
/** 取群里最近几条消息来核对。 */
export const HISTORY_COUNT = 20
const QUERY_TIMEOUT = 8000

export type Delivered =
  | { state: 'sent'; messageId: string }
  | { state: 'missing' }
  | { state: 'unknown'; reason: string }

function normalize(text: string) {
  return text.replace(/\r\n?/g, '\n').trim()
}

/** 这次发送里所有文字元素拼起来的正文（@、回复、图片不算）。 */
export function sentText(elements: Element[]): string {
  return elements.filter((el) => el.type === 'text').map((el) => String(el.attrs.content ?? '')).join('')
}

/** CQ 码字符串（上报格式不是数组时）里的文字：去掉 `[CQ:…]`，还原转义。 */
function fromCQ(raw: string) {
  return raw
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&')
}

/** 历史消息里的文字：数组格式取所有 text 段，字符串格式去掉 CQ 码。 */
export function historyText(message: any): string {
  const body = message?.message
  if (Array.isArray(body)) return body.filter((seg: any) => seg?.type === 'text').map((seg: any) => String(seg?.data?.text ?? '')).join('')
  if (typeof body === 'string') return fromCQ(body)
  if (typeof message?.raw_message === 'string') return fromCQ(message.raw_message)
  return ''
}

/**
 * 在历史消息里找机器人自己发的、开头和 head 一样的那一条，返回它的消息 ID。
 * head 为空（这次发的只有图片之类，没有文字）时无法比对，返回 undefined。
 */
export function findOwn(history: any[], selfId: string, head: string): string | undefined {
  if (!head) return undefined
  for (const message of history.slice(-HISTORY_COUNT)) {
    const sender = message?.sender?.user_id ?? message?.user_id
    if (String(sender) !== String(selfId)) continue
    if (normalize(historyText(message)).startsWith(head)) return String(message.message_id ?? '')
  }
  return undefined
}

/** 这次发送拿去比对的开头：文字里前缀加前 30 个字。 */
export function headOf(elements: Element[], prefixLength: number): string {
  return normalize(sentText(elements)).slice(0, prefixLength + 1 + HEAD_BODY_CHARS)
}

/** 取群里最近 20 条消息，核对这次发送是否已经送达。 */
export async function checkDelivered(bot: any, groupId: string, elements: Element[], prefixLength: number): Promise<Delivered> {
  const head = headOf(elements, prefixLength)
  if (!head) return { state: 'unknown', reason: '这条没有文字，无法比对' }
  let timer: NodeJS.Timeout | undefined
  try {
    const result: any = await Promise.race([
      Promise.resolve().then(() => bot.internal.getGroupMsgHistory(Number(groupId))),
      new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), QUERY_TIMEOUT))),
    ])
    if (result === 'timeout') return { state: 'unknown', reason: '查询超时' }
    const list = Array.isArray(result?.messages) ? result.messages : Array.isArray(result) ? result : null
    if (!list) return { state: 'unknown', reason: '返回的内容不对' }
    const id = findOwn(list, String(bot.selfId), head)
    return id === undefined ? { state: 'missing' } : { state: 'sent', messageId: id }
  } catch {
    return { state: 'unknown', reason: '查询失败' }
  } finally {
    clearTimeout(timer)
  }
}
