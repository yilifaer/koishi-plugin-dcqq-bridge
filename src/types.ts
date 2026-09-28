// 各模块共用的中间结构（清单 §6.4）。这里只放纯数据，不含任何 XML 或 Koishi 元素。

export type Platform = 'discord' | 'onebot'

export type MediaKind = 'image' | 'video' | 'audio' | 'file'

/** 一个待转发的媒体。下载失败或不能发送时，用 placeholder 代替。 */
export interface Media {
  kind: MediaKind
  /** 下载地址，按顺序尝试（例如 embed 图片先用 proxy_url）。空数组 = 没有可用地址，直接用占位文字。 */
  urls: string[]
  /** 文件名（可以为空）。 */
  name: string
  /** 字节数，未知时为 undefined。 */
  size?: number
  mime?: string
  /** 下载或发送失败时写在消息里的文字，例如 `[图片]`、`[视频: a.mp4] https://…`。 */
  placeholder: string
}

/** 被回复的消息（清单 §7.4、§8.1、§9）。 */
export interface ReplyInfo {
  /** 被回复的消息 ID（来源平台上的）。 */
  messageId: string
  /** 被回复消息的作者显示名；未知时为空字符串。 */
  author: string
  /** 被回复消息的纯文本内容（已渲染，未截断）。 */
  content: string
  /** Discord：被回复的消息已被删除（referenced_message 为 null）。 */
  deleted: boolean
}

/** 从来源解析一次得到的消息，给所有目标共用。 */
export interface Msg {
  platform: Platform
  channelId: string
  messageId: string
  /** Discord 服务器 ID（Discord 来源时尽量填）。 */
  guildId?: string
  /** 作者 ID（Discord 用户 ID 或 QQ 号）。 */
  authorId: string
  /** 作者显示名。 */
  author: string
  /** 作者头像地址（QQ 来源，https）。 */
  avatar?: string
  /** 正文（已渲染成纯文本）。 */
  body: string
  /** 正文之后的文字块，按顺序：每个 embed 一块、组件消息、转发快照（以 `[转发的消息]` 开头）。 */
  blocks: string[]
  /** 媒体，按顺序。 */
  media: Media[]
  reply?: ReplyInfo
  /** 只来自 Discord 原始数据的 mention_everyone。 */
  mentionEveryone: boolean
  /** Discord 静默消息（flags & 4096）。 */
  silent: boolean
  /** 来源消息的时间（毫秒）。 */
  timestamp: number
  /** 是否是断线补发的消息。 */
  backfill: boolean
  /** 检查用文字：正文 + 所有文字块 + 文件名（给屏蔽词用）。 */
  checkText: string
  /** QQ 来源：原始数据里的 message_seq（有的话），给重排用。 */
  seq?: number
}

/** 正文和文字块拼起来的完整文字（不含前缀、回复引用行）。 */
export function fullText(msg: Pick<Msg, 'body' | 'blocks'>): string {
  return [msg.body, ...msg.blocks].filter((s) => s.trim() !== '').join('\n\n')
}

/** 下载好的文件。 */
export interface FileData {
  name: string
  mime: string
  data: ArrayBuffer
}
