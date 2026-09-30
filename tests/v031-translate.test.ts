// 0.3.1 补充清单 T1、T2、T3、T4、T7：embed 译文排版、标签规则只管 ping、分组命令、正则性能、术语两边的空格。
// 翻译用模拟服务器，名字全部是编造的。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeSettings } from '../src/bridges'
import { renderDiscordMessage, type RawMessage, type RenderOptions } from '../src/discord/render'
import { countWords, keepValueRanges, restoreTerms } from '../src/translate/protect'
import { isCommand, isRealCommand } from '../src/translate/skip'
import { baseConfig, bridge, Env, PR2_DEFAULTS, QQ_GROUP, setup } from './harness'

// 模拟翻译：默认把英文词变成大写，前面加「译：」；reply 可以换成别的译法。占位符原样返回
class FakeLLM {
  server!: http.Server
  base = ''
  chat: any[] = []
  reply = (text: string) => `译：${text.replace(/[A-Za-z]+/g, (w) => w.toUpperCase())}`

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

  lastText() {
    const user = this.chat.at(-1)?.json.messages?.at(-1)?.content ?? ''
    return /<text>([\s\S]*)<\/text>/.exec(user)?.[1] ?? ''
  }
}

const LABELS = 'FC;;FC Name;;Fleet Commander;;Fleet Name;;Comms;;Formup Location'
const labels = normalizeSettings(baseConfig({ translate: { ...PR2_DEFAULTS.translate, keepValueLabels: LABELS } })).translate.keepValueLabels
const kept = (text: string) => keepValueRanges(text, labels).map(([s, e]) => text.slice(s, e))

// ------------------------------------------------------------------ 单元

describe('T1：embed 字段在翻译输入里是一行「名：值」', () => {
  const opts: RenderOptions = { timeZone: 'Asia/Shanghai', now: Date.UTC(2026, 8, 30), roleName: () => undefined, channelName: () => undefined }
  const msg = (embeds: RawMessage['embeds']): RawMessage => ({ id: '900', channel_id: '800', guild_id: '700', type: 0, author: { id: '101', username: 'x' }, content: '', embeds })

  it('和转发的排版一样：同一个 embed 的字段之间只换一行；字段值位置（B10）指向「：」后面的值', () => {
    const m = renderDiscordMessage(msg([{
      title: 'Fleet ping',
      fields: [
        { name: 'FC', value: 'Orla Venn' },
        { name: 'Fleet Name', value: 'Quiet Harbor' },
        { name: 'Ships', value: 'Bring armor\nships' },
      ],
    }]), opts)!
    expect(m.translatable).toBe('Fleet ping\n\nFC：Orla Venn\nFleet Name：Quiet Harbor\nShips：Bring armor\n  ships')
    expect(m.fields!.map((f) => [f.name, m.translatable!.slice(f.start, f.end)])).toEqual([
      ['FC', 'Orla Venn'],
      ['Fleet Name', 'Quiet Harbor'],
      ['Ships', 'Bring armor\n  ships'],
    ])
  })

  it('字段名或值为空：只写有的那一半；不同 embed 的字段之间仍是空行', () => {
    const m = renderDiscordMessage(msg([
      { fields: [{ name: 'Note', value: '' }, { name: '', value: 'free text' }] },
      { fields: [{ name: 'Comms', value: 'Op 3' }] },
    ]), opts)!
    expect(m.translatable).toBe('Note\nfree text\n\nComms：Op 3')
    expect(m.fields!.map((f) => [f.name, m.translatable!.slice(f.start, f.end)])).toEqual([['', 'free text'], ['Comms', 'Op 3']])
  })
})

describe('T2：行首标签规则只在像 ping 的消息里生效', () => {
  it('countWords：英文按空白分词，每个汉字算一个词', () => {
    expect(countWords('Vexo Tarrin')).toBe(2)
    expect(countWords('Op 11')).toBe(2)
    expect(countWords('全体对齐太阳，等待跃迁')).toBe(10)
    expect(countWords('everyone align to the sun and wait for warp')).toBe(9)
  })

  it('只有一行、值很长的普通聊天：不保护', () => {
    expect(kept('FC: everyone align to the sun and wait for warp')).toEqual([])
    expect(kept('FC：全体对齐太阳，等待跃迁')).toEqual([])
    expect(kept('Comms: are down, everyone use discord voice')).toEqual([])
  })

  it('值很短（不超过 5 个词、40 个字符）：只有一行也保护', () => {
    expect(kept('FC Name: Vexo Tarrin')).toEqual(['Vexo Tarrin'])
    expect(kept('Comms: Op 11\nwe go soon')).toEqual(['Op 11'])
    // 5 个词但超过 40 个字符：不算短
    expect(kept('FC: Abcdefghijk Lmnopqrstuv Wxyzabcdefg Hijklmn')).toEqual([])
  })

  it('至少 2 行命中标签：值再长也保护', () => {
    const text = 'FC Name: Vexo Tarrin\nComms: are down, everyone use discord voice\nNotes: bring cap boosters'
    expect(kept(text)).toEqual(['Vexo Tarrin', 'are down, everyone use discord voice'])
  })

  it('embed 字段规则不变：字段名在列表里，值再长也保护', () => {
    const text = 'FC：everyone align to the sun and wait for warp'
    expect(keepValueRanges(text, labels, [{ name: 'FC', start: 3, end: text.length }]).map(([s, e]) => text.slice(s, e)))
      .toEqual(['everyone align to the sun and wait for warp'])
  })
})

describe('T4：标签正则不会因为长行卡住', () => {
  it('2 万字符的空格、`*`、`_` 行（没有冒号）：50 毫秒以内', () => {
    const unit = ' *_'
    const lines = [unit.repeat(7000).slice(0, 20000), '*'.repeat(20000), ' '.repeat(20000), `FC${' '.repeat(20000)}x`]
    for (const line of lines) {
      const t0 = performance.now()
      expect(keepValueRanges(line, labels)).toEqual([])
      expect(performance.now() - t0).toBeLessThan(50)
    }
  })

  it('值后面有很长的空白：也很快，行尾空白不算进值', () => {
    const line = `FC: a${' '.repeat(20000)}b${' '.repeat(20000)}`
    const t0 = performance.now()
    keepValueRanges(line, labels)
    expect(performance.now() - t0).toBeLessThan(50)
    expect(kept(`Comms: Op 11${' '.repeat(50)}`)).toEqual(['Op 11'])
  })

  it('标签要以字母、汉字或数字开头；前面的粗体、列表符号照旧可以有', () => {
    expect(kept('**FC Name:** Vexo Tarrin')).toEqual(['Vexo Tarrin'])
    expect(kept('- Comms: Op 11')).toEqual(['Op 11'])
    expect(kept('__**FC**__: Vexo Tarrin')).toEqual(['Vexo Tarrin'])
  })
})

describe('T3：只有分组、没有 action 的命令不算命令', () => {
  it('isRealCommand：_actions 为空 → false；有 action 或拿不到内部字段 → true', () => {
    expect(isRealCommand(undefined)).toBe(false)
    expect(isRealCommand({ _actions: [] })).toBe(false)
    expect(isRealCommand({ _actions: [() => 'x'] })).toBe(true)
    expect(isRealCommand({})).toBe(true)
  })

  it('isCommand 配合 isRealCommand：bridge 分组不算，bridge.status 算', () => {
    const cmds: Record<string, unknown> = { 'bridge': { _actions: [] }, 'bridge.status': { _actions: [() => ''] } }
    const resolve = (w: string) => isRealCommand(cmds[w])
    expect(isCommand('bridge is up', [], resolve)).toBe(false)
    expect(isCommand('bridge in 5', [], resolve)).toBe(false)
    expect(isCommand('bridge.status', [], resolve)).toBe(true)
  })
})

describe('T7：换进去的中文术语两边的空格', () => {
  const t = (text: string, value = '墩子') => restoreTerms(text, [{ token: '⟦G0⟧', value }])

  it('紧挨着汉字或中文标点的一侧去掉空格', () => {
    expect(t('当心，⟦G0⟧ 在我们的本星系')).toBe('当心，墩子在我们的本星系')
    expect(t('当心， ⟦G0⟧ 在')).toBe('当心，墩子在')
    expect(t('备注: 携带 ⟦G0⟧', '电容注电器')).toBe('备注: 携带电容注电器')
    expect(t('小心 ⟦G0⟧。')).toBe('小心墩子。')
    expect(t('小心 ⟦G0⟧ 。')).toBe('小心墩子。')
  })

  it('旁边是英文、数字、被保护的内容、另一个术语、换行时空格照旧；换进去的是英文时不动', () => {
    expect(t('Jita 有 ⟦G0⟧ x')).toBe('Jita 有墩子 x')
    expect(t('⟦0⟧ ⟦G0⟧ ⟦1⟧')).toBe('⟦0⟧ 墩子 ⟦1⟧')
    expect(t('在\n⟦G0⟧\n在')).toBe('在\n墩子\n在')
    expect(t('当心 ⟦G0⟧ 在', 'Keepstar')).toBe('当心 Keepstar 在')
    expect(restoreTerms('集结 ⟦G0⟧ ⟦G1⟧ 了', [{ token: '⟦G0⟧', value: '墩子' }, { token: '⟦G1⟧', value: '裂谷级' }])).toBe('集结墩子 裂谷级了')
  })

  it('不认识的占位符原样留下', () => {
    expect(t('当心 ⟦G9⟧ 在')).toBe('当心 ⟦G9⟧ 在')
  })
})

// ------------------------------------------------------------------ 转发

describe('转发：T1、T2、T3、T7', () => {
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
    translate: { ...PR2_DEFAULTS.translate, enabled: true, baseURL: llm.base, apiKey: 'test-key', model: 'test-model', timeoutMs: 800, keepValueLabels: LABELS, ...patch.translate },
    filter: { ...PR2_DEFAULTS.filter },
    glossary: { ...PR2_DEFAULTS.glossary, ...patch.glossary },
  })
  const outcome = (text: string, direction: 'en2zh' | 'zh2en' = 'en2zh') =>
    env!.relay.translation.translate({ translatable: text, protect: [] } as any, direction)

  it('T1：3 个字段的 embed，译文仍是 3 行「名：值」，受保护的值原样', async () => {
    env = await setup(on())
    env.discordMessage({
      content: '',
      embeds: [{
        type: 'rich',
        fields: [
          { name: 'Fleet Commander', value: 'Orla Venn' },
          { name: 'Formup Location', value: 'Home station' },
          { name: 'Ships', value: 'Bring shield ships' },
        ],
      }],
    })
    await env.idle()
    const sent = llm.lastText()
    expect(sent).not.toContain('Orla')
    expect(sent).toMatch(/^Fleet Commander：⟦\d+⟧\nFormup Location：⟦\d+⟧\nShips：Bring shield ships$/)
    expect(env.qq.text(QQ_GROUP)[0]).toContain('【机翻】 译：FLEET COMMANDER：Orla Venn\nFORMUP LOCATION：Home station\nSHIPS：BRING SHIELD SHIPS')
  })

  it('T2：以 FC:、Comms: 开头的普通聊天照常翻译；多行 ping 仍然保护', async () => {
    env = await setup(on())
    for (const text of ['FC: everyone align to the sun and wait for warp', 'Comms: are down, everyone use discord voice']) {
      expect(await outcome(text)).toMatchObject({ ok: true })
      expect(llm.lastText()).toBe(text)
    }
    expect(await outcome('FC：全体对齐太阳，等待跃迁', 'zh2en')).toMatchObject({ ok: true })
    expect(llm.lastText()).toBe('FC：全体对齐太阳，等待跃迁')
    expect(await outcome('FC Name: Vexo Tarrin\nComms: are down, everyone use discord voice')).toMatchObject({ ok: true })
    expect(llm.lastText()).toMatch(/^FC Name: ⟦\d+⟧\nComms: ⟦\d+⟧$/)
  })

  it('T3：bridge is up、bridge in 5 照常翻译；bridge.status 仍是命令', async () => {
    env = await setup(on())
    expect(env.app.$commander.resolve('bridge')).toBeTruthy()
    expect(await outcome('bridge is up')).toMatchObject({ ok: true })
    expect(await outcome('bridge in 5')).toMatchObject({ ok: true })
    expect(await outcome('bridge.status')).toMatchObject({ reason: '命令' })
  })

  it('T7：force 术语换回中文后，挨着汉字、中文标点的空格去掉', async () => {
    const overrides = [
      { en: 'afk cloaker', zh: '墩子', mode: 'force', dir: 'both' },
      { en: 'cap booster', zh: '电容注电器', mode: 'force', dir: 'both' },
    ]
    env = await setup(on({ translate: { keepValueLabels: '' }, glossary: { overrides } }))
    llm.reply = (text) => text
      .replace('Careful, ', '当心，')
      .replace(' is in our home system', ' 在我们的本星系')
      .replace('Note: bring ', '备注: 携带 ')
    env.discordMessage({ content: 'Careful, afk cloaker is in our home system' })
    env.discordMessage({ content: 'Note: bring cap booster' })
    await env.idle()
    const out = env.qq.text(QQ_GROUP)
    expect(out[0]).toContain('【机翻】 当心，墩子在我们的本星系')
    expect(out[1]).toContain('【机翻】 备注: 携带电容注电器')
  })
})
