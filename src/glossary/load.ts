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
