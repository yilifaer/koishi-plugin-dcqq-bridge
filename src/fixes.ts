// 纠错命令（B14）：在群里或频道里直接加、改、删术语词条，存在 dcqqbridge_glossary 表里，不写 koishi.yml。
// 这里只放解析、判断方向、读写数据表、导出这些不依赖会话的部分；命令本身在 commands.ts 里注册。

import { h } from 'koishi'
import type { Context } from 'koishi'
import yaml from 'js-yaml'
import type { GlossaryMode, SlangEntry } from './glossary'
import type { GlossaryRow } from './store'
import { stripOwnDecorations } from './text/reply'

export type FixDir = 'en2zh' | 'zh2en'

// 用法里不用尖括号：所有者照抄过 `纠错 <原文> = <译法>`，把尖括号也打了进去（T6）
export const FIX_USAGE = [
  '用法：',
  '纠错 原文 = 译法　　　强制替换',
  '纠错 -h 原文 = 译法　只作参考，交给模型决定',
  '纠错 -k 原文　　　　　原样保留，不翻译',
  '纠错 列表　　　　　　列出全部（后面加关键词只列包含它的）',
  '纠错 删除 原文',
  '纠错 导出',
  '例如：纠错 standing fleet = 值守舰队',
  '方向自动判断：原文是英文、译法是中文 → 英译中；反过来 → 中译英。',
].join('\n')

/** 原文、译法的最大字数（数据表字段最长 255）。 */
const MAX_LENGTH = 100
const LATIN = /[A-Za-z]/
const HAN = /\p{Script=Han}/u

export const MODE_TEXT: Record<GlossaryMode, string> = { force: '强制替换', hint: '只作参考', keep: '原样保留' }
export const DIR_TEXT: Record<FixDir, string> = { en2zh: '英译中', zh2en: '中译英' }

export type FixCommand =
  | { kind: 'add'; mode: GlossaryMode; src: string; dst: string; dir: FixDir }
  | { kind: 'list'; keyword: string }
  | { kind: 'delete'; src: string }
  | { kind: 'export' }
  | { kind: 'usage'; reason?: string }

/**
 * 方向：原文有拉丁字母、译法有汉字 → en2zh；原文有汉字、译法有拉丁字母 → zh2en；
 * 两种都说得通（例如原文、译法都中英混写）或者都不是 → null。
 */
export function detectDirection(src: string, dst: string): FixDir | null {
  const en2zh = LATIN.test(src) && HAN.test(dst)
  const zh2en = HAN.test(src) && LATIN.test(dst)
  if (en2zh === zh2en) return null
  return en2zh ? 'en2zh' : 'zh2en'
}

/** -k 的方向只看原文：有汉字 → zh2en（中英混写的词只会出现在中文消息里），否则有拉丁字母 → en2zh。 */
export function keepDirection(src: string): FixDir | null {
  if (HAN.test(src)) return 'zh2en'
  if (LATIN.test(src)) return 'en2zh'
  return null
}

// 用户多打的一对括号（T6）：半角、全角尖括号和书名号
const WRAPPERS: Array<[string, string]> = [['<', '>'], ['＜', '＞'], ['〈', '〉'], ['《', '》']]

/** 原文、译法被一对 `<…>`、`〈…〉`、`《…》` 整个包住时去掉（里面没有别的括号才算整个包住）。 */
export function stripWrapper(text: string): string {
  const t = text.trim()
  for (const [open, close] of WRAPPERS) {
    if (t.length > 2 && t.startsWith(open) && t.endsWith(close)) {
      const inner = t.slice(open.length, -close.length)
      if (!inner.includes(open) && !inner.includes(close) && inner.trim()) return inner.trim()
    }
  }
  return t
}

// Satori 的标准消息元素：这些照常去掉标签只留文字；别的「元素」其实是用户打的尖括号（例如 `<afk cloaker>`）
const KNOWN_ELEMENTS = new Set([
  'at', 'sharp', 'a', 'img', 'image', 'audio', 'video', 'file', 'face', 'emoji', 'quote', 'author', 'br', 'p', 'message',
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'del', 'spl', 'code', 'sup', 'sub', 'button', 'figure', 'record', 'mface',
])
// 排版元素：没有内容时不可能是平台发来的，按用户打的尖括号处理
const FORMAT_ELEMENTS = new Set(['a', 'p', 'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'del', 'spl', 'code', 'sup', 'sub'])

/**
 * 纠错命令收到的内容（消息元素的写法）→ 纯文字。沙盒这类平台不转义用户打的 `<`，
 * `纠错 删除 <afk cloaker>` 到这里就成了一个叫 afk 的元素，直接去标签会变成空内容（T6）；
 * 所以不认识的元素（或者带着没有值的属性）按原样写回尖括号，交给 parseFixText 去掉。
 */
export function fixArgText(content: string): string {
  const render = (el: h): string => {
    if (el.type === 'text') return String(el.attrs.content ?? '')
    const attrs = Object.entries(el.attrs)
    const literal = !KNOWN_ELEMENTS.has(el.type)
      || attrs.some(([, v]) => v === true)
      || (FORMAT_ELEMENTS.has(el.type) && !el.children.length)
    if (!literal) return h('', [el]).toString(true)
    const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
    const attrText = attrs.map(([k, v]) => (v === true ? ` ${kebab(k)}` : ` ${kebab(k)}="${String(v)}"`)).join('')
    return `<${el.type}${attrText}>${el.children.map(render).join('')}`
  }
  return h.parse(content).map(render).join('')
}

/** 解析 `纠错` 后面的整段文字（Koishi 按空格拆参数，这里自己拆：原文、译法里可以有空格）。 */
export function parseFixText(input: string): FixCommand {
  let text = input.replace(/\s+/g, ' ').trim()
  if (!text) return { kind: 'usage' }
  const hasEq = /[=＝]/.test(text)
  // 有等号的一定是添加，所以原文本身叫「列表」「删除」也能加
  if (!hasEq) {
    const [word, ...rest] = text.split(' ')
    const arg = rest.join(' ').trim()
    if (/^(?:列表|list)$/i.test(word)) return { kind: 'list', keyword: arg }
    if (/^(?:删除|delete|del)$/i.test(word)) {
      const src = stripWrapper(arg)
      return src ? { kind: 'delete', src } : { kind: 'usage', reason: '请写要删除的原文。' }
    }
    if (/^(?:导出|export)$/i.test(word)) return { kind: 'export' }
  }
  let mode: GlossaryMode = 'force'
  const flag = /^-([hk])(?: |$)/i.exec(text)
  if (flag) {
    mode = flag[1].toLowerCase() === 'h' ? 'hint' : 'keep'
    text = text.slice(flag[0].length).trim()
  }
  if (mode === 'keep') text = stripWrapper(text)
  if (mode === 'keep') {
    if (hasEq) return { kind: 'usage', reason: '-k 是原样保留，不用写译法。' }
    if (!text) return { kind: 'usage', reason: '请写要原样保留的原文。' }
    if (text.length > MAX_LENGTH) return { kind: 'usage', reason: `原文太长（最多 ${MAX_LENGTH} 个字）。` }
    const dir = keepDirection(text)
    if (!dir) return { kind: 'usage', reason: '原文里没有英文字母或汉字，判断不出方向。' }
    return { kind: 'add', mode, src: text, dst: text, dir }
  }
  const eq = text.search(/[=＝]/)
  if (eq < 0) return { kind: 'usage', reason: '缺少「=」。' }
  const src = stripWrapper(text.slice(0, eq))
  const dst = stripWrapper(text.slice(eq + 1))
  if (!src || !dst) return { kind: 'usage', reason: '「=」两边都要写。' }
  if (/[=＝]/.test(dst)) return { kind: 'usage', reason: '只能有一个「=」。' }
  if (src.length > MAX_LENGTH || dst.length > MAX_LENGTH) return { kind: 'usage', reason: `原文或译法太长（最多 ${MAX_LENGTH} 个字）。` }
  const dir = detectDirection(src, dst)
  if (!dir) return { kind: 'usage', reason: '判断不出方向：原文是英文时译法要有汉字，原文是中文时译法要有英文字母。' }
  return { kind: 'add', mode, src, dst, dir }
}

/** 数据表的主键：方向 + 来源写法。和术语表匹配的规则一样：3 个字母以内区分大小写，其余不区分。 */
export function fixKey(src: string, dir: FixDir): string {
  const letters = (src.match(/[A-Za-z]/g) ?? []).length
  const text = letters <= 3 ? src : src.replace(/[A-Z]+/g, (m) => m.toLowerCase())
  return `${dir}:${text}`
}

/** 一行数据 → 黑话表格式的词条。 */
export function fixToEntry(row: Pick<GlossaryRow, 'src' | 'dst' | 'mode' | 'dir'>): SlangEntry {
  const mode = row.mode as GlossaryMode
  const dir = row.dir as FixDir
  if (mode === 'keep') return { en: row.src, zh: row.src, mode, dir }
  return dir === 'en2zh' ? { en: row.src, zh: row.dst, mode, dir } : { en: row.dst, zh: row.src, mode, dir }
}

/** 读出全部纠错词条（按添加时间排序）。 */
export async function loadFixRows(ctx: Context): Promise<GlossaryRow[]> {
  const rows = await ctx.database.get('dcqqbridge_glossary', {})
  return rows.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))
}

/** `standing fleet → 值守舰队（强制替换，英译中）`；keep 只写原文。 */
export function describeFix(row: Pick<GlossaryRow, 'src' | 'dst' | 'mode' | 'dir'>): string {
  const what = `${MODE_TEXT[row.mode as GlossaryMode] ?? row.mode}，${DIR_TEXT[row.dir as FixDir] ?? row.dir}`
  return row.mode === 'keep' ? `${row.src}（${what}）` : `${row.src} → ${row.dst}（${what}）`
}

/** 控制台 overrides 里有同一个来源写法（同方向或 both）的那条；有的话以控制台为准。 */
export function consoleConflict(
  row: Pick<GlossaryRow, 'src' | 'dir'>,
  overrides: Array<{ en: string; zh: string; dir: string }>,
): { en: string; zh: string } | undefined {
  const key = fixKey(row.src.trim(), row.dir as FixDir)
  return overrides.find((o) => {
    if (o.dir !== 'both' && o.dir !== row.dir) return false
    const source = row.dir === 'en2zh' ? o.en : o.zh
    return typeof source === 'string' && fixKey(source.trim(), row.dir as FixDir) === key
  })
}

/** 全部词条写成黑话表格式的 YAML（可以直接并进黑话表）。 */
export function fixesToYaml(rows: GlossaryRow[], stamp: string): string {
  const entries = rows.map((row) => {
    const entry = fixToEntry(row)
    return { en: entry.en, zh: entry.zh, mode: entry.mode, dir: entry.dir }
  })
  const head = `# 纠错命令加的词条，导出时间 ${stamp}。格式和黑话表相同，可以整段复制进黑话表。\n`
  return head + yaml.dump(entries, { lineWidth: -1, quotingType: '"' })
}

/**
 * 从被回复的转发消息里取回原文：去掉开头的 @全体 / 【全体通知】、`[桥名 - 名字]`、引用行，
 * 再去掉最后「空一行 + 译文标注」开始的译文。
 */
export function originalOfForwarded(text: string, opts: { label: string; fallbackText: string }): string {
  let rest = stripOwnDecorations(text.replace(/\r\n/g, '\n'), { fallbackText: opts.fallbackText })
  const label = opts.label.trim()
  if (label) {
    // Discord 那边标注里的符号可能被转义过（例如 `\*`），两种写法都找
    const escaped = label.replace(/[\\*_~`|>#[\]()-]/g, '\\$&')
    const at = Math.max(rest.lastIndexOf(`\n\n${label}`), rest.lastIndexOf(`\n\n${escaped}`))
    if (at >= 0) rest = rest.slice(0, at)
  }
  return rest.trim()
}
