import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EveData, EveEntry, EveTypeCat } from './types'

// 数据文件放在包根目录的 data/ 下；src/glossary（测试）和 lib/glossary（构建后）往上两级都是包根目录
const dataPath = (name: string) => resolve(__dirname, '../../data', name)

const KINDS = new Set<EveEntry['kind']>(['type', 'group', 'category', 'system', 'region', 'constellation'])
const CATS = new Set<EveTypeCat>(['ship', 'structure'])

/** 常用英语单词表（小写）。`#` 开头的行是注释。读不到时返回空集合，不抛异常。 */
export function loadCommonWords(): Set<string> {
  const words = new Set<string>()
  let text: string
  try {
    text = readFileSync(dataPath('common-words.txt'), 'utf8')
  } catch {
    return words
  }
  for (const line of text.split(/\r?\n/)) {
    const word = line.trim()
    if (word && !word.startsWith('#')) words.add(word.toLowerCase())
  }
  return words
}

/** 插件自带的 EVE 官方名称表（data/eve-glossary.json）。缺失或格式不对 → null。 */
export function loadEveData(): EveData | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(dataPath('eve-glossary.json'), 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const { buildNumber, generatedAt, entries } = raw as Record<string, unknown>
  if (!Array.isArray(entries)) return null
  const valid: EveEntry[] = []
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    const { en, zh, kind, cat } = e as Record<string, unknown>
    if (typeof en === 'string' && typeof zh === 'string' && KINDS.has(kind as EveEntry['kind'])) {
      const entry: EveEntry = { en, zh, kind: kind as EveEntry['kind'] }
      if (kind === 'type' && CATS.has(cat as EveTypeCat)) entry.cat = cat as EveTypeCat
      valid.push(entry)
    }
  }
  return {
    buildNumber: typeof buildNumber === 'number' ? buildNumber : 0,
    generatedAt: typeof generatedAt === 'string' ? generatedAt : '',
    entries: valid,
  }
}

export interface OnlineEveResult {
  data?: EveData
  /** 不能用的原因（简短的中文）；有 error 时没有 data */
  error?: string
  /** 不认识的 kind，跳过的条数（以后数据里加了新种类时不至于整份不能用） */
  skipped: number
  /** 从插件自带的表补上 cat 的条数；文件里自己有 cat 时为 0 */
  catFilled: number
}

/**
 * 检查在线的官方名称表（0.4.0）：`{ buildNumber, generatedAt?, count?, entries: [{ kind, en, zh, cat? }] }`。
 * - 最外层是对象，buildNumber 是正整数，entries 是列表；
 * - 每一条都要是对象、kind / en / zh 都是文字，有一条不是就整份不用（多半是文件坏了）；kind 不认识的跳过；
 * - 写了 count 时要和 entries 的条数一样（防止只下载了一半）；
 * - 能用的条数至少是插件自带表的一半（防止拿到一份几乎是空的表）。
 * cat（舰船 / 建筑）：整份文件里一条 cat 都没有时，按（物品，英文名）从插件自带的表补上；
 * 文件里有 cat 时以文件为准（说明数据仓库已经开始写 cat 了）。
 */
export function parseOnlineEveData(text: string, bundled: EveData | null): OnlineEveResult {
  const fail = (error: string): OnlineEveResult => ({ error, skipped: 0, catFilled: 0 })
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail('不是有效的 JSON')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('最外层不是对象')
  const { buildNumber, generatedAt, count, entries } = raw as Record<string, unknown>
  if (typeof buildNumber !== 'number' || !Number.isInteger(buildNumber) || buildNumber <= 0) return fail('没有 buildNumber')
  if (!Array.isArray(entries)) return fail('没有 entries 列表')
  if (count !== undefined && count !== entries.length) return fail(`count 是 ${String(count)}，entries 却有 ${entries.length} 条`)
  const valid: EveEntry[] = []
  let skipped = 0
  let hasCat = false
  for (const e of entries) {
    if (!e || typeof e !== 'object') return fail('entries 里有不是对象的条目')
    const { en, zh, kind, cat } = e as Record<string, unknown>
    if (typeof en !== 'string' || typeof zh !== 'string' || typeof kind !== 'string') return fail('entries 里有缺少 kind / en / zh 的条目')
    if (cat !== undefined) hasCat = true
    if (!KINDS.has(kind as EveEntry['kind'])) {
      skipped++
      continue
    }
    const entry: EveEntry = { en, zh, kind: kind as EveEntry['kind'] }
    if (kind === 'type' && CATS.has(cat as EveTypeCat)) entry.cat = cat as EveTypeCat
    valid.push(entry)
  }
  const minimum = Math.ceil((bundled?.entries.length ?? 0) / 2)
  if (!valid.length || valid.length < minimum) return fail(`只有 ${valid.length} 条，不到插件自带表的一半（${minimum} 条）`)
  let catFilled = 0
  if (!hasCat && bundled) {
    const cats = new Map<string, EveTypeCat>()
    for (const e of bundled.entries) if (e.kind === 'type' && e.cat) cats.set(e.en, e.cat)
    for (const e of valid) {
      const found = e.kind === 'type' ? cats.get(e.en) : undefined
      if (found) {
        e.cat = found
        catFilled++
      }
    }
  }
  return {
    data: { buildNumber, generatedAt: typeof generatedAt === 'string' ? generatedAt : '', entries: valid },
    skipped,
    catFilled,
  }
}

/**
 * 官方表里建筑类（SDE 类别 65）物品的英文名，例如 Astrahus、Fortizar、Keepstar、Ansiblex Jump Bridge、
 * Metenox Moon Drill（U6 用来识别建筑通知里的建筑类型）。去重，按长度从长到短排（方便拼正则时长的优先）。
 */
export function structureTypeNames(data: EveData | null | undefined): string[] {
  if (!data || !Array.isArray(data.entries)) return []
  const names = new Set<string>()
  for (const e of data.entries) {
    if (e && e.kind === 'type' && e.cat === 'structure' && typeof e.en === 'string' && e.en.trim()) names.add(e.en.trim())
  }
  return [...names].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
}
