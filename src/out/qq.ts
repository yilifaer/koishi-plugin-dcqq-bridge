// 发往 QQ 的元素（清单 §7.5、§10 第 2 条、O1）。一律返回新建的元素，不传字符串（避免 h.parse，S1、S3）。

import { h } from 'koishi'
import type { Element } from 'koishi'
import { splitText } from '../text/split'

export type QQImage = { data: ArrayBuffer; mime: string } | { placeholder: string }

export interface QQSendInput {
  /** 被回复消息在这个群的 ID（有对应时）。 */
  quoteId?: string
  /** @全体 通过。 */
  atAll: boolean
  /** @全体 没通过时写在最前面的文字。 */
  fallbackText?: string
  /** `[桥名 - 显示名]`，每次发送都带。 */
  prefix: string
  /** 回复但没有对应时的引用行（只在第一次发送）。 */
  replyLine?: string
  text: string
  /** PR 2：译文，原样附在正文后面。 */
  translation?: string
  images: QQImage[]
  videos: Array<{ url: string; placeholder: string }>
  /** 每次发送的最大字数，默认 1500。 */
  limit?: number
}

export const QQ_LIMIT = 1500
const AT_ALL_COST = '@全体成员\n'.length

/** 返回每次发送的元素数组；没有可发的内容时返回 []。 */
export function buildQQSends(input: QQSendInput): Element[][] {
  const limit = input.limit ?? QQ_LIMIT
  const images = input.images.filter((i): i is { data: ArrayBuffer; mime: string } => 'data' in i)
  const placeholders = input.images.filter((i): i is { placeholder: string } => 'placeholder' in i).map((i) => i.placeholder)

  let body = [input.text, input.translation ?? ''].filter((s) => s.trim() !== '').map((s) => s.trimEnd()).join('\n\n')
  // 下载失败的图片：占位文字放在图片前面（也就是正文最后）
  if (placeholders.length) body = [body, ...placeholders].filter(Boolean).join('\n')

  if (!body && !images.length && !input.videos.length) return []

  const fallback = !input.atAll && input.fallbackText?.trim() ? input.fallbackText.trim() + ' ' : ''
  const prefix = input.prefix
  const reply = input.replyLine ?? ''
  const prefixCost = prefix ? prefix.length + 1 : 0
  const firstCost = prefixCost + (reply ? reply.length + 1 : 0) + (input.atAll ? AT_ALL_COST : fallback.length)
  const pieces = splitText(body, Math.max(10, limit - prefixCost), Math.max(10, limit - firstCost))
  if (!pieces.length) pieces.push('')

  const sends = pieces.map((piece, index) => {
    const first = index === 0
    const elements: Element[] = []
    let lead = ''
    if (first) {
      if (input.quoteId) elements.push(h.quote(input.quoteId))
      if (input.atAll) {
        elements.push(h('at', { type: 'all' }))
        lead = '\n'
      } else {
        lead = fallback
      }
    }
    const lines = [prefix, first ? reply : '', piece].filter(Boolean).join('\n')
    const content = lead + lines
    if (content) elements.push(h.text(content))
    if (index === pieces.length - 1) {
      for (const image of images) elements.push(h.image(Buffer.from(image.data), image.mime))
    }
    return elements
  })

  for (const video of input.videos) sends.push([h.video(video.url)])
  return sends.filter((els) => els.length)
}
