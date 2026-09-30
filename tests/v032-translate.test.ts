// 0.3.2 补充清单 U2、U3、U8、U9、U10、U11：背景说明、换回的英文补空格、网址两边补空格、行尾空白、图片位置、两个中文术语之间的空格。
// 翻译用模拟服务器，名字、网址全部是编造的。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Element } from 'koishi'
import { normalizeSettings } from '../src/bridges'
import { renderDiscordMessage, type RawMessage, type RenderOptions } from '../src/discord/render'
import { buildQQSends } from '../src/out/qq'
import { systemPrompt } from '../src/translate/client'
import { protect, restore, restoreTerms } from '../src/translate/protect'
import { trimLines } from '../src/translate/service'
import { baseConfig, bridge, Env, PR2_DEFAULTS, QQ_GROUP, setup } from './harness'

// 模拟翻译：默认原样返回 <text> 里的内容；reply 可以换成别的译法
class FakeLLM {
  server!: http.Server
  base = ''
  chat: any[] = []
  reply = (text: string) => `译：${text}`

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
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: this.reply(text) } }] }))
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`
  }

  stop() {
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  lastSystem() {
    return this.chat.at(-1)?.json.messages?.[0]?.content ?? ''
  }
}

// ------------------------------------------------------------------ U2

describe('U2：背景说明加在系统提示词最后', () => {
  it('配置：默认空，去掉首尾空白，保留中间的换行', () => {
    expect(normalizeSettings(baseConfig()).translate.context).toBe('')
    const s = normalizeSettings(baseConfig({ translate: { ...PR2_DEFAULTS.translate, context: '  第一行\n第二行 \n' } }))
    expect(s.translate.context).toBe('第一行\n第二行')
  })

  it('不为空时原样加在最后，两个方向都加；为空时和原来一样', () => {
    const plain = systemPrompt('en2zh')
    expect(systemPrompt('en2zh', '')).toBe(plain)
    expect(systemPrompt('en2zh', '  ')).toBe(plain)
    for (const dir of ['en2zh', 'zh2en'] as const) {
      const p = systemPrompt(dir, '这是某游戏玩家之间的聊天。\n怪 = NPC')
      expect(p.startsWith(systemPrompt(dir))).toBe(true)
      expect(p.endsWith('\n\n这是某游戏玩家之间的聊天。\n怪 = NPC')).toBe(true)
    }
  })
})

// ------------------------------------------------------------------ U3、U11

describe('U3：换回的英文和旁边的英文字母、数字之间补空格', () => {
  const t = (text: string, value = 'Fuel Block') => restoreTerms(text, [{ token: '⟦G0⟧', value }])

  it('左右紧挨着英文字母或数字时补空格', () => {
    expect(t('AAA⟦G0⟧')).toBe('AAA Fuel Block')
    expect(t('⟦G0⟧x10')).toBe('Fuel Block x10')
    expect(t('10⟦G0⟧')).toBe('10 Fuel Block')
    expect(t('buy⟦G0⟧now')).toBe('buy Fuel Block now')
  })

  it('复数词尾 s/es 后面是词边界时不补', () => {
    expect(t('⟦G0⟧s')).toBe('Fuel Blocks')
    expect(t('20 ⟦G0⟧s here')).toBe('20 Fuel Blocks here')
    expect(t('⟦G0⟧es', 'Box')).toBe('Boxes')
    expect(t('⟦G0⟧said', 'Pilot')).toBe('Pilot said')
  })

  it('旁边是标点、空格、被保护的内容，或者换进去的是中文时不变', () => {
    expect(t('(⟦G0⟧)')).toBe('(Fuel Block)')
    expect(t('AAA ⟦G0⟧, ok')).toBe('AAA Fuel Block, ok')
    expect(t('⟦0⟧⟦G0⟧')).toBe('⟦0⟧Fuel Block')
    expect(t('AAA⟦G0⟧', '燃料块')).toBe('AAA燃料块')
  })

  it('两个英文术语挨着时中间补一个空格', () => {
    const tokens = [{ token: '⟦G0⟧', value: 'Fuel Block' }, { token: '⟦G1⟧', value: 'Jita' }]
    expect(restoreTerms('⟦G0⟧⟦G1⟧', tokens)).toBe('Fuel Block Jita')
  })
})

describe('U11：两个挨着的中文术语之间不留空格', () => {
  const two = (text: string, a: string, b: string) =>
    restoreTerms(text, [{ token: '⟦G0⟧', value: a }, { token: '⟦G1⟧', value: b }])

  it('紧挨空格两边都是汉字时去掉空格', () => {
    expect(two('⟦G0⟧ ⟦G1⟧', '长须鲸级', '被抓')).toBe('长须鲸级被抓')
    expect(two('⟦G0⟧ ⟦G1⟧', '贵船', '进站')).toBe('贵船进站')
    expect(two('⟦G0⟧ ⟦G1⟧', 'Peacetime出勤', '舰队已开')).toBe('Peacetime出勤舰队已开')
  })

  it('有一边不是汉字时保留', () => {
    expect(two('⟦G0⟧ ⟦G1⟧', 'FRT', '舰队')).toBe('FRT 舰队')
    expect(two('⟦G0⟧ ⟦G1⟧', '舰队', 'FRT')).toBe('舰队 FRT')
    expect(two('⟦G0⟧\n⟦G1⟧', '长须鲸级', '被抓')).toBe('长须鲸级\n被抓')
  })
})

// ------------------------------------------------------------------ U8

describe('U8：还原网址时两边按需补空格', () => {
  const round = (source: string, translated: (text: string) => string) => {
    const g = protect(source, [])
    return restore(translated(g.text), g.tokens)
  }

  it('网址后面紧跟汉字、全角标点时补空格', () => {
    const url = 'https://evemaps.dotlan.net/corp/Example_Corp'
    expect(round(`${url} and Vexo`, (t) => t.replace(' and Vexo', '的Vexo'))).toBe(`${url} 的Vexo`)
    const srp = 'https://example.org/request-srp/'
    expect(round(`apply at ${srp} )`, (t) => t.replace('apply at ', '申请：').replace(' )', '）'))).toBe(`申请： ${srp} ）`)
  })

  it('网址前面紧挨着汉字或全角标点时补空格', () => {
    const url = 'https://example.org/a'
    expect(round(`see ${url}`, (t) => t.replace('see ', '见'))).toBe(`见 ${url}`)
    expect(round(`see: ${url}`, (t) => t.replace('see: ', '见：'))).toBe(`见： ${url}`)
  })

  it('网址两边本来就是空格、换行、行尾，或者后面是英文标点时不变', () => {
    const url = 'https://example.org/a?b=1'
    const same = (source: string) => expect(round(source, (t) => t)).toBe(source)
    same(`see ${url} now`)
    same(`see ${url}\nnext`)
    same(`see ${url}`)
    same(`${url}`)
    same(`see ${url}. then`)
    same(`(see ${url})`)
  })

  it('只处理网址，@ 提及、时间等其他占位符原样放回', () => {
    const g = protect('ping @Fleet Boss now', ['@Fleet Boss'])
    expect(restore(g.text.replace('ping ', '通知').replace(' now', '现在'), g.tokens)).toBe('通知@Fleet Boss现在')
  })
})

// ------------------------------------------------------------------ U9

describe('U9：行尾空白、只有空白的行', () => {
  it('译文每行去掉行尾空白', () => {
    expect(trimLines('第一行  \n第二行\t\n\n第三行  ')).toBe('第一行\n第二行\n\n第三行')
    expect(trimLines('  前面的空白保留\n  缩进也保留')).toBe('前面的空白保留\n  缩进也保留')
  })

  const opts: RenderOptions = { timeZone: 'Asia/Shanghai', now: Date.UTC(2026, 8, 30), roleName: () => undefined, channelName: () => undefined }
  const msg = (d: Partial<RawMessage>): RawMessage => ({ id: '900', channel_id: '800', guild_id: '700', type: 0, author: { id: '101', username: 'x' }, content: '', ...d })

  it('转发的原文里，只有空白的行（AA ping 的 `** **`）变成空行', () => {
    const m = renderDiscordMessage(msg({ content: '**Fleet up**\n** **\nFC: Vexo Tarrin\n   \nDoctrine: shield' }), opts)!
    expect(m.body).toBe('Fleet up\n\nFC: Vexo Tarrin\n\nDoctrine: shield')
    const f = renderDiscordMessage(msg({
      message_reference: { type: 1 },
      message_snapshots: [{ message: { content: 'Ping\n** **\nForm up now' } }],
    }), opts)!
    expect(f.blocks.join('\n')).toBe('[转发的消息]\nPing\n\nForm up now')
  })
})

// ------------------------------------------------------------------ U10

describe('U10：QQ 消息里图片放在原文后面、译文前面', () => {
  const png = () => new Uint8Array([1, 2, 3]).buffer
  const base = { atAll: false, prefix: '[测试桥 - 小红]', text: '', images: [], videos: [] }
  const types = (els: Element[]) => els.map((e) => e.type)
  const texts = (els: Element[]) => els.filter((e) => e.type === 'text').map((e) => e.attrs.content)

  it('一条放得下：原文 → 图片 → 译文', () => {
    const sends = buildQQSends({ ...base, text: 'Structure under attack\nhull: 99.7%', translation: '【机翻】 建筑遭到攻击\n舰体：99.7%', images: [{ data: png(), mime: 'image/png' }] })
    expect(sends).toHaveLength(1)
    expect(types(sends[0])).toEqual(['text', 'img', 'text'])
    expect(texts(sends[0])).toEqual(['[测试桥 - 小红]\nStructure under attack\nhull: 99.7%', '\n【机翻】 建筑遭到攻击\n舰体：99.7%'])
  })

  it('没有译文或没有图片时和原来一样', () => {
    const noTr = buildQQSends({ ...base, text: '原文', images: [{ data: png(), mime: 'image/png' }] })
    expect(types(noTr[0])).toEqual(['text', 'img'])
    const noImg = buildQQSends({ ...base, text: 'text', translation: '【机翻】 译文' })
    expect(types(noImg[0])).toEqual(['text'])
    expect(texts(noImg[0])).toEqual(['[测试桥 - 小红]\ntext\n\n【机翻】 译文'])
  })

  it('需要分段时保持「原文 → 译文 → 图片」，图片跟最后一段', () => {
    const text = ('一句话。'.repeat(20) + '\n').repeat(4)
    const sends = buildQQSends({ ...base, text, translation: '【机翻】 ' + 'Sentence. '.repeat(30), images: [{ data: png(), mime: 'image/png' }], limit: 200 })
    expect(sends.length).toBeGreaterThan(1)
    for (const send of sends.slice(0, -1)) expect(types(send)).toEqual(['text'])
    expect(types(sends.at(-1)!)).toEqual(['text', 'img'])
    expect(texts(sends.at(-1)!)[0]).toContain('Sentence.')
  })
})

// ------------------------------------------------------------------ 转发

describe('转发：U2 缓存、U9 译文行尾', () => {
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

  const on = (patch: any = {}) => ({
    bridges: [bridge({ translate: true })],
    translate: { ...PR2_DEFAULTS.translate, enabled: true, baseURL: llm.base, apiKey: 'test-key', model: 'test-model', timeoutMs: 800, ...patch.translate },
    filter: { ...PR2_DEFAULTS.filter },
    glossary: { ...PR2_DEFAULTS.glossary, ...patch.glossary },
  })
  const outcome = (text: string, direction: 'en2zh' | 'zh2en' = 'en2zh') =>
    env!.relay.translation.translate({ translatable: text, protect: [] } as any, direction)

  it('U2：背景说明出现在请求的系统提示词里；改了以后同一句话重新请求', async () => {
    env = await setup(on({ translate: { context: '这是某游戏玩家之间的聊天。\n怪 = NPC' } }) as any)
    expect(await outcome('bridge in 5 minutes please')).toMatchObject({ ok: true })
    expect(llm.chat).toHaveLength(1)
    expect(llm.lastSystem().endsWith('\n\n这是某游戏玩家之间的聊天。\n怪 = NPC')).toBe(true)
    // 同一句话走缓存
    expect(await outcome('bridge in 5 minutes please')).toMatchObject({ ok: true })
    expect(llm.chat).toHaveLength(1)
    // 改了背景说明：不走缓存
    env.relay.settings.translate.context = '另一段背景说明'
    expect(await outcome('bridge in 5 minutes please')).toMatchObject({ ok: true })
    expect(llm.chat).toHaveLength(2)
    expect(llm.lastSystem().endsWith('\n\n另一段背景说明')).toBe(true)
    // 清空：系统提示词里不再有背景说明，也不走缓存
    env.relay.settings.translate.context = ''
    expect(await outcome('bridge in 5 minutes please')).toMatchObject({ ok: true })
    expect(llm.chat).toHaveLength(3)
    expect(llm.lastSystem()).toBe(systemPrompt('en2zh'))
  })

  it('U9：模型在行尾加的空格去掉', async () => {
    env = await setup(on() as any)
    llm.reply = () => '第一行  \n第二行  \n第三行'
    expect(await outcome('first line here\nsecond line here\nthird line here')).toEqual({ ok: true, text: '第一行\n第二行\n第三行' })
  })

  it('U8：网址后面紧跟汉字时，QQ 收到的译文里网址后面有空格', async () => {
    env = await setup(on() as any)
    const url = 'https://evemaps.dotlan.net/corp/Example_Corp'
    llm.reply = (text) => text.replace(' and Vexo is there', '的Vexo在那里')
    env.discordMessage({ content: `${url} and Vexo is there` })
    await env.idle()
    expect(env.qq.text(QQ_GROUP)[0]).toContain(`【机翻】 ${url} 的Vexo在那里`)
  })
})
