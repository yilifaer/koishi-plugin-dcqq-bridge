// 跳过规则（清单 §12.1 第 3 步）：只发原文，不算失败。语言判断都在去掉占位符之后的文字上算。

const HAN = /\p{Script=Han}/gu
// 汉字以外的字母（拉丁字母等）
const LETTER = /(?!\p{Script=Han})\p{L}/gu
// 「字」：一个汉字算一个，一串连续的其他字母算一个
const WORD = /\p{Script=Han}|(?:(?!\p{Script=Han})\p{L})+(?:['’](?:(?!\p{Script=Han})\p{L})+)*/gu

/** 返回跳过的原因，要翻译时返回 null。 */
export function skipReason(stripped: string, direction: 'en2zh' | 'zh2en'): string | null {
  const han = stripped.match(HAN)?.length ?? 0
  const letters = stripped.match(LETTER)?.length ?? 0
  if (!han && !letters) return '没有文字'
  if ((stripped.match(WORD)?.length ?? 0) < 2) return '太短'
  if (direction === 'en2zh' && han / (han + letters) >= 0.3) return '已是中文'
  if (direction === 'zh2en' && han < 2) return '不是中文'
  return null
}

/**
 * 原文是不是 Koishi 命令（B9，两条都满足才算）：
 * 1. 第一个空白分隔的词（有配置前缀时去掉一个，'/' 只有配置了才去掉）能被 resolve 找到，且不在 notCommands 里（不区分大小写）；
 *    调用方传 ctx.$commander.resolve，不带 session，禁用的别名也算。
 * 2. 整条消息按空白分最多 3 段（中文没有空格时就是一段）。
 */
export function isCommand(text: string, prefixes: string[], resolve: (word: string) => unknown, notCommands: string[] = []): boolean {
  const parts = text.trim().split(/\s+/)
  if (parts.length > 3) return false
  const word = commandWord(text, prefixes)
  if (!word) return false
  const lower = word.toLowerCase()
  if (notCommands.some((w) => w.toLowerCase() === lower)) return false
  try {
    return !!resolve(word)
  } catch {
    return false
  }
}

/** 第一个空白分隔的词；以配置的前缀开头时去掉一个（最长的优先）。 */
export function commandWord(text: string, prefixes: string[]): string {
  let word = text.trim().split(/\s+/)[0] ?? ''
  const sorted = prefixes.filter((p) => typeof p === 'string' && p).sort((a, b) => b.length - a.length)
  for (const prefix of sorted) {
    if (word.startsWith(prefix)) {
      word = word.slice(prefix.length)
      break
    }
  }
  return word
}

/** Koishi 全局配置里的命令前缀（空字符串不算）。 */
export function rootPrefixes(config: any): string[] {
  const raw = config?.prefix
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  return list.filter((p): p is string => typeof p === 'string' && p !== '')
}
