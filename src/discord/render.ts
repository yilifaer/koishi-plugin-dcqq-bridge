// Discord 原始 MESSAGE_CREATE → Msg（清单 §6.1、§6.4、§7.1–§7.4、R13、R14、O4）
import type { Media, Msg, ReplyInfo } from '../types'
import { renderContent, type ContentEnv } from './markdown'
import { formatTimestamp } from './timestamp'

// 只取用到的字段，全部可选，宽松对待网关数据（R3：不从适配器导入运行时代码）
export interface RawUser {
  id: string
  username?: string
  global_name?: string | null
  bot?: boolean
}

export interface RawMember {
  nick?: string | null
}

export interface RawAttachment {
  id?: string
  filename?: string
  content_type?: string
  size?: number
  url?: string
  proxy_url?: string
}

export interface RawEmbedMedia {
  url?: string
  proxy_url?: string
}

export interface RawEmbed {
  type?: string
  title?: string
  url?: string
  description?: string
  timestamp?: string
  author?: { name?: string }
  footer?: { text?: string }
  fields?: { name?: string; value?: string; inline?: boolean }[]
  image?: RawEmbedMedia
  thumbnail?: RawEmbedMedia
}

export interface RawSticker {
  id: string
  name?: string
  format_type?: number
}

export interface RawComponent {
  type: number
  content?: string
  components?: RawComponent[]
  accessory?: RawComponent
  items?: { media?: RawEmbedMedia }[]
  media?: RawEmbedMedia
  file?: { url?: string }
}

/** 转发快照里的消息（没有作者）。 */
export interface RawSnapshotMessage {
  content?: string
  embeds?: RawEmbed[]
  attachments?: RawAttachment[]
  sticker_items?: RawSticker[]
  components?: RawComponent[]
  mentions?: (RawUser & { member?: RawMember })[]
  flags?: number
}

export interface RawMessage {
  id: string
  channel_id: string
  guild_id?: string
  author: RawUser
  member?: RawMember
  content?: string
  timestamp?: string
  type?: number
  mention_everyone?: boolean
  mentions?: (RawUser & { member?: RawMember })[]
  embeds?: RawEmbed[]
  attachments?: RawAttachment[]
  sticker_items?: RawSticker[]
  components?: RawComponent[]
  flags?: number
  webhook_id?: string
  poll?: { question?: { text?: string } }
  message_reference?: { type?: number; message_id?: string; channel_id?: string; guild_id?: string }
  referenced_message?: RawMessage | null
  message_snapshots?: { message?: RawSnapshotMessage }[]
}

export interface RenderOptions {
  timeZone: string
  now: number
  roleName(id: string): string | undefined
  channelName(id: string): string | undefined
  backfill?: boolean
}

// 只转发这几种消息：0 普通（含转发、公告推送）、19 回复、20 斜杠命令结果、23 右键菜单命令结果
const FORWARDED_TYPES = new Set([0, 19, 20, 23])
const SUPPRESS_NOTIFICATIONS = 1 << 12
const IS_COMPONENTS_V2 = 1 << 15
// 链接预览类 embed 不渲染
const PREVIEW_EMBEDS = new Set(['link', 'article', 'video', 'image', 'gifv'])

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i
const AUDIO_EXT = /\.(mp3|ogg|oga|wav|m4a|flac|opus|aac)$/i

/** 显示名：服务器昵称 → 全局显示名 → 用户名 → `用户`。 */
export function displayName(user: RawUser | undefined, member?: RawMember | null): string {
  return member?.nick || user?.global_name || user?.username || '用户'
}

/** 消息作者名；webhook 消息用 author.username（webhook 名字）。 */
function authorName(d: { author?: RawUser; member?: RawMember; webhook_id?: string }): string {
  if (d.webhook_id) return d.author?.username || '用户'
  return displayName(d.author, d.member)
}

/** 公网 http(s) 地址才返回 true（R14：内网、回环、localhost 的地址不下载）。 */
export function isPublicUrl(url: string | undefined): url is string {
  if (!url) return false
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]]
    if (a === 0 || a === 10 || a === 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 100 && b >= 64 && b <= 127) return false
    return true
  }
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return false
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return false
    if (host.startsWith('::ffff:')) return false
  }
  return true
}

function envFor(mentions: RawMessage['mentions'], opts: RenderOptions, roles = true, onToken?: (s: string) => void): ContentEnv {
  return {
    onToken,
    timeZone: opts.timeZone,
    now: opts.now,
    userName(id) {
      const u = mentions?.find((m) => m.id === id)
      return u ? displayName(u, u.member) : undefined
    },
    // 快照里的角色属于原服务器，一律写 `@角色`
    roleName: roles ? (id) => opts.roleName(id) : () => undefined,
    channelName: (id) => opts.channelName(id),
  }
}

/** embed 地址：先 proxy_url，再 url（url 只在是公网地址时保留）。 */
function mediaUrls(m: RawEmbedMedia | undefined): string[] {
  if (!m) return []
  const urls: string[] = []
  if (m.proxy_url && isPublicUrl(m.proxy_url)) urls.push(m.proxy_url)
  if (m.url && isPublicUrl(m.url) && !urls.includes(m.url)) urls.push(m.url)
  return urls
}

function imageMedia(urls: string[], name = '', extra: Partial<Media> = {}): Media {
  return { kind: 'image', urls, name, placeholder: '[图片]', ...extra }
}

/** 一个 embed → 文字块（§7.2）。链接预览返回 null。图片放进 media；标题、描述、字段名和值另外放进 tr（翻译输入）。 */
function renderEmbed(e: RawEmbed, env: ContentEnv, media: Media[], tr: string[]): string | null {
  if (e.type && e.type !== 'rich') return null
  const lines: string[] = []
  if (e.author?.name) lines.push(e.author.name)
  const title = e.title ? renderContent(e.title, env) : ''
  if (title || e.url) lines.push([title, e.url].filter(Boolean).join(' '))
  const desc = e.description ? renderContent(e.description, env) : ''
  if (e.description) lines.push(desc)
  tr.push(title, desc)
  for (const f of e.fields ?? []) {
    const name = renderContent(f.name ?? '', env)
    const raw = renderContent(f.value ?? '', env)
    tr.push(name, raw)
    // 字段值有换行：换行后缩进两个空格
    const value = raw.replace(/\n/g, '\n  ')
    if (name || value) lines.push(`${name}：${value}`)
  }
  const footer: string[] = []
  if (e.footer?.text) footer.push(e.footer.text)
  if (e.timestamp) {
    const ms = Date.parse(e.timestamp)
    const t = Number.isNaN(ms) ? null : formatTimestamp(Math.floor(ms / 1000), 'f', env.timeZone, env.now)
    if (t) footer.push(t)
  }
  if (footer.length) lines.push(footer.join(' · '))
  for (const m of [e.image, e.thumbnail]) {
    if (m && (m.url || m.proxy_url)) media.push(imageMedia(mediaUrls(m)))
  }
  const text = lines.filter((l) => l.trim() !== '').join('\n')
  return text || null
}

/** 组件消息（R13）：递归找 TextDisplay 文字和图片；返回文字行。 */
function walkComponents(list: RawComponent[] | undefined, env: ContentEnv, media: Media[], out: string[], tr: string[]) {
  for (const c of list ?? []) {
    if (!c || typeof c !== 'object') continue
    switch (c.type) {
      case 10:
        if (c.content) {
          const t = renderContent(c.content, env)
          out.push(t)
          tr.push(t)
        }
        break
      case 11:
        if (c.media) media.push(imageMedia(mediaUrls(c.media)))
        break
      case 12:
        for (const item of c.items ?? []) {
          if (item?.media) media.push(imageMedia(mediaUrls(item.media)))
        }
        break
      case 13:
        out.push('[文件]')
        break
    }
    if (c.components) walkComponents(c.components, env, media, out, tr)
    if (c.accessory) walkComponents([c.accessory], env, media, out, tr)
  }
}

function extOf(name: string) {
  return name.replace(/[?#].*$/, '')
}

/** 附件（§7.4）：图片、视频进 media；音频、其他文件变成文字行。 */
function renderAttachments(list: RawAttachment[] | undefined, media: Media[], lines: string[], names: string[]) {
  for (const a of list ?? []) {
    const name = a.filename ?? ''
    const ct = (a.content_type ?? '').toLowerCase()
    const url = a.url ?? a.proxy_url ?? ''
    const urls = [a.url, a.proxy_url].filter((u): u is string => !!u)
    if (name) names.push(name)
    const base = { name, size: a.size, mime: a.content_type }
    if (ct.startsWith('image/') || (!ct && IMAGE_EXT.test(extOf(name)))) {
      media.push({ kind: 'image', urls, placeholder: '[图片]', ...base })
    } else if (ct.startsWith('video/') || (!ct && VIDEO_EXT.test(extOf(name)))) {
      media.push({ kind: 'video', urls, placeholder: `[视频: ${name}] ${url}`.trimEnd(), ...base })
    } else if (ct.startsWith('audio/') || (!ct && AUDIO_EXT.test(extOf(name)))) {
      lines.push(`[音频: ${name}] ${url}`.trimEnd())
    } else {
      lines.push(`[文件: ${name}] ${url}`.trimEnd())
    }
  }
}

/** 贴纸（§7.4）：PNG/APNG、GIF 当图片；Lottie 和未知格式写文字。 */
function renderStickers(list: RawSticker[] | undefined, media: Media[], lines: string[]) {
  for (const s of list ?? []) {
    const placeholder = `[贴纸: ${s.name ?? ''}]`
    if (s.format_type === 1 || s.format_type === 2) {
      media.push(imageMedia([`https://cdn.discordapp.com/stickers/${s.id}.png`], `${s.id}.png`, { placeholder }))
    } else if (s.format_type === 4) {
      media.push(imageMedia([`https://media.discordapp.net/stickers/${s.id}.gif`], `${s.id}.gif`, { placeholder }))
    } else {
      lines.push(placeholder)
    }
  }
}

/** 被回复消息内容为空时的替代文字。 */
function replyFallback(r: RawMessage): string {
  const att = r.attachments ?? []
  if (att.some((a) => (a.content_type ?? '').startsWith('image/') || IMAGE_EXT.test(extOf(a.filename ?? '')))) return '[图片]'
  if (att.length) return '[附件]'
  const sticker = r.sticker_items?.[0]
  if (sticker) return `[贴纸: ${sticker.name ?? ''}]`
  const embed = r.embeds?.find((e) => !e.type || e.type === 'rich') ?? r.embeds?.[0]
  if (embed) return embed.title ? `[embed ${embed.title}]` : '[embed]'
  return ''
}

const ROLE_RE = /<@&(\d+)>/g
const CHANNEL_RE = /<#(\d+)>/g

function embedTexts(list: RawEmbed[] | undefined): string[] {
  const out: string[] = []
  for (const e of list ?? []) {
    if (e.type && e.type !== 'rich') continue
    out.push(e.title ?? '', e.description ?? '')
    for (const f of e.fields ?? []) out.push(f.name ?? '', f.value ?? '')
  }
  return out
}

function componentTexts(list: RawComponent[] | undefined, out: string[] = []): string[] {
  for (const c of list ?? []) {
    if (!c || typeof c !== 'object') continue
    if (c.type === 10 && c.content) out.push(c.content)
    componentTexts(c.components, out)
    if (c.accessory) componentTexts([c.accessory], out)
  }
  return out
}

/** 渲染时会用到的角色、频道 ID（去重），给调用方预先取名字用。快照里的角色一律 `@角色`，不收集。 */
export function collectRefs(d: RawMessage): { roles: string[]; channels: string[] } {
  const roles = new Set<string>()
  const channels = new Set<string>()
  const scan = (texts: string[], withRoles: boolean) => {
    for (const t of texts) {
      if (!t) continue
      if (withRoles) for (const m of t.matchAll(ROLE_RE)) roles.add(m[1])
      for (const m of t.matchAll(CHANNEL_RE)) channels.add(m[1])
    }
  }
  scan([d.content ?? '', ...embedTexts(d.embeds), ...componentTexts(d.components)], true)
  const r = d.referenced_message
  if (d.type === 19 && r) scan([r.content ?? '', ...embedTexts(r.embeds)], true)
  if (d.message_reference?.type === 1) {
    for (const s of d.message_snapshots ?? []) {
      const m = s.message
      if (m) scan([m.content ?? '', ...embedTexts(m.embeds), ...componentTexts(m.components)], false)
    }
  }
  return { roles: [...roles], channels: [...channels] }
}

/** 渲染一条消息的 embed 和组件，返回文字块。 */
function renderRich(m: RawSnapshotMessage, env: ContentEnv, media: Media[], hasOther: boolean, tr: string[]): string[] {
  const blocks: string[] = []
  for (const e of m.embeds ?? []) {
    const b = renderEmbed(e, env, media, tr)
    if (b) blocks.push(b)
  }
  if (m.components?.length) {
    const lines: string[] = []
    const before = media.length
    walkComponents(m.components, env, media, lines, tr)
    const text = lines.filter((l) => l.trim() !== '').join('\n')
    if (text) blocks.push(text)
    // 组件里什么都没取到：V2 组件消息、或者消息本身没有别的内容时，写 `[组件消息]`；普通消息下面挂的按钮不提示
    else if (media.length === before && (((m.flags ?? 0) & IS_COMPONENTS_V2) || !hasOther)) blocks.push('[组件消息]')
  }
  return blocks
}

/** Discord 原始消息 → Msg。不转发的类型、渲染后全空的消息返回 null。 */
export function renderDiscordMessage(d: RawMessage, opts: RenderOptions): Msg | null {
  if (!FORWARDED_TYPES.has(d.type ?? 0)) return null
  // 翻译输入的片段、渲染出的受保护记号（回复不收集）
  const tr: string[] = []
  const tokens: string[] = []
  const onToken = (s: string) => { tokens.push(s) }
  const env = envFor(d.mentions, opts, true, onToken)
  const media: Media[] = []
  const blocks: string[] = []
  const tail: string[] = []
  const names: string[] = []

  let body = renderContent(d.content ?? '', env)
  // 投票行不进翻译输入
  tr.push(body)
  if (d.poll) {
    const line = `[投票] ${d.poll.question?.text ?? ''}`.trimEnd()
    body = body.trim() ? `${body}\n${line}` : line
  }

  renderAttachments(d.attachments, media, tail, names)
  renderStickers(d.sticker_items, media, tail)
  const hasOther = body.trim() !== '' || media.length > 0 || tail.length > 0
    || (d.embeds ?? []).some((e) => !e.type || e.type === 'rich')
  blocks.push(...renderRich(d, env, media, hasOther, tr))

  // 转发的消息：`[转发的消息]` 开头，快照没有作者；不做回复查找
  if (d.message_reference?.type === 1) {
    for (const s of d.message_snapshots?.length ? d.message_snapshots : [{}]) {
      const m = s.message ?? {}
      const senv = envFor(m.mentions, opts, false, onToken)
      const parts: string[] = ['[转发的消息]']
      const content = renderContent(m.content ?? '', senv)
      tr.push(content)
      if (content.trim()) parts.push(content)
      const lines: string[] = []
      renderAttachments(m.attachments, media, lines, names)
      renderStickers(m.sticker_items, media, lines)
      const other = !!content.trim() || lines.length > 0 || !!m.attachments?.length || !!m.sticker_items?.length
        || (m.embeds ?? []).some((e) => !e.type || e.type === 'rich')
      const rich = renderRich(m, senv, media, other, tr)
      const head = parts.join('\n')
      blocks.push([head, ...rich, ...(lines.length ? [lines.join('\n')] : [])].join('\n\n'))
    }
  }

  if (tail.length) blocks.push(tail.join('\n'))

  if (!body.trim() && !blocks.length && !media.length) return null

  let reply: ReplyInfo | undefined
  if (d.type === 19) {
    const r = d.referenced_message
    const messageId = d.message_reference?.message_id ?? r?.id ?? ''
    if (r === null) {
      reply = { messageId, author: '', content: '', deleted: true }
    } else if (r) {
      const content = renderContent(r.content ?? '', envFor(r.mentions, opts)).trim() || replyFallback(r)
      reply = { messageId, author: authorName(r), content, deleted: false }
    } else {
      reply = { messageId, author: '', content: '', deleted: false }
    }
  }

  const translatable = tr.map((t) => t.trim()).filter(Boolean).join('\n\n')
  // 去重，只留真的出现在翻译输入里的
  const protect = [...new Set(tokens)].filter((t) => t !== '' && translatable.includes(t))

  const ts = d.timestamp ? Date.parse(d.timestamp) : NaN
  return {
    platform: 'discord',
    channelId: d.channel_id,
    messageId: d.id,
    guildId: d.guild_id,
    authorId: d.author?.id ?? '',
    author: authorName(d),
    body,
    blocks,
    media,
    reply,
    mentionEveryone: d.mention_everyone === true,
    silent: ((d.flags ?? 0) & SUPPRESS_NOTIFICATIONS) !== 0,
    timestamp: Number.isNaN(ts) ? opts.now : ts,
    backfill: opts.backfill === true,
    checkText: [body, ...blocks, ...names].filter((s) => s !== '').join('\n'),
    translatable,
    protect,
  }
}
