// PR B：B10 标签后面的值不翻译、B11 零宽字符、B12 @everyone/@here 不翻译。翻译用模拟服务器，名字全部是编造的。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeSettings } from '../src/bridges'
import { renderDiscordMessage, type RawMessage, type RenderOptions } from '../src/discord/render'
import { stripZeroWidth } from '../src/text/invisible'
import { keepValueRanges, protect } from '../src/translate/protect'
import { baseConfig, bridge, Env, PR2_DEFAULTS, QQ_GROUP, qqPayload, setup } from './harness'

// 模拟翻译：所有英文词变成大写，前面加「译：」；占位符原样返回
class FakeLLM {
  server!: http.Server
  base = ''
  chat: any[] = []

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        this.chat.push({ json })
        const user = json.messages?.at(-1)?.content ?? ''
        const text = /<text>([\s\S]*)<\/text>/.exec(user)?.[1] ?? ''
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `译：${text.replace(/[A-Za-z]+/g, (w) => w.toUpperCase())}` } }] }))
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`
  }

  stop() {
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  /** 最近一次请求里发给模型的文字。 */
  lastText() {
    const user = this.chat.at(-1)?.json.messages?.at(-1)?.content ?? ''
    return /<text>([\s\S]*)<\/text>/.exec(user)?.[1] ?? ''
  }
}

const LABELS = 'FC;;FC Name;;Fleet Commander;;Fleet Name;;Comms;;Formup Location'

// ------------------------------------------------------------------ 单元

describe('B10：keepValueRanges', () => {
  const labels = normalizeSettings(baseConfig({ translate: { ...PR2_DEFAULTS.translate, keepValueLabels: ` ${LABELS};;fc ` } })).translate.keepValueLabels
  const kept = (text: string) => keepValueRanges(text, labels).map(([s, e]) => text.slice(s, e))

  it('配置解析：;; 分隔、去空白、小写、去重；默认空', () => {
    expect(labels).toEqual(['fc', 'fc name', 'fleet commander', 'fleet name', 'comms', 'formup location'])
    expect(normalizeSettings(baseConfig()).translate.keepValueLabels).toEqual([])
  })

  it('行首「标签 + 冒号」：冒号后面到行尾；全角冒号、大小写、多余空白都认', () => {
    expect(kept('FC Name: Vexo Tarrin')).toEqual(['Vexo Tarrin'])
    expect(kept('  fc   name ：Vexo Tarrin  ')).toEqual(['Vexo Tarrin'])
    expect(kept('Comms: Op 11\nNotes: bring cap boosters')).toEqual(['Op 11'])
    expect(kept('FLEET NAME:Grey Lantern Roam')).toEqual(['Grey Lantern Roam'])
  })

  it('粗体、列表符号：`**FC Name:** x`、`**FC Name**: x`、`- Comms: x`', () => {
    expect(kept('**FC Name:** Vexo Tarrin')).toEqual(['Vexo Tarrin'])
    expect(kept('**FC Name**: Vexo Tarrin')).toEqual(['Vexo Tarrin'])
    expect(kept('- Comms: Op 11')).toEqual(['Op 11'])
  })

  it('不在列表里的标签、不在行首、冒号后面为空：不保护；列表为空时什么都不保护', () => {
    expect(kept('Doctrine: Shield Ferox')).toEqual([])
    expect(kept('Ping from FC Name: someone')).toEqual([])
    expect(kept('FC Name:')).toEqual([])
    expect(keepValueRanges('FC Name: Vexo Tarrin', [])).toEqual([])
  })

  it('embed 字段：字段名在列表里时整段字段值保护（字段名可以带粗体和冒号）', () => {
    const text = 'Fleet Commander\n\nVexo Tarrin\n\nShips\n\nBring shield ships'
    const fields = [
      { name: '**Fleet Commander:**', start: 17, end: 28 },
      { name: 'Ships', start: 37, end: 55 },
    ]
    expect(keepValueRanges(text, labels, fields).map(([s, e]) => text.slice(s, e))).toEqual(['Vexo Tarrin'])
  })

  it('protect：保护范围最先占用，范围里的提及、网址不再单独编号', () => {
    const text = 'FC Name: @飞行员 https://example.com/x\nform up'
    const out = protect(text, ['@飞行员'], keepValueRanges(text, labels))
    expect(out.text).toBe('FC Name: ⟦0⟧\nform up')
    expect(out.tokens).toEqual([{ token: '⟦0⟧', value: '@飞行员 https://example.com/x' }])
  })
})

describe('B12：@everyone、@here 作为占位符', () => {
  it('每一处都保护，大小写不限；邮箱、单词中间的不算', () => {
    const out = protect('@everyone form up, @here too, @Everyone again', [])
    expect(out.tokens.map((t) => t.value)).toEqual(['@everyone', '@here', '@Everyone'])
    expect(protect('@hereford is a town', []).tokens).toEqual([])
  })
})

describe('B11：stripZeroWidth', () => {
  it('删掉 U+200B、U+200C、U+200D、U+2060、U+FEFF', () => {
    expect(stripZeroWidth('P‍A﻿P​ ‌Type⁠')).toBe('PAP Type')
    expect(stripZeroWidth('‍‍开头和结尾‍')).toBe('开头和结尾')
  })

  it('夹在两个 emoji 之间的 U+200D（组合 emoji）保留，包括变体选择符和肤色', () => {
    const family = '👨‍👩‍👧'
    const flag = '🏳️‍🌈'
    const skin = '👍🏽‍❤️'
    expect(stripZeroWidth(`${family} ${flag} ${skin}`)).toBe(`${family} ${flag} ${skin}`)
    // emoji 和字母之间的不保留
    expect(stripZeroWidth('😀‍abc‍😀')).toBe('😀abc😀')
  })

  it('渲染：正文、embed、作者名、回复引用、翻译输入、保护列表里都没有零宽字符', () => {
    const opts: RenderOptions = { timeZone: 'Asia/Shanghai', now: Date.UTC(2026, 8, 25), roleName: () => undefined, channelName: () => undefined }
    const d: RawMessage = {
      id: '900', channel_id: '800', guild_id: '700', type: 19,
      author: { id: '101', username: 'x', global_name: 'Wing​man' },
      content: '‍PAP‍ Type: Strategic <@102> 👨‍👩‍👧',
      mentions: [{ id: '102', username: 'p﻿ilot' }],
      embeds: [{ title: 'Fl​eet', fields: [{ name: 'Comms⁠', value: 'Op‌ 11' }] }],
      referenced_message: { id: '899', channel_id: '800', author: { id: '103', username: 'y' }, content: 'ear‍lier' },
    }
    const m = renderDiscordMessage(d, opts)!
    const all = [m.body, ...m.blocks, m.author, m.reply!.content, m.translatable!, ...m.protect!].join('\n')
    expect(all).not.toMatch(/[​‌⁠﻿]|[^👨👩]‍|‍[^👩👧]/u)
    expect(m.body).toBe('PAP Type: Strategic @pilot 👨‍👩‍👧')
    expect(m.author).toBe('Wingman')
    expect(m.protect).toContain('@pilot')
    expect(m.fields).toEqual([{ name: 'Comms', start: m.translatable!.indexOf('Op 11'), end: m.translatable!.indexOf('Op 11') + 5 }])
  })
})

// ------------------------------------------------------------------ 转发

describe('转发：B10、B11、B12', () => {
  let env: Env | undefined
  let llm: FakeLLM

  beforeEach(async () => {
    llm = new FakeLLM()
    await llm.start()
  })
  afterEach(async () => {
    await env?.stop()
    env = undefined
    await llm.stop()
  })

  const on = (keepValueLabels = LABELS) => ({
    bridges: [bridge({ translate: true })],
    translate: { ...PR2_DEFAULTS.translate, enabled: true, baseURL: llm.base, apiKey: 'test-key', model: 'test-model', timeoutMs: 800, keepValueLabels },
    filter: { ...PR2_DEFAULTS.filter },
    glossary: { ...PR2_DEFAULTS.glossary },
  })

  it('B10：system 提示词里有「人名、军团联盟名、舰队制式名、语音频道名不翻译」的规则', async () => {
    env = await setup(on())
    env.discordMessage({ content: 'Fleet forms in Jita tonight' })
    await env.idle()
    const system = llm.chat[0].json.messages[0].content
    expect(system).toContain('玩家和角色名、军团和联盟名及其简称、舰队制式名、语音频道名一律不翻译、不音译，原样保留')
  })

  it('B10：FC Name、Comms 后面的值不发给模型、原样还原；其他行照常翻译', async () => {
    env = await setup(on())
    env.discordMessage({ content: '**FC Name:** Vexo Tarrin\nComms: Op 11\nNotes: bring cap boosters' })
    await env.idle()
    const sent = llm.lastText()
    expect(sent).not.toContain('Vexo')
    expect(sent).not.toContain('Op 11')
    expect(sent).toContain('Notes: bring cap boosters')
    const out = env.qq.text(QQ_GROUP)[0]
    expect(out).toContain('【机翻】 译：FC NAME: Vexo Tarrin\nCOMMS: Op 11\nNOTES: BRING CAP BOOSTERS')
  })

  it('B10：没有设置标签（默认）时照常整段翻译', async () => {
    env = await setup(on(''))
    env.discordMessage({ content: 'FC Name: Vexo Tarrin\nComms: Op 11' })
    await env.idle()
    expect(llm.lastText()).toContain('Vexo Tarrin')
    expect(env.qq.text(QQ_GROUP)[0]).toContain('FC NAME: VEXO TARRIN')
  })

  it('B10：embed 字段名在列表里 → 整个字段值不翻译；其他字段照常', async () => {
    env = await setup(on())
    env.discordMessage({
      content: '',
      embeds: [{
        type: 'rich',
        title: 'Fleet ping',
        fields: [
          { name: 'Fleet Commander', value: 'Vexo Tarrin' },
          { name: '**Fleet Name**', value: 'Grey Lantern\nRoam' },
          { name: 'Ships', value: 'Bring shield ships' },
        ],
      }],
    })
    await env.idle()
    const sent = llm.lastText()
    expect(sent).not.toContain('Vexo')
    expect(sent).not.toContain('Lantern')
    expect(sent).toContain('Bring shield ships')
    const out = env.qq.text(QQ_GROUP)[0]
    expect(out).toContain('Vexo Tarrin\n\nFLEET NAME\n\nGrey Lantern\nRoam\n\nSHIPS\n\nBRING SHIELD SHIPS')
  })

  it('B11：零宽字符不进 QQ，也不进翻译输入', async () => {
    env = await setup(on(''))
    env.discordMessage({ content: 'P‍A‍P﻿ Type: Strategic' })
    await env.idle()
    expect(llm.lastText()).toBe('PAP Type: Strategic')
    const out = env.qq.text(QQ_GROUP)[0]
    expect(out).not.toMatch(/[​‌‍⁠﻿]/)
    expect(out).toContain('PAP Type: Strategic')
  })

  it('B11：QQ → Discord 防 ping 插入的零宽空格不受影响', async () => {
    env = await setup(on(''))
    await env.qqMessage(qqPayload('@everyone 集合'))
    await env.idle()
    expect(env.discord.posts()[0].json.content).toContain('@​everyone 集合')
  })

  it('B12：@everyone、@here 不发给模型，QQ 上原样保留', async () => {
    env = await setup(on(''))
    env.discordMessage({ content: '@everyone form up now, @here too' })
    await env.idle()
    const sent = llm.lastText()
    expect(sent).not.toMatch(/everyone|here/i)
    expect(env.qq.text(QQ_GROUP)[0]).toContain('【机翻】 译：@everyone FORM UP NOW, @here TOO')
  })
})
