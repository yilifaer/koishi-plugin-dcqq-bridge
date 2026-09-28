// 发往 Discord 的文字（清单 §8.2、§8.3、R16）：转义、分段、webhook 用户名。

import { cutUnits, takePiece } from '../text/split'

export const DISCORD_LIMIT = 2000
const ZWSP = '​'

// 网址不转义（R16）。和 Discord 一样，网址在 `<` 处结束
const URL = /https?:\/\/[^\s<]+/g

function escapePlain(text: string, lineStart: boolean): string {
  let s = text.replace(/[\\*_~`|[\]]/g, '\\$&')
  // 行首的 # > -（允许前面有空格）
  s = s.replace(/(^|\n)([ \t]*)([#>-])/g, (m, br: string, sp: string, ch: string, offset: number) =>
    offset === 0 && !br && !lineStart ? m : `${br}${sp}\\${ch}`,
  )
  s = s.replace(/@(everyone|here)/gi, `@${ZWSP}$1`)
  s = s.replace(/<(?=@|#|t:|:|a:)/g, `<${ZWSP}`)
  return s
}

/** 按 §8.3 转义。网址原样保留。 */
export function escapeDiscord(text: string): string {
  let out = ''
  let last = 0
  for (const m of text.matchAll(URL)) {
    const index = m.index!
    const before = text.slice(last, index)
    out += escapePlain(before, last === 0 || text[last - 1] === '\n')
    out += m[0]
    last = index + m[0].length
  }
  out += escapePlain(text.slice(last), last === 0 || text[last - 1] === '\n')
  return out
}

// 按转义后的长度切：先按预算切，转义后超长的就缩小预算重切（转义最多让长度翻倍，所以一定能收敛）
function splitEscaped(text: string, firstBudget: number, restBudget: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest) {
    const budget = out.length ? restBudget : firstBudget
    let limit = budget
    for (;;) {
      const [piece, remainder] = takePiece(rest, limit)
      const escaped = escapeDiscord(piece)
      if (escaped.length <= budget || limit <= 1) {
        if (piece) out.push(escaped)
        rest = remainder
        break
      }
      limit = Math.max(1, Math.min(limit - 1, Math.floor((limit * budget) / escaped.length)))
    }
  }
  return out
}

export interface DiscordContentInput {
  /** 机器人模式 `[桥名 - 名字]`；webhook 模式为空。 */
  prefix: string
  replyLine?: string
  text: string
  /** PR 2：译文。 */
  translation?: string
  limit?: number
}

/**
 * 每次发送的 content（已转义、已加前缀，每条不超过 limit）。
 * 正文为空时：有前缀或引用行就返回只含它们的一条（给只有文件的消息用），否则返回 []。
 */
export function buildDiscordContents(input: DiscordContentInput): string[] {
  const limit = input.limit ?? DISCORD_LIMIT
  const body = [input.text, input.translation ?? ''].filter((s) => s.trim() !== '').map((s) => s.trimEnd()).join('\n\n')
  const trimmed = input.prefix.trimEnd()
  const prefix = trimmed ? escapeDiscord(trimmed) + ' ' : ''
  const reply = input.replyLine ? escapeDiscord(input.replyLine) + '\n' : ''

  const pieces = splitEscaped(body, Math.max(4, limit - prefix.length - reply.length), Math.max(4, limit - prefix.length))
  if (!pieces.length) {
    const only = (prefix + reply).trimEnd()
    return only ? [cutUnits(only, limit)] : []
  }
  return pieces.map((piece, index) => prefix + (index === 0 ? reply : '') + piece)
}

/** webhook 用户名（§8.2）：`[桥名] 名字`；拆开 discord / clyde；为空用 `QQ用户`；最多 80 个字符。 */
export function webhookUsername(label: string, name: string): string {
  const who = name.trim() || 'QQ用户'
  let s = label.trim() ? `[${label.trim()}] ${who}` : who
  s = s.replace(/(disc)(ord)/gi, `$1${ZWSP}$2`).replace(/(cl)(yde)/gi, `$1${ZWSP}$2`)
  s = cutUnits(s.trim(), 80).trim()
  return s || 'QQ用户'
}
