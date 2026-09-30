// 翻译输入里要原样保留的名字（U6、U7）：只影响发给模型的文字，不影响转发的原文。
// - U6：dotlan 链接里的军团、联盟名，以及建筑通知「The <建筑类型> <建筑名> in <星系>」里的建筑名；
// - U7：QQ 群成员名片里的名字（中译英）。
// 这里只算出要保护的范围，交给 protect() 当作必须整段保护的范围，和网址一样换成占位符。

import { loadEveData, structureTypeNames } from '../glossary'
import type { Glossary } from '../glossary'
import type { Range } from './protect'

const HAN = /\p{Script=Han}/u
const WORD_CHAR = /[\p{L}\p{N}]/u
// 只用来避开网址本身（链接里的名字不算，链接由 protect() 自己保护）
const URL_RE = /\bhttps?:\/\/\S+/gi
const DOTLAN_RE = /\bhttps?:\/\/evemaps\.dotlan\.net\/(?:corp|alliance)\/([^\s/?#)\]>]+)/gi
/** 建筑名最长取多少个字符（避免一整行都被当成名字）。 */
const MAX_STRUCTURE_NAME = 80

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** dotlan 链接里的军团、联盟名（U6 第 1 条）：`_` 换成空格，URL 解码。 */
export function dotlanNames(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(DOTLAN_RE)) {
    // 链接后面紧跟的句号、逗号不算名字
    let name = m[1].replace(/[.,;:!?'"]+$/, '').replace(/_/g, ' ')
    try {
      name = decodeURIComponent(name)
    } catch {
      // 解码失败就用原样
    }
    name = name.replace(/\s+/g, ' ').trim()
    if (WORD_CHAR.test(name)) out.add(name)
  }
  return [...out]
}

/**
 * 建筑通知里的建筑名（U6 第 2 条）：`The <建筑类型> <建筑名> in <星系>`。建筑类型来自官方名称表，
 * 例如 Astrahus、Ansiblex Jump Bridge。`The Astrahus in Jita` 这种没有名字的句子不算。
 */
export function structureNames(text: string, types: readonly string[]): string[] {
  if (!types.length || !/\bthe\s/i.test(text)) return []
  const alt = [...types].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')
  const re = new RegExp(`\\b[Tt]he (?:${alt}) (?!in )([^\\n]{1,${MAX_STRUCTURE_NAME}}?) in (?=\\S)`, 'g')
  const out = new Set<string>()
  for (const m of text.matchAll(re)) {
    const name = m[1].trim()
    if (WORD_CHAR.test(name)) out.add(name)
  }
  return [...out]
}

/**
 * 从一张群名片里取名字（U7）：去掉 `[]`、`【】` 里的简称，按 `-`、`_`、`|`、`/`、空白分段，
 * 只收 3 个字及以上、含汉字的段；isTerm 为真的段（和术语表原文相同）不收。
 */
export function cardNames(card: string, isTerm: (text: string) => boolean = () => false): string[] {
  const stripped = card.replace(/\[[^\]]*\]|【[^】]*】/g, ' ')
  const out: string[] = []
  for (const seg of stripped.split(/[-_|/\s]+/)) {
    const name = seg.trim()
    if ([...name].length >= 3 && HAN.test(name) && !isTerm(name)) out.push(name)
  }
  return out
}

/** 要避开的范围：网址，以及 protect 列表（提及、时间等）在文字里出现的位置。 */
function avoidRanges(text: string, spans: string[]): Range[] {
  const out: Range[] = []
  for (const m of text.matchAll(URL_RE)) out.push([m.index!, m.index! + m[0].length])
  for (const span of spans) {
    if (!span || !span.trim()) continue
    for (let i = text.indexOf(span); i >= 0; i = text.indexOf(span, i + 1)) out.push([i, i + span.length])
  }
  return out
}

/**
 * 名字在文字里出现的所有位置（长的优先，互不重叠），跳过网址和 protect 列表里的内容。
 * 名字以字母、数字开头（或结尾）时，那一边不能紧挨着字母、数字（`Example Corp` 不匹配 `Example Corps`）。
 */
export function nameRanges(text: string, names: string[], spans: string[] = []): Range[] {
  const list = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!list.length) return []
  const taken = avoidRanges(text, spans)
  const out: Range[] = []
  const free = (s: number, e: number) => !taken.some(([a, b]) => s < b && e > a)
  for (const name of list) {
    const leftWord = WORD_CHAR.test(name[0]) && !HAN.test(name[0])
    const rightWord = WORD_CHAR.test(name[name.length - 1]) && !HAN.test(name[name.length - 1])
    for (let i = text.indexOf(name); i >= 0; i = text.indexOf(name, i + 1)) {
      const end = i + name.length
      if (leftWord && i > 0 && WORD_CHAR.test(text[i - 1])) continue
      if (rightWord && end < text.length && WORD_CHAR.test(text[end])) continue
      if (!free(i, end)) continue
      taken.push([i, end])
      out.push([i, end])
    }
  }
  return out.sort((a, b) => a[0] - b[0])
}

type MemberFetch = (groupId: string) => Promise<Array<{ card?: string; nickname?: string }> | undefined | null> | undefined | null

const MEMBER_TTL = 3600 * 1000
/** 查询失败后多久再试。 */
const MEMBER_RETRY = 5 * 60 * 1000
const MEMBER_TIMEOUT = 15000

/**
 * QQ 群成员名片缓存（U7）：每个群缓存 1 小时，过期后在后台刷新，取的时候从不等待。
 * 还没取到（插件刚启动后的第一条消息）或查询失败时返回空列表，照常翻译。
 */
export class MemberNames {
  private cache = new Map<string, { cards: string[]; at: number; loading: boolean }>()

  constructor(private fetch: MemberFetch, private now: () => number = Date.now) {}

  /** 这个群现在已知的名片（原样，未分段）；需要时在后台刷新。 */
  cards(groupId: string): string[] {
    const entry = this.cache.get(groupId)
    if (!entry || (!entry.loading && this.now() - entry.at >= MEMBER_TTL)) void this.refresh(groupId)
    return entry?.cards ?? []
  }

  /** 后台刷新（测试里可以直接 await）。 */
  async refresh(groupId: string): Promise<void> {
    const entry = this.cache.get(groupId) ?? { cards: [], at: 0, loading: false }
    if (entry.loading) return
    entry.loading = true
    this.cache.set(groupId, entry)
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      const list = await Promise.race([
        Promise.resolve(this.fetch(groupId)),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), MEMBER_TIMEOUT))),
      ]).finally(() => clearTimeout(timer))
      if (!Array.isArray(list)) throw new Error('no list')
      const cards = new Set<string>()
      for (const m of list) {
        // 没有群名片时，群里显示的是 QQ 昵称
        const card = String(m?.card || m?.nickname || '').trim()
        if (card) cards.add(card)
      }
      entry.cards = [...cards]
      entry.at = this.now()
    } catch {
      // 查询失败：当作没有名片，过一会儿再试
      entry.cards = []
      entry.at = this.now() - MEMBER_TTL + MEMBER_RETRY
    } finally {
      entry.loading = false
    }
  }
}

let fallbackTypes: string[] | null = null
/** 没有加载官方表（`glossary.eve` 关闭）时，建筑类型名直接从插件自带的官方表读一次。 */
function structureTypes(glossary: Glossary | null): string[] {
  const own = glossary?.structureTypeNames() ?? []
  if (own.length) return own
  return (fallbackTypes ??= structureTypeNames(loadEveData()))
}

/**
 * 这条消息翻译时要整段保护的名字的范围（U6、U7），交给 protect() 的 keep。
 * members：这个 QQ 群的成员名片（只在中译英、开关打开时给）。
 */
export function protectedNameRanges(
  text: string,
  options: { direction: 'en2zh' | 'zh2en'; glossary: Glossary | null; spans?: string[]; members?: string[] },
): Range[] {
  const names = [...dotlanNames(text), ...structureNames(text, structureTypes(options.glossary))]
  if (options.direction === 'zh2en' && options.members?.length) {
    const isTerm = (seg: string) => options.glossary?.hasSource(seg, 'zh2en') ?? false
    for (const card of options.members) {
      for (const name of cardNames(card, isTerm)) if (text.includes(name)) names.push(name)
    }
  }
  return nameRanges(text, names, options.spans ?? [])
}
