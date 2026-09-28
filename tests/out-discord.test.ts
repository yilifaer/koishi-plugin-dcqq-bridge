import { describe, expect, it } from 'vitest'
import { buildDiscordContents, escapeDiscord, webhookUsername } from '../src/out/discord'

const Z = '​'

describe('escapeDiscord', () => {
  it('提及、@everyone、@here 被零宽空格打断', () => {
    expect(escapeDiscord('<@123> <@!123> <@&123> <#456> <t:1:F> <:x:1> <a:y:2>')).toBe(
      `<${Z}@123> <${Z}@!123> <${Z}@&123> <${Z}#456> <${Z}t:1:F> <${Z}:x:1> <${Z}a:y:2>`,
    )
    expect(escapeDiscord('@everyone @here')).toBe(`@${Z}everyone @${Z}here`)
  })

  it('Markdown 字符加反斜杠，行首 # > - 加反斜杠', () => {
    expect(escapeDiscord('a*b_c~d`e|f[g]h\\i')).toBe('a\\*b\\_c\\~d\\`e\\|f\\[g\\]h\\\\i')
    expect(escapeDiscord('# 标题\n> 引用\n- 列表\n  - 缩进\na - b # c')).toBe('\\# 标题\n\\> 引用\n\\- 列表\n  \\- 缩进\na - b # c')
  })

  it('网址不转义（R16），网址外的仍然转义', () => {
    const url = 'https://example.com/a_b*c?x=1_2'
    expect(escapeDiscord(`看 ${url} *粗*`)).toBe(`看 ${url} \\*粗\\*`)
    expect(escapeDiscord(`${url}<@1>`)).toBe(`${url}<${Z}@1>`)
    expect(escapeDiscord(`- x\n${url}\n# y`)).toBe(`\\- x\n${url}\n\\# y`)
  })

  it('普通的 < 不变', () => {
    expect(escapeDiscord('price < 5b and > 3b')).toBe('price < 5b and > 3b')
  })
})

describe('buildDiscordContents', () => {
  it('webhook 模式：只有转义后的正文', () => {
    expect(buildDiscordContents({ prefix: '', text: '<@123> hi' })).toEqual([`<${Z}@123> hi`])
  })

  it('机器人模式前缀每段都有，引用行只在第一段，译文附在后面', () => {
    const out = buildDiscordContents({ prefix: '[测试桥 - 小红]', replyLine: '↪ 回复 A：x', text: '正文', translation: '【机翻】y' })
    expect(out).toEqual(['\\[测试桥 - 小红\\] ↪ 回复 A：x\n正文\n\n【机翻】y'])
    const long = buildDiscordContents({ prefix: '[测试桥 - 小红]', replyLine: '↪ 回复 A：x', text: 'x '.repeat(1500) })
    expect(long.length).toBe(2)
    expect(long.every((s) => s.startsWith('\\[测试桥 - 小红\\] '))).toBe(true)
    expect(long[1].includes('↪')).toBe(false)
  })

  it('2000 个 ( 转义后每段不超过 2000', () => {
    const out = buildDiscordContents({ prefix: '', text: '('.repeat(2000) })
    for (const s of out) expect(s.length).toBeLessThanOrEqual(2000)
    expect(out.join('')).toBe('('.repeat(2000))
  })

  it('2000 个 * 转义后翻倍，仍然每段不超过 2000', () => {
    const out = buildDiscordContents({ prefix: '[桥 - 名]', text: '*'.repeat(2000) })
    for (const s of out) expect(s.length).toBeLessThanOrEqual(2000)
    expect(out.map((s) => s.slice('\\[桥 - 名\\] '.length)).join('')).toBe('\\*'.repeat(2000))
  })

  it('1990 字、满是 @everyone：每段不超长，都被转义', () => {
    const text = '@everyone '.repeat(199)
    expect(text.length).toBe(1990)
    for (const prefix of ['', '[测试桥 - 小红]']) {
      const out = buildDiscordContents({ prefix, text })
      expect(out.length).toBeGreaterThan(1)
      for (const s of out) {
        expect(s.length).toBeLessThanOrEqual(2000)
        expect(s).not.toMatch(/@everyone/)
      }
    }
  })

  it('硬切不切开代理对，也不切开转义', () => {
    const text = '😀*'.repeat(1000)
    const out = buildDiscordContents({ prefix: '', text })
    for (const s of out) {
      expect(s.length).toBeLessThanOrEqual(2000)
      expect(/[\uD800-\uDBFF]$/.test(s) || /^[\uDC00-\uDFFF]/.test(s)).toBe(false)
      expect(/(^|[^\\])(\\\\)*\\$/.test(s)).toBe(false)
      expect(s.replace(/\\\*/g, '')).not.toContain('*')
    }
    expect(out.join('')).toBe(escapeDiscord(text))
  })

  it('没有正文：只有前缀/引用行时返回一条，都没有返回 []', () => {
    expect(buildDiscordContents({ prefix: '', text: '' })).toEqual([])
    expect(buildDiscordContents({ prefix: '[小红]', text: '' })).toEqual(['\\[小红\\]'])
    expect(buildDiscordContents({ prefix: '', replyLine: '↪ 回复 A：x', text: '  ' })).toEqual(['↪ 回复 A：x'])
  })
})

describe('webhookUsername', () => {
  it('格式和桥名', () => {
    expect(webhookUsername('测试桥', '小红')).toBe('[测试桥] 小红')
    expect(webhookUsername('', '小红')).toBe('小红')
  })
  it('拆开 discord / clyde（不区分大小写）', () => {
    expect(webhookUsername('', 'Discord 粉丝')).toBe(`Disc${Z}ord 粉丝`)
    expect(webhookUsername('', 'CLYDE')).toBe(`CL${Z}YDE`)
    expect(webhookUsername('discord', 'x').toLowerCase()).not.toContain('discord')
  })
  it('全是空白时用 QQ用户', () => {
    expect(webhookUsername('', '   ')).toBe('QQ用户')
    expect(webhookUsername('  ', '\t')).toBe('QQ用户')
    expect(webhookUsername('测试桥', ' ')).toBe('[测试桥] QQ用户')
  })
  it('最多 80 个字符，不切开代理对', () => {
    expect(webhookUsername('', 'a'.repeat(100))).toHaveLength(80)
    const s = webhookUsername('', 'a' + '😀'.repeat(50))
    expect(s.length).toBeLessThanOrEqual(80)
    expect(/[\uD800-\uDBFF]$/.test(s)).toBe(false)
  })
})
