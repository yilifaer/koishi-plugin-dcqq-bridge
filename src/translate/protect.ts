// 占位符保护（清单 §12.1 第 2 步）：不该翻译的片段换成 ⟦0⟧、⟦1⟧…，每一处出现单独编号，翻译后原样放回。

export interface Token {
  token: string
  value: string
  /** 这个占位符是网址（U8：还原时两边按需补空格）。 */
  url?: boolean
}

/** 任何 ⟦…⟧ 形式的占位符（包括术语表的 ⟦G0⟧）。 */
const ANY_TOKEN = /⟦[^⟦⟧\n]*⟧/g

// 原文里本来就有的 ⟦…⟧ 或单个 ⟦、⟧：也保护起来，免得和占位符混淆
const LITERAL = /⟦[^⟦⟧\n]*⟧|[⟦⟧]/g
// 网址遇到第一个非 ASCII 字符（例如紧跟的中文）就结束（B5）
const URL_RE = /\bhttps?:\/\/[\x21-\x3b\x3d\x3f-\x7e]+/gi
// 代号星系、虫洞星系、ISK 数字（清单 §12.1）
const PATTERNS = [
  /\b[A-Z0-9]{1,5}-[A-Z0-9]{1,5}\b/g,
  /\bJ\d{6}\b/g,
  /\d+(?:\.\d+)?\s?[kmb]\b/gi,
  // @everyone、@here 文字（B12）：和提及一样原样保留
  /@(?:everyone|here)(?![\p{L}\p{N}_])/giu,
]

export type Range = [number, number]

/** 标签的比较形式（B10）：去掉 Markdown 的 `*`、`_` 和末尾冒号，连续空白合成一个，小写。 */
export function normalizeLabel(label: string): string {
  return label.replace(/[*_]/g, '').replace(/[:：]+\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

// 行首「标签 + 冒号」：前面可以有空白、列表符号 `-`/`•` 和粗体、斜体标记（`**FC Name:** 某人`、`**FC Name**: 某人`）。
// 标签必须以字母、汉字或数字开头，并且只看每行前 200 个字符（T4：只有空格、`*`、`_` 的长行不会让正则回溯很久）；
// 冒号后面的值不用正则取，直接截到行尾
const LABEL_HEAD = /^[\s*_]*(?:[-•][\s*_]+)?([\p{L}\p{N}][^:：\n]{0,59}?)[\s*_]*[:：]/u
const HEAD_LIMIT = 200
const HAN_CHAR = /\p{Script=Han}/gu

/** 词数（T2）：每个汉字算一个词，其余部分按空白分开，含字母或数字的一段算一个词。 */
export function countWords(text: string): number {
  const han = text.match(HAN_CHAR)?.length ?? 0
  const rest = text.replace(HAN_CHAR, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  return han + rest
}

/** 值很短（T2）：不超过 5 个词，并且不超过 40 个字符。 */
function isShortValue(value: string): boolean {
  return value.length <= 40 && countWords(value) <= 5
}

/** 一行里「标签：值」的标签和值的位置（相对行首）；不是这种行时返回 null。 */
function labelLine(line: string): { label: string; start: number; end: number } | null {
  const m = LABEL_HEAD.exec(line.slice(0, HEAD_LIMIT))
  if (!m) return null
  let start = m[0].length
  while (start < line.length && /[\s*_]/.test(line[start])) start++
  let end = line.length
  while (end > start && /\s/.test(line[end - 1])) end--
  if (end <= start) return null
  return { label: m[1], start, end }
}

/**
 * 不翻译的范围（B10）：
 * - 某一行以列表里的标签 + 冒号开头：冒号后面到行尾（去掉行尾空白）。只在像 ping 的消息里生效（T2）：
 *   同一条消息里至少有 2 行命中列表里的标签，或者这个值很短（不超过 5 个词、40 个字符）；
 *   否则是普通聊天（例如 `FC: everyone align to the sun`），照常翻译；
 * - embed 字段名在列表里：整个字段值（fields 是字段值在 text 里的位置，由渲染时给出）。
 */
export function keepValueRanges(text: string, labels: string[], fields: Array<{ name: string; start: number; end: number }> = []): Range[] {
  if (!labels.length) return []
  const set = new Set(labels)
  const out: Range[] = []
  for (const f of fields) {
    if (set.has(normalizeLabel(f.name)) && f.end > f.start && text.slice(f.start, f.end).trim()) out.push([f.start, f.end])
  }
  const hits: Array<{ range: Range; short: boolean }> = []
  let offset = 0
  for (const line of text.split('\n')) {
    const m = labelLine(line)
    if (m && set.has(normalizeLabel(m.label))) {
      hits.push({ range: [offset + m.start, offset + m.end], short: isShortValue(line.slice(m.start, m.end)) })
    }
    offset += line.length + 1
  }
  for (const h of hits) if (hits.length >= 2 || h.short) out.push(h.range)
  return out
}

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

/** keep：必须整段保护的范围（B10 标签后面的值），最先占用。 */
export function protect(text: string, spans: string[], keep: Range[] = []): { text: string; tokens: Token[] } {
  const taken: Range[] = []
  const claim = (start: number, end: number) => {
    if (end <= start || overlaps(taken, start, end)) return false
    taken.push([start, end])
    return true
  }
  for (const [s, e] of [...keep].sort((a, b) => a[0] - b[0] || b[1] - a[1])) claim(s, e)
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
  const urls = new Set<number>()
  for (const m of text.matchAll(URL_RE)) if (claim(m.index!, m.index! + trimUrl(m[0]).length)) urls.add(m.index!)
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
    tokens.push(urls.has(s) ? { token, value: text.slice(s, e), url: true } : { token, value: text.slice(s, e) })
    out += text.slice(last, s) + token
    last = e
  }
  out += text.slice(last)
  return { text: out, tokens }
}

// 汉字和中文标点（全角标点、CJK 标点、中文引号、省略号、破折号等）
const CJK_EDGE = /[\p{Script=Han}\u3000-\u303f\uff00-\uffef“”‘’…—·]/u
const HAN_EDGE = /\p{Script=Han}/u
// 英文字母或数字（U3）
const ALNUM = /[A-Za-z0-9]/
// 英文复数词尾，后面是词边界（U3：`⟦G0⟧s` → `Fuel Blocks`，不补空格）
const PLURAL = /^(?:es|s)(?![A-Za-z0-9])/

/**
 * 还原被保护的内容。网址（U8）还原后不能和旁边的字粘在一起，否则 QQ 会把后面的字也算进链接：
 * 网址后面紧跟的不是空白或行尾，补一个空格（英文标点 `.,;:!?'")]>` 除外：保护时本来就不算进网址，原文里也是这样紧挨着的）；
 * 前面紧挨着汉字或全角标点，也补一个空格。其他占位符原样放回。
 */
export function restore(text: string, tokens: Array<{ token: string; value: string; url?: boolean }>): string {
  const map = new Map(tokens.map((t) => [t.token, t]))
  return text.replace(ANY_TOKEN, (m, offset: number) => {
    const t = map.get(m)
    if (!t) return m
    if (!t.url) return t.value
    const before = offset > 0 && CJK_EDGE.test(text[offset - 1]) ? ' ' : ''
    const next = text[offset + m.length]
    const after = next !== undefined && !/[\s.,;:!?'")\]>]/.test(next) ? ' ' : ''
    return before + t.value + after
  })
}

/**
 * 还原术语表的占位符（T7）：换进去的是中文、并且这一侧隔着空格紧挨着汉字或中文标点时，去掉这一侧的空格
 * （「当心，⟦G0⟧ 在我们的本星系」→「当心，墩子在我们的本星系」）。只去掉空格和制表符，不跨行；
 * 换进去的是英文、旁边是被保护的内容（还没还原的 ⟦0⟧ 等）时，空格照旧。
 * 两个术语之间只隔着空格时（U11），紧挨空格两边的字都是汉字就去掉空格（「长须鲸级 被抓」→「长须鲸级被抓」），
 * 否则保留（「FRT 舰队」）。
 * 换进去的是英文、这一侧紧挨着英文字母或数字、中间没有空格时（U3），补一个空格（「AAA⟦G0⟧」→「AAA Fuel Block」）；
 * 右侧紧跟的是复数词尾 s/es 并且后面是词边界时不补（「⟦G0⟧s」→「Fuel Blocks」）。
 */
export function restoreTerms(text: string, tokens: Array<{ token: string; value: string }>): string {
  const map = new Map(tokens.map((t) => [t.token, t.value]))
  let out = ''
  let last = 0
  let skipFrom = -1
  // 上一个换进去的术语在 out 里的结束位置：两个术语之间的空格只在两边都是汉字时去掉（U11）
  let termEnd = -1
  for (const m of text.matchAll(ANY_TOKEN)) {
    const value = map.get(m[0])
    if (value === undefined) continue
    let between = text.slice(last, m.index!)
    if (skipFrom === last) between = between.replace(/^[ \t]+/, '')
    // 左侧：中文术语前面是「汉字/中文标点 + 空格」
    if (HAN_EDGE.test(value[0] ?? '')) {
      const joined = out + between
      const trimmed = joined.replace(/[ \t]+$/, '')
      const edge = trimmed.at(-1) ?? ''
      const afterTerm = trimmed.length === termEnd
      if (trimmed !== joined && (afterTerm ? HAN_EDGE.test(edge) : CJK_EDGE.test(edge))) {
        out = trimmed
        between = ''
      }
    }
    // U3：英文术语左边紧挨着英文字母或数字
    if (ALNUM.test(value[0] ?? '') && ALNUM.test((out + between).at(-1) ?? '')) between += ' '
    out += between + value
    termEnd = out.length
    last = m.index! + m[0].length
    skipFrom = -1
    // 右侧：中文术语后面是「空格 + 汉字/中文标点」
    if (HAN_EDGE.test(value.at(-1) ?? '')) {
      let k = last
      while (text[k] === ' ' || text[k] === '\t') k++
      if (k > last && CJK_EDGE.test(text[k] ?? '')) skipFrom = last
    }
    // U3：英文术语右边紧挨着英文字母或数字（复数词尾除外）；右边是另一个术语时由它的左侧判断
    if (ALNUM.test(value.at(-1) ?? '') && ALNUM.test(text[last] ?? '') && !PLURAL.test(text.slice(last))) out += ' '
  }
  let rest = text.slice(last)
  if (skipFrom === last) rest = rest.replace(/^[ \t]+/, '')
  return out + rest
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
