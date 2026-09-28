// QQ（OneBot）消息 → Msg（清单 §8.1、R11、R12）。只读 session.elements，不读 session.content。

import { h } from 'koishi'
import type { Element } from 'koishi'
import type { Media, Msg, ReplyInfo } from '../types'

export interface RenderEnv {
  /** 群名片或昵称（缓存的 getGuildMember 结果）；不知道时返回 undefined。 */
  memberName(id: string): string | undefined
}

export interface ParseEnv extends RenderEnv {
  selfId: string
  now: number
}

/** parseQQMessage 用到的 session 字段（真实的 Koishi Session 满足这个结构）。 */
export interface QQSessionLike {
  channelId?: string
  messageId?: string
  userId?: string
  timestamp?: number
  elements?: Element[]
  quote?: {
    id?: string
    elements?: Element[]
    member?: { nick?: string }
    user?: { name?: string }
  }
  event: {
    user?: { name?: string; avatar?: string }
    member?: { nick?: string }
  }
  onebot?: any
}

/** 被 @ 的 QQ 号（不含 @全体）。 */
export function collectAtIds(elements: Element[]): string[] {
  const ids: string[] = []
  for (const el of elements) {
    if (el.type === 'at' && el.attrs.type !== 'all' && el.attrs.id != null && el.attrs.id !== '') {
      ids.push(String(el.attrs.id))
    }
  }
  return ids
}

/** 从原始数据取被回复的消息 ID：数组形式的 reply 段，或 CQ 码字符串（S20）。 */
export function replyIdFromRaw(raw: unknown): string | undefined {
  if (Array.isArray(raw)) {
    for (const seg of raw) {
      if (seg && typeof seg === 'object' && seg.type === 'reply') {
        const id = seg.data?.id
        if (id != null && String(id) !== '') return String(id)
      }
    }
    return undefined
  }
  if (typeof raw === 'string') {
    const m = /\[CQ:reply,(?:[^\]]*?,)?id=([^,\]]+)/.exec(raw)
    if (m) return unescapeCQ(m[1])
  }
  return undefined
}

function unescapeCQ(s: string): string {
  return s.replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&')
}

function parseJson(data: unknown): any {
  if (data && typeof data === 'object') return data
  if (typeof data !== 'string') return undefined
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

// 小程序 / json 卡片的标题：prompt，或 meta 里任意一项的 title / desc
function cardTitle(data: unknown): string {
  const json = parseJson(data)
  if (!json || typeof json !== 'object') return ''
  if (typeof json.prompt === 'string' && json.prompt.trim()) return json.prompt.trim()
  const meta = json.meta
  if (meta && typeof meta === 'object') {
    for (const item of Object.values(meta) as any[]) {
      if (!item || typeof item !== 'object') continue
      for (const key of ['title', 'desc']) {
        if (typeof item[key] === 'string' && item[key].trim()) return item[key].trim()
      }
    }
  }
  return ''
}

const str = (v: unknown) => (v == null ? '' : String(v))
const src = (attrs: Record<string, any>) => str(attrs.src || attrs.url)

/** 按 §8.1 的表把 QQ 元素渲染成纯文本 + 媒体。 */
export function renderQQElements(elements: Element[], env: RenderEnv): { text: string; media: Media[] } {
  let text = ''
  const media: Media[] = []
  for (const el of elements) {
    const a = el.attrs
    switch (el.type) {
      case 'text':
        text += str(a.content)
        break
      case 'at':
        if (a.type === 'all') text += '@全体成员'
        else text += '@' + (str(a.name) || env.memberName(str(a.id)) || str(a.id))
        break
      case 'face':
        text += a.name ? `[${a.name}]` : '[表情]'
        break
      case 'mface': {
        text += '[表情包]'
        const url = str(a.url)
        if (url) media.push({ kind: 'image', urls: [url], name: '', placeholder: '[表情包]' })
        break
      }
      case 'img':
      case 'image': {
        const url = src(a)
        media.push({ kind: 'image', urls: url ? [url] : [], name: str(a.file || a.name), placeholder: '[图片]' })
        break
      }
      case 'audio':
      case 'record':
        text += '[语音]'
        break
      case 'video': {
        const url = src(a)
        const size = Number(a.fileSize ?? a.size)
        media.push({
          kind: 'video',
          urls: url ? [url] : [],
          name: str(a.file || a.name),
          size: Number.isFinite(size) && size > 0 ? size : undefined,
          placeholder: '[视频]',
        })
        break
      }
      case 'file': {
        const name = str(a.file || a.name)
        text += name ? `[文件: ${name}]` : '[文件]'
        break
      }
      case 'forward':
        text += '[合并转发]'
        break
      case 'json': {
        const title = cardTitle(a.data)
        text += title ? `[卡片: ${title}]` : '[卡片]'
        break
      }
      case 'markdown': {
        const content = str(a.content) || str(parseJson(a.data)?.content)
        text += content
        break
      }
      case 'reply':
      case 'quote':
        break
      default:
        text += `[${el.type}]`
    }
  }
  return { text, media }
}

function fileNames(elements: Element[]): string[] {
  return elements.filter((el) => el.type === 'file').map((el) => str(el.attrs.file || el.attrs.name)).filter(Boolean)
}

// 回复时 QQ 客户端自动加的、指向机器人自己的 @：跳过开头的空白文字和 reply 段，第一个 at 是自己就去掉，并去掉后面文字开头的空格
function dropAutoAt(elements: Element[], selfId: string): Element[] {
  const out = elements.slice()
  let i = 0
  while (i < out.length) {
    const el = out[i]
    if (el.type === 'reply' || el.type === 'quote') i++
    else if (el.type === 'text' && !str(el.attrs.content).trim()) i++
    else break
  }
  const at = out[i]
  if (!at || at.type !== 'at' || at.attrs.type === 'all' || str(at.attrs.id) !== selfId) return elements
  out.splice(i, 1)
  const next = out[i]
  if (next && next.type === 'text') {
    out[i] = h.text(str(next.attrs.content).trimStart())
  }
  return out
}

export function parseQQMessage(session: QQSessionLike, env: ParseEnv): Msg {
  const raw = session.onebot
  let elements = session.elements ?? []
  const replyId = replyIdFromRaw(raw?.message) ?? (session.quote?.id ? String(session.quote.id) : undefined)

  let reply: ReplyInfo | undefined
  if (replyId) {
    elements = dropAutoAt(elements, env.selfId)
    const quote = session.quote
    reply = {
      messageId: replyId,
      author: quote?.member?.nick || quote?.user?.name || '',
      content: quote?.elements ? renderQQElements(quote.elements, env).text : '',
      deleted: false,
    }
  }

  const { text, media } = renderQQElements(elements, env)
  const userId = str(session.userId)
  const author =
    session.event.member?.nick ||
    session.event.user?.name ||
    raw?.sender?.card ||
    raw?.sender?.nickname ||
    userId
  const avatar = session.event.user?.avatar?.replace(/^http:\/\//, 'https://') || undefined
  const seq = Number(raw?.message_seq)
  const names = [...fileNames(elements), ...media.map((m) => m.name).filter(Boolean)]

  return {
    platform: 'onebot',
    channelId: str(session.channelId),
    messageId: str(session.messageId),
    authorId: userId,
    author: str(author),
    avatar,
    body: text,
    blocks: [],
    media,
    reply,
    mentionEveryone: false,
    silent: false,
    timestamp: session.timestamp || env.now,
    backfill: false,
    checkText: [text, ...names].filter(Boolean).join('\n'),
    seq: raw?.message_seq != null && raw.message_seq !== '' && Number.isFinite(seq) ? seq : undefined,
  }
}
