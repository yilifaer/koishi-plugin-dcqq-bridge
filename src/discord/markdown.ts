// Discord 原始 content → 纯文本（清单 §7.1、R15）。自己解析，不经过 h.parse；输出不含 XML。
import { formatTimestamp } from './timestamp'

export interface ContentEnv {
  timeZone: string
  now: number
  userName(id: string): string | undefined
  roleName(id: string): string | undefined
  channelName(id: string): string | undefined
}

// 占位符：受保护的片段（代码、提及、链接、转义字符……）先换成 序号，处理完 Markdown 再换回来
const OPEN = ''
const CLOSE = ''
const SLOT = /(\d+)/g

// 反斜杠后面这些字符按字面输出
const ESCAPABLE = new Set(['*', '#', '_', '~', '|', '>', '<', '`', '\\', '-', '[', ']'])

type Rule = [RegExp, (m: RegExpExecArray, env: ContentEnv) => string]

// 以 `<` 开头的记号。都用 y（sticky）在当前位置匹配
const ANGLE: Rule[] = [
  [/<@!?(\d+)>/y, (m, env) => '@' + (env.userName(m[1]) ?? '用户')],
  [/<@&(\d+)>/y, (m, env) => '@' + (env.roleName(m[1]) ?? '角色')],
  [/<#(\d+)>/y, (m, env) => '#' + (env.channelName(m[1]) ?? '频道')],
  // 自定义表情，名字非贪婪，保证一条消息里两个表情各自匹配
  [/<a?:([^:<>\s]+?):(\d+)>/y, (m) => `[${m[1]}]`],
  [/<t:(-?\d+)(?::([A-Za-z]))?>/y, (m, env) => formatTimestamp(Number(m[1]), m[2], env.timeZone, env.now) ?? m[0]],
  // 斜杠命令提及：</name:id>、</name sub:id>、</name group sub:id>
  [/<\/([^:<>\n]+):(\d+)>/y, (m) => '/' + m[1]],
  [/<id:(?:customize|browse|guide|linked-roles|home)(?::\d+)?>/y, () => '[频道导航]'],
  [/<(https?:\/\/[^\s<>]+)>/y, (m) => m[1]],
]

const LINK = /\[([^\[\]\n]+)\]\(<?(https?:\/\/[^\s()<>]+)>?\)/y
const URL = /https?:\/\/[^\s<>*~|]+/y
const CODE1 = /`([^`]+)`/y
const CODE2 = /``((?:[^`]|`(?!`))+)``/y
const LANG = /^[A-Za-z0-9_+#.-]+\n/

/** 第一遍：扫描原文，把不参与 Markdown 处理的片段换成占位符。 */
function protect(text: string, env: ContentEnv, keep: (s: string) => string): string {
  let out = ''
  let i = 0
  const at = (re: RegExp) => {
    re.lastIndex = i
    return re.exec(text)
  }
  outer: while (i < text.length) {
    const c = text[i]
    if (c === '\\' && i + 1 < text.length && ESCAPABLE.has(text[i + 1])) {
      out += keep(text[i + 1])
      i += 2
      continue
    }
    if (c === OPEN || c === CLOSE) {
      out += keep(c)
      i++
      continue
    }
    if (c === '`') {
      if (text.startsWith('```', i)) {
        const end = text.indexOf('```', i + 3)
        if (end >= 0) {
          let body = text.slice(i + 3, end)
          if (LANG.test(body)) body = body.replace(LANG, '')
          else if (body.startsWith('\n')) body = body.slice(1)
          if (body.endsWith('\n')) body = body.slice(0, -1)
          out += keep(body)
          i = end + 3
          continue
        }
      }
      const m = at(CODE2) ?? at(CODE1)
      if (m) {
        out += keep(m[1])
        i += m[0].length
        continue
      }
      let n = 1
      while (text[i + n] === '`') n++
      out += keep(text.slice(i, i + n))
      i += n
      continue
    }
    if (c === '<') {
      for (const [re, fn] of ANGLE) {
        const m = at(re)
        if (m) {
          out += keep(fn(m, env))
          i += m[0].length
          continue outer
        }
      }
    }
    if (c === '[') {
      const m = at(LINK)
      if (m) {
        // 链接文字本身还要按 Markdown 处理，网址受保护
        out += protect(m[1], env, keep) + ' ' + keep(m[2])
        i += m[0].length
        continue
      }
    }
    if (c === 'h') {
      const m = at(URL)
      if (m) {
        // 网址结尾的 _ 还给正文（例如 __https://…__）
        const url = m[0].replace(/_+$/, '')
        out += keep(url)
        i += url.length
        continue
      }
    }
    out += c
    i++
  }
  return out
}

/** 第二遍：去掉行首标记（引用、标题、小字），保护列表标记。 */
function stripLines(text: string, keep: (s: string) => string): string {
  return text.split('\n').map((line) => {
    line = line.replace(/^>>> /, '').replace(/^> /, '')
    line = line.replace(/^(?:#{1,3}|-#) +/, '')
    // 行首的 `* item`、`- item` 是列表，不是强调
    return line.replace(/^(\s*)\* /, (_, sp: string) => sp + keep('*') + ' ')
  }).join('\n')
}

// 强调：成对的标记去掉，保留中间文字。下划线只在成对包围一个词时才算（前后不能紧贴字母数字），`sov_timer` 不变
const EMPHASIS: [RegExp, string][] = [
  [/\*\*([\s\S]+?)\*\*/g, '$1'],
  [/__([\s\S]+?)__/g, '$1'],
  [/~~([\s\S]+?)~~/g, '$1'],
  [/\|\|([\s\S]+?)\|\|/g, '$1'],
  [/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, '$1'],
  [/(?<![\p{L}\p{N}_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\p{L}\p{N}_])/gu, '$1'],
]

function stripEmphasis(text: string): string {
  for (let round = 0; round < 5; round++) {
    let next = text
    for (const [re, to] of EMPHASIS) next = next.replace(re, to)
    if (next === text) break
    text = next
  }
  return text
}

/** 把一段 Discord 原始 content 渲染成纯文本。 */
export function renderContent(text: string, env: ContentEnv): string {
  if (!text) return ''
  const slots: string[] = []
  const keep = (s: string) => {
    slots.push(s)
    return OPEN + (slots.length - 1) + CLOSE
  }
  let out = protect(text, env, keep)
  out = stripLines(out, keep)
  out = stripEmphasis(out)
  return out.replace(SLOT, (_, n: string) => slots[+n])
}
