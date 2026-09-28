// 前缀和「↪ 回复」引用行（清单 §7.5、§9）。

import { truncate } from './split'

/** 引用行里内容的最大字数。 */
export const REPLY_EXCERPT = 30

/** `↪ 回复 名字：内容前 30 字`（+ ` · 链接`）。内容里的换行变成空格。 */
export function replyLine(author: string, content: string, link?: string): string {
  const excerpt = truncate(content.replace(/\s*[\r\n]+\s*/g, ' ').trim(), REPLY_EXCERPT)
  const name = author.trim()
  const line = name ? `↪ 回复 ${name}：${excerpt}` : `↪ 回复：${excerpt}`
  return link ? `${line} · ${link}` : line
}

export function deletedReplyLine(): string {
  return '↪ 回复 一条已删除的消息'
}

/** `[桥名 - 显示名]`；桥名为空写 `[显示名]`；补发的在显示名后加 `（补发）`。 */
export function prefixFor(label: string, author: string, backfill: boolean): string {
  const name = author + (backfill ? '（补发）' : '')
  return label.trim() ? `[${label.trim()} - ${name}]` : `[${name}]`
}

// 插件加的前缀：`[…]`（Discord 那边可能带转义 `\[…\]`），后面是换行、空格或结尾
const PREFIX = /^\\?\[[^\n]*?\\?\](?: |\n|$)/
// 引用行：整行
const REPLY = /^↪ 回复[^\n]*(?:\n|$)/

/**
 * 去掉插件自己加在转发消息前面的东西（回复一条转发过来的消息时用）。
 * 按发送时的顺序各去一次：@全体 或 fallbackText → 前缀 → 引用行。
 */
export function stripOwnDecorations(text: string, opts: { fallbackText: string }): string {
  const fallback = opts.fallbackText.trim()
  let rest = text.trimStart()
  if (rest.startsWith('@全体成员')) rest = rest.slice('@全体成员'.length).trimStart()
  else if (fallback && rest.startsWith(fallback)) rest = rest.slice(fallback.length).trimStart()
  rest = rest.replace(PREFIX, '').trimStart()
  rest = rest.replace(REPLY, '').trimStart()
  return rest
}
