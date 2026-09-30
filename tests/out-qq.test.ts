import { beforeAll, describe, expect, it } from 'vitest'
import { Context } from 'koishi'
import type { Element } from 'koishi'
import { OneBotBot } from 'koishi-plugin-adapter-onebot'
import { buildQQSends } from '../src/out/qq'

const png = () => new Uint8Array([1, 2, 3]).buffer
const base = { atAll: false, prefix: '[测试桥 - 小红]', text: '', images: [], videos: [] }
const textOf = (els: Element[]) => els.filter((e) => e.type === 'text').map((e) => e.attrs.content).join('')
const types = (els: Element[]) => els.map((e) => e.type)

describe('buildQQSends', () => {
  it('没有内容时返回 []', () => {
    expect(buildQQSends(base)).toEqual([])
  })

  it('普通消息：前缀一行 + 正文，一律是元素', () => {
    const sends = buildQQSends({ ...base, text: 'a < b' })
    expect(sends).toHaveLength(1)
    expect(types(sends[0])).toEqual(['text'])
    expect(textOf(sends[0])).toBe('[测试桥 - 小红]\na < b')
    for (const el of sends[0]) expect(typeof el).toBe('object')
  })

  it('顺序：quote → @全体 → 前缀 → 引用行 → 正文 → 图片 → 译文（一条放得下时，U10）', () => {
    const sends = buildQQSends({
      ...base,
      quoteId: '42',
      atAll: true,
      replyLine: '↪ 回复 A：原文',
      text: '正文',
      translation: '【机翻】译文',
      images: [{ data: png(), mime: 'image/png' }, { placeholder: '[图片]' }, { data: png(), mime: 'image/jpeg' }],
    })
    expect(sends).toHaveLength(1)
    const [send] = sends
    expect(types(send)).toEqual(['quote', 'at', 'text', 'img', 'img', 'text'])
    expect(send[0].attrs.id).toBe('42')
    expect(send[1].attrs.type).toBe('all')
    expect(textOf(send)).toBe('\n[测试桥 - 小红]\n↪ 回复 A：原文\n正文\n[图片]\n【机翻】译文')
    expect(send[3].attrs.src).toMatch(/^data:image\/png;base64,/)
  })

  it('@全体 没通过：fallbackText 加空格放在最前', () => {
    const [send] = buildQQSends({ ...base, fallbackText: '【重要】', text: 'x' })
    expect(types(send)).toEqual(['text'])
    expect(textOf(send)).toBe('【重要】 [测试桥 - 小红]\nx')
  })

  it('分段：quote、@全体、引用行只在第一段，前缀每段都有，图片跟最后一段，每段不超过上限', () => {
    const text = ('一句话。'.repeat(20) + '\n').repeat(10)
    const sends = buildQQSends({
      ...base,
      quoteId: '42',
      atAll: true,
      replyLine: '↪ 回复 A：原文',
      text,
      images: [{ data: png(), mime: 'image/png' }],
      limit: 200,
    })
    expect(sends.length).toBeGreaterThan(2)
    sends.forEach((send, i) => {
      const t = textOf(send)
      expect(t.length + (i === 0 ? '@全体成员'.length : 0)).toBeLessThanOrEqual(200)
      expect(t.includes('[测试桥 - 小红]\n')).toBe(true)
      expect(send.some((e) => e.type === 'quote')).toBe(i === 0)
      expect(send.some((e) => e.type === 'at')).toBe(i === 0)
      expect(t.includes('↪ 回复')).toBe(i === 0)
      expect(send.some((e) => e.type === 'img')).toBe(i === sends.length - 1)
    })
    const joined = sends.map((s) => textOf(s).replace(/^\n?\[测试桥 - 小红\]\n(↪ 回复 A：原文\n)?/, '')).join('\n')
    expect(joined).toBe(text.trimEnd())
  })

  it('默认上限 1500', () => {
    const sends = buildQQSends({ ...base, text: 'x'.repeat(4000) })
    expect(sends).toHaveLength(3)
    for (const s of sends) expect(textOf(s).length).toBeLessThanOrEqual(1500)
  })

  it('视频各自单独一次发送，排在最后', () => {
    const sends = buildQQSends({
      ...base,
      text: 't',
      videos: [
        { url: 'https://example.com/1.mp4', placeholder: '[视频]' },
        { url: 'https://example.com/2.mp4', placeholder: '[视频]' },
      ],
    })
    expect(sends.map(types)).toEqual([['text'], ['video'], ['video']])
    expect(sends[1][0].attrs.src).toBe('https://example.com/1.mp4')
  })

  it('只有视频时仍先发前缀', () => {
    const sends = buildQQSends({ ...base, videos: [{ url: 'https://example.com/1.mp4', placeholder: '[视频]' }] })
    expect(sends.map(types)).toEqual([['text'], ['video']])
    expect(textOf(sends[0])).toBe('[测试桥 - 小红]')
  })

  it('只有图片：前缀和图片同一次发送', () => {
    const sends = buildQQSends({ ...base, images: [{ data: png(), mime: 'image/png' }] })
    expect(sends.map(types)).toEqual([['text', 'img']])
  })
})

describe('经过真实的 onebot 编码', () => {
  const captured: Array<{ action: string; params: any }> = []
  let bot: OneBotBot<Context>

  beforeAll(async () => {
    const app = new Context()
    await app.start()
    bot = new OneBotBot(app, { selfId: '10000', protocol: 'none', advanced: { splitMixedContent: true } } as any)
    ;(bot.internal as any)._request = async (action: string, params: any) => {
      captured.push({ action, params })
      return { status: 'ok', retcode: 0, data: { message_id: 1 } }
    }
  })

  it('price < 5b、&amp;、<@&123>、<t:1:F> 原样到达，quote 在最前', async () => {
    const text = 'price < 5b and > 3b &amp; <@&123> <t:1:F>'
    const sends = buildQQSends({
      ...base,
      quoteId: '77',
      atAll: true,
      text,
      images: [{ data: png(), mime: 'image/png' }],
      videos: [{ url: 'https://example.com/v.mp4', placeholder: '[视频]' }],
    })
    captured.length = 0
    for (const send of sends) await bot.sendMessage('123456', send)
    expect(captured.map((c) => c.action)).toEqual(['send_group_msg', 'send_group_msg'])
    const first = captured[0].params.message
    expect(first.map((s: any) => s.type)).toEqual(['reply', 'at', 'text', 'image'])
    expect(first[0].data.id).toBe('77')
    expect(first[1].data.qq).toBe('all')
    expect(first[2].data.text).toBe(`\n[测试桥 - 小红]\n${text}`)
    expect(first[3].data.file).toMatch(/^base64:\/\//)
    expect(captured[1].params.message).toEqual([{ type: 'video', data: { file: 'https://example.com/v.mp4', cache: 0 } }])
  })
})
