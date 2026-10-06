import yaml from 'js-yaml'
import { DIRS, MODES } from './types'
import type { GlossaryDir, GlossaryMode, SlangEntry } from './types'

// 黑话表 YAML（清单 §12.3）。解析失败只记警告，绝不抛异常：当作没有黑话表继续运行。
// category、note、confidence 只给人看，这里直接忽略。

const asText = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim()
  // YAML 会把 `0.0`、`404` 这种写法读成数字
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function readAliases(value: unknown, where: string, field: string, warnings: string[]): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const list = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of list) {
    const text = asText(item)
    if (text) out.push(text)
    else warnings.push(`${where}：${field} 里有无效的写法，已忽略`)
  }
  return out
}

/**
 * fatal：整个文件不能用（YAML 解析失败、最外层不是列表）。在线黑话表下载到这种内容时不替换手上的旧版本（0.4.0）。
 * 每一条里多出来的字段（category、note、confidence 等）直接忽略，不算错。
 */
export function parseSlangYaml(text: string): { entries: SlangEntry[]; warnings: string[]; fatal?: string } {
  const warnings: string[] = []
  const entries: SlangEntry[] = []
  let doc: unknown
  try {
    doc = yaml.load(text)
  } catch (e) {
    const reason = e instanceof Error ? e.message.split('\n')[0] : String(e)
    warnings.push(`黑话表 YAML 解析失败，当作没有黑话表：${reason}`)
    return { entries, warnings, fatal: 'YAML 解析失败' }
  }
  if (doc === undefined || doc === null) return { entries, warnings }
  if (!Array.isArray(doc)) {
    warnings.push('黑话表的最外层应该是列表（每条以 `- en:` 开头），当作没有黑话表')
    return { entries, warnings, fatal: '最外层不是列表' }
  }
  doc.forEach((item, i) => {
    const where = `黑话表第 ${i + 1} 条`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push(`${where}：不是 { en, zh, mode, dir } 格式，已跳过`)
      return
    }
    const raw = item as Record<string, unknown>
    const en = asText(raw.en)
    const zh = asText(raw.zh)
    const label = en ? `${where}（${en}）` : where
    if (!en || !zh) {
      warnings.push(`${label}：缺少 en 或 zh，已跳过`)
      return
    }
    if (!MODES.includes(raw.mode as GlossaryMode)) {
      warnings.push(`${label}：mode 无效（${String(raw.mode)}），应为 keep / force / hint，已跳过`)
      return
    }
    if (!DIRS.includes(raw.dir as GlossaryDir)) {
      warnings.push(`${label}：dir 无效（${String(raw.dir)}），应为 both / en2zh / zh2en，已跳过`)
      return
    }
    const entry: SlangEntry = { en, zh, mode: raw.mode as GlossaryMode, dir: raw.dir as GlossaryDir }
    const enAliases = readAliases(raw.en_aliases, label, 'en_aliases', warnings)
    const zhAliases = readAliases(raw.zh_aliases, label, 'zh_aliases', warnings)
    if (enAliases) entry.en_aliases = enAliases
    if (zhAliases) entry.zh_aliases = zhAliases
    entries.push(entry)
  })
  return { entries, warnings }
}

// ------------------------------------------------------------------ 多个黑话表文件（T8）

/** `glossary.slangFile` 可以写多个路径，用 `;;` 分隔；去掉空白和空项，保持顺序。 */
export function splitSlangPaths(value: string): string[] {
  return value.split(';;').map((p) => p.trim()).filter(Boolean)
}

/** `;;` 分出来的一项是不是网址（0.4.0 在线黑话表）：以 http:// 或 https:// 开头。 */
export function isUrlEntry(entry: string): boolean {
  return /^https?:\/\//i.test(entry.trim())
}

/** 一项里用 `||` 分隔的多个备用网址，按顺序；不是 http(s) 网址的放进 bad。 */
export function splitUrls(entry: string): { urls: string[]; bad: string[] } {
  const urls: string[] = []
  const bad: string[] = []
  for (const part of entry.split('||').map((p) => p.trim()).filter(Boolean)) {
    if (/^https?:\/\/[^\s/]+/i.test(part) && !/\s/.test(part)) {
      if (!urls.includes(part)) urls.push(part)
    } else bad.push(part)
  }
  return { urls, bad }
}

/** 网址或路径的文件名部分（网址去掉 ? 和 # 后面的部分）。 */
export function baseName(p: string): string {
  let path = p
  if (isUrlEntry(p)) {
    try {
      path = decodeURIComponent(new URL(p).pathname)
    } catch {
      path = p.split(/[?#]/)[0]
    }
  }
  return path.split(/[\\/]/).filter(Boolean).pop() || p
}

export interface SlangFileResult {
  /** 配置里写的路径（在线黑话表是第一个网址） */
  path: string
  /** 在线黑话表（0.4.0） */
  online?: boolean
  /** 读到的词条（这个文件自己的，合并前）；读不到时为 null */
  entries: SlangEntry[] | null
  /** 读不到时的原因（例如 ENOENT） */
  error?: string
  warnings: string[]
}

export interface SlangFileSummary {
  path: string
  /** 回复、状态里用的短名字（文件名；重名时用完整路径） */
  name: string
  /** 这个文件里的有效词条数；读不到时为 null */
  count: number | null
  /** 覆盖了前面文件里多少条词条（整条覆盖，或者 both 词条被覆盖了一个方向，都算一条） */
  replaced: number
  /** 在线黑话表（0.4.0） */
  online?: boolean
}

/** 词条用到的方向 */
const dirsOf = (e: SlangEntry): Array<'en2zh' | 'zh2en'> => (e.dir === 'both' ? ['en2zh', 'zh2en'] : [e.dir])

/**
 * 同一个原文按方向判断（U1）：英译中比 en（不区分大小写），中译英比 zh。
 * 两个都是 both：en 或 zh 相同就算同一个原文，整条覆盖（和 T8 一样）；
 * 方向不同时只在共有的方向上比较。返回前面的词条 older 被后面的 newer 覆盖掉的方向。
 */
function overriddenDirs(older: SlangEntry, newer: SlangEntry): Array<'en2zh' | 'zh2en'> {
  const enSame = older.en.toLowerCase() === newer.en.toLowerCase()
  const zhSame = older.zh === newer.zh
  if (older.dir === 'both' && newer.dir === 'both') return enSame || zhSame ? ['en2zh', 'zh2en'] : []
  const newerDirs = dirsOf(newer)
  return dirsOf(older).filter((d) => newerDirs.includes(d) && (d === 'en2zh' ? enSame : zhSame))
}

/**
 * 按顺序合并多个文件的词条：后面文件里同一个原文的词条覆盖前面文件的（按方向判断，见 overriddenDirs；
 * 同一个文件里的重复不在这里处理，还是交给 buildGlossary，和只有一个文件时一样）。
 * where：每条词条给警告用的位置，例如「黑话表 local-slang.yaml 第 2 条」；只有一个文件时和以前一样是「黑话表第 2 条」。
 */
export function mergeSlangFiles(files: SlangFileResult[]): {
  entries: SlangEntry[]
  where: string[]
  summary: SlangFileSummary[]
} {
  const names = files.map((f) => baseName(f.path))
  const single = files.length === 1
  let merged: Array<{ entry: SlangEntry; where: string }> = []
  const summary: SlangFileSummary[] = []
  files.forEach((file, i) => {
    const name = names.filter((n) => n === names[i]).length > 1 ? file.path : names[i]
    const entries = file.entries ?? []
    let replaced = 0
    if (!single && entries.length) {
      const next: typeof merged = []
      for (const m of merged) {
        const lost = new Set(entries.flatMap((e) => overriddenDirs(m.entry, e)))
        if (!lost.size) {
          next.push(m)
          continue
        }
        replaced++
        // 前面的 both 词条只被覆盖了一个方向：留下另一个方向（例如后面的 en2zh 覆盖了它，它只剩 zh2en）
        const left = dirsOf(m.entry).filter((d) => !lost.has(d))
        if (left.length) next.push({ entry: { ...m.entry, dir: left[0] }, where: m.where })
      }
      merged = next
    }
    entries.forEach((entry, j) => merged.push({ entry, where: single ? `黑话表第 ${j + 1} 条` : `黑话表 ${name} 第 ${j + 1} 条` }))
    summary.push({ path: file.path, name, count: file.entries ? entries.length : null, replaced, ...(file.online ? { online: true } : {}) })
  })
  return { entries: merged.map((m) => m.entry), where: merged.map((m) => m.where), summary }
}
