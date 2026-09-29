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

export function parseSlangYaml(text: string): { entries: SlangEntry[]; warnings: string[] } {
  const warnings: string[] = []
  const entries: SlangEntry[] = []
  let doc: unknown
  try {
    doc = yaml.load(text)
  } catch (e) {
    const reason = e instanceof Error ? e.message.split('\n')[0] : String(e)
    warnings.push(`黑话表 YAML 解析失败，当作没有黑话表：${reason}`)
    return { entries, warnings }
  }
  if (doc === undefined || doc === null) return { entries, warnings }
  if (!Array.isArray(doc)) {
    warnings.push('黑话表的最外层应该是列表（每条以 `- en:` 开头），当作没有黑话表')
    return { entries, warnings }
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
