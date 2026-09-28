// 长文字分段（清单 §10 第 2 条、R16）。长度按 UTF-16 码元（String.length）计算。

const SENTENCE_END = new Set(['。', '！', '？', '.', '!', '?'])
const ASCII_END = new Set(['.', '!', '?'])

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff

/**
 * 从开头切下一段（不超过 limit），返回 [这一段, 剩下的]。
 * 切点优先级：空行 → 换行 → 句末（。！？.!?）→ 空格 → 硬切。只去掉切点处的空行/换行/空格本身。
 */
export function takePiece(text: string, limit: number): [string, string] {
  limit = Math.max(1, Math.floor(limit))
  if (text.length <= limit) return [text, '']
  // 空行：'\n\n' 的起点 ≤ limit
  const blank = text.lastIndexOf('\n\n', limit)
  if (blank > 0) return [text.slice(0, blank), text.slice(blank + 2)]
  const window = text.slice(0, limit + 1)
  const newline = window.lastIndexOf('\n')
  if (newline > 0) return [text.slice(0, newline), text.slice(newline + 1)]
  // 句末：标点留在这一段里；英文标点要求后面是空白（避免切开 3.5、网址），顺带去掉后面那一个空格
  for (let i = limit - 1; i > 0; i--) {
    const ch = text[i]
    if (!SENTENCE_END.has(ch)) continue
    const next = text[i + 1]
    if (ASCII_END.has(ch) && next !== undefined && next !== ' ' && next !== '\t') continue
    return [text.slice(0, i + 1), next === ' ' ? text.slice(i + 2) : text.slice(i + 1)]
  }
  const space = window.lastIndexOf(' ')
  if (space > 0) return [text.slice(0, space), text.slice(space + 1)]
  // 硬切，不切开代理对
  let cut = limit
  if (isHigh(text.charCodeAt(cut - 1))) cut = cut > 1 ? cut - 1 : cut + 1
  return [text.slice(0, cut), text.slice(cut)]
}

/** 切成若干段，每段不超过 limit（firstLimit 只用于第一段）；不产生空段。 */
export function splitText(text: string, limit: number, firstLimit = limit): string[] {
  const out: string[] = []
  let rest = text
  while (rest) {
    const [piece, remainder] = takePiece(rest, out.length ? limit : firstLimit)
    if (piece) out.push(piece)
    rest = remainder
  }
  return out
}

/** 截取前 n 个字符（按码点），被截断时加 `…`。 */
export function truncate(text: string, n: number): string {
  const chars = Array.from(text)
  return chars.length > n ? chars.slice(0, n).join('') + '…' : text
}

/** 截到最多 n 个 UTF-16 码元，不切开代理对。 */
export function cutUnits(text: string, n: number): string {
  if (text.length <= n) return text
  let cut = n
  if (cut > 0 && isHigh(text.charCodeAt(cut - 1))) cut--
  return text.slice(0, cut)
}
