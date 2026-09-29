// 占位符保护（清单 §12.1 第 2 步）：不该翻译的片段换成 ⟦0⟧、⟦1⟧…，每一处出现单独编号，翻译后原样放回。

export interface Token {
  token: string
  value: string
}

/** 任何 ⟦…⟧ 形式的占位符（包括术语表的 ⟦G0⟧）。 */
const ANY_TOKEN = /⟦[^⟦⟧\n]*⟧/g

// 原文里本来就有的 ⟦…⟧ 或单个 ⟦、⟧：也保护起来，免得和占位符混淆
const LITERAL = /⟦[^⟦⟧\n]*⟧|[⟦⟧]/g
const URL_RE = /\bhttps?:\/\/[^\s<>⟦⟧]+/gi
// 代号星系、虫洞星系、ISK 数字（清单 §12.1）
const PATTERNS = [
  /\b[A-Z0-9]{1,5}-[A-Z0-9]{1,5}\b/g,
  /\bJ\d{6}\b/g,
  /\d+(?:\.\d+)?\s?[kmb]\b/gi,
]

type Range = [number, number]

function overlaps(ranges: Range[], start: number, end: number) {
  return ranges.some(([s, e]) => start < e && end > s)
}

/** 网址末尾的标点不算网址（括号成对时保留）。 */
function trimUrl(url: string) {
  let out = url.replace(/[.,;:!?'"，。！？、；：]+$/, '')
  while (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
    out = out.slice(0, -1).replace(/[.,;:!?'"，。！？、；：]+$/, '')
  }
  return out
}

export function protect(text: string, spans: string[]): { text: string; tokens: Token[] } {
  const taken: Range[] = []
  const claim = (start: number, end: number) => {
    if (end <= start || overlaps(taken, start, end)) return false
    taken.push([start, end])
    return true
  }
  // 1. 提及、表情、时间等（长的优先，每一处都要）：先占，名字里带 ⟦⟧ 或网址时整段一起保护，不漏出一部分
  const list = [...new Set(spans.filter((s) => s && s.trim()))].sort((a, b) => b.length - a.length)
  for (const span of list) {
    let from = 0
    for (;;) {
      const i = text.indexOf(span, from)
      if (i < 0) break
      claim(i, i + span.length)
      from = i + 1
    }
  }
  // 2. 原文里的 ⟦⟧；3. 网址
  for (const m of text.matchAll(LITERAL)) claim(m.index!, m.index! + m[0].length)
  for (const m of text.matchAll(URL_RE)) claim(m.index!, m.index! + trimUrl(m[0]).length)
  // 4. 其余规则：最左、最长优先
  const found: Range[] = []
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) found.push([m.index!, m.index! + m[0].length])
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  for (const [s, e] of found) claim(s, e)

  taken.sort((a, b) => a[0] - b[0])
  const tokens: Token[] = []
  let out = ''
  let last = 0
  for (const [s, e] of taken) {
    const token = `⟦${tokens.length}⟧`
    tokens.push({ token, value: text.slice(s, e) })
    out += text.slice(last, s) + token
    last = e
  }
  out += text.slice(last)
  return { text: out, tokens }
}

export function restore(text: string, tokens: Array<{ token: string; value: string }>): string {
  const map = new Map(tokens.map((t) => [t.token, t.value]))
  return text.replace(ANY_TOKEN, (m) => map.get(m) ?? m)
}

/** 每个占位符恰好出现一次，没有多出来的 ⟦…⟧，也没有残缺的 ⟦ 或 ⟧。 */
export function tokensIntact(translated: string, tokens: Array<{ token: string }>): boolean {
  const expected = new Map<string, number>()
  for (const { token } of tokens) expected.set(token, (expected.get(token) ?? 0) + 1)
  const seen = new Map<string, number>()
  for (const m of translated.match(ANY_TOKEN) ?? []) {
    if (!expected.has(m)) return false
    seen.set(m, (seen.get(m) ?? 0) + 1)
  }
  for (const [token, count] of expected) if (seen.get(token) !== count) return false
  return !/[⟦⟧]/.test(translated.replace(ANY_TOKEN, ''))
}

export function stripTokens(text: string): string {
  return text.replace(ANY_TOKEN, '').trim()
}
