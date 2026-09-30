// B14：纠错命令。翻译用模拟服务器，不调用外部 API；所有 ID、名字、词条都是编造的。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Discord } from '@satorijs/adapter-discord'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectDirection, fixKey, keepDirection, originalOfForwarded, parseFixText } from '../src/fixes'
import { buildGlossary, loadCommonWords, parseSlangYaml } from '../src/glossary'
import {
  bridge, DC_CHANNEL, DC_USER, Env, OWNER_QQ, PR2_DEFAULTS, QQ_BOT, QQ_GROUP, QQ_USER, qqPayload, setup, sleep,
} from './harness'

class FakeLLM {
  server!: http.Server
  base = ''
  /** 每次请求里 <text> 的内容 */
  texts: string[] = []
  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const user = json.messages?.at(-1)?.content ?? ''
        const text = /<text>([\s\S]*)<\/text>/.exec(user)?.[1] ?? ''
        this.texts.push(text)
        const out = /[一-鿿]/.test(text) && !/[A-Za-z]{4}/.test(text) ? `EN: ${text}` : `译：${text}`
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: out } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }))
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`
  }

  stop() {
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

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

function translateOn(overrides: any[] = []) {
  return {
    bridges: [bridge({ translate: true })],
    translate: { ...PR2_DEFAULTS.translate, enabled: true, baseURL: llm.base, apiKey: 'test-key', model: 'test-model', timeoutMs: 800 },
    glossary: { ...PR2_DEFAULTS.glossary, overrides },
  }
}

const text = (t: string, extra: Record<string, any> = {}) => qqPayload([{ type: 'text', data: { text: t } }], extra)

/** 所有者在 QQ 群里发一条消息（可以带回复），等处理完，返回机器人在群里的新回复。 */
async function ownerSays(e: Env, t: string, replyTo?: string, wait = 200): Promise<string[]> {
  const before = e.qq.sent.length
  const message = [...(replyTo ? [{ type: 'reply', data: { id: replyTo } }] : []), { type: 'text', data: { text: t } }]
  await e.qqMessage(qqPayload(message, { user_id: +OWNER_QQ, sender: { user_id: +OWNER_QQ, nickname: '所有者', card: '所有者', role: 'owner' } }))
  await sleep(wait)
  await e.idle()
  return e.qq.sent.slice(before).map((s) => s.text)
}

/**
 * Discord 频道里发一条消息：harness 的 discordMessage 只推给转发用的原始事件，
 * 这里再用适配器自己的解码生成一个普通消息会话，让 Koishi 的命令也处理它。
 */
async function discordCommand(e: Env, content: string, extra: Record<string, any> = {}) {
  const payload = e.discordMessage({ content, ...extra })
  const session = await Discord.adaptSession(e.dcBot, { op: 0, t: 'MESSAGE_CREATE', d: payload } as any)
  if (session) e.dcBot.dispatch(session)
  await sleep(200)
}

const rows = (e: Env) => e.app.database.get('dcqqbridge_glossary', {})

// ================================================================== 解析

describe('B14 纠错命令的解析', () => {
  it('方向自动判断：英文 → 中文是英译中，中文 → 英文是中译英，判断不出来就给用法', () => {
    expect(detectDirection('standing fleet', '值守舰队')).toBe('en2zh')
    expect(detectDirection('全员集结', 'CTA')).toBe('zh2en')
    expect(detectDirection('Jita', 'Jita(吉他)')).toBe('en2zh')
    expect(detectDirection('abc', 'def')).toBeNull()
    expect(detectDirection('集合', '出发')).toBeNull()
    expect(detectDirection('12', '34')).toBeNull()

    expect(parseFixText('standing fleet = 值守舰队')).toEqual({ kind: 'add', mode: 'force', src: 'standing fleet', dst: '值守舰队', dir: 'en2zh' })
    expect(parseFixText('全员  集结＝CTA')).toEqual({ kind: 'add', mode: 'force', src: '全员 集结', dst: 'CTA', dir: 'zh2en' })
    expect(parseFixText('-h cyno = 诱导')).toMatchObject({ kind: 'add', mode: 'hint', src: 'cyno', dst: '诱导' })
    expect(parseFixText('abc = def')).toMatchObject({ kind: 'usage' })
    expect(parseFixText('standing fleet')).toMatchObject({ kind: 'usage' })
    expect(parseFixText('= 值守舰队')).toMatchObject({ kind: 'usage' })
    expect(parseFixText('')).toEqual({ kind: 'usage' })
  })

  it('-k 按原文判断方向：英文 → 英译中，有汉字 → 中译英', () => {
    expect(keepDirection('o7')).toBe('en2zh')
    expect(keepDirection('老板')).toBe('zh2en')
    expect(keepDirection('T2装')).toBe('zh2en')
    expect(keepDirection('123')).toBeNull()
    expect(parseFixText('-k Quiet Lantern')).toEqual({ kind: 'add', mode: 'keep', src: 'Quiet Lantern', dst: 'Quiet Lantern', dir: 'en2zh' })
    expect(parseFixText('-k 老板 = boss')).toMatchObject({ kind: 'usage' })
  })

  it('列表、删除、导出；带等号的一定是添加', () => {
    expect(parseFixText('列表')).toEqual({ kind: 'list', keyword: '' })
    expect(parseFixText('列表 fleet')).toEqual({ kind: 'list', keyword: 'fleet' })
    expect(parseFixText('删除 standing fleet')).toEqual({ kind: 'delete', src: 'standing fleet' })
    expect(parseFixText('删除')).toMatchObject({ kind: 'usage' })
    expect(parseFixText('导出')).toEqual({ kind: 'export' })
    expect(parseFixText('列表 = list')).toMatchObject({ kind: 'add', src: '列表', dst: 'list', dir: 'zh2en' })
  })

  it('主键：3 个字母以内区分大小写，其余不区分', () => {
    expect(fixKey('Standing Fleet', 'en2zh')).toBe(fixKey('standing fleet', 'en2zh'))
    expect(fixKey('FC', 'en2zh')).not.toBe(fixKey('fc', 'en2zh'))
    expect(fixKey('fleet', 'en2zh')).not.toBe(fixKey('fleet', 'zh2en'))
  })

  it('从转发消息里取回原文：去掉前缀、引用行和【机翻】译文', () => {
    const opts = { label: '【机翻】', fallbackText: '【全体通知】' }
    expect(originalOfForwarded('[测试桥 - 舰长]\nwe need standing fleet now\n\n【机翻】 译：我们需要', opts)).toBe('we need standing fleet now')
    expect(originalOfForwarded('【全体通知】 [测试桥 - 舰长]\n↪ 回复 某人：早\n第一行\n\n第二行\n\n【机翻】 EN', opts)).toBe('第一行\n\n第二行')
    expect(originalOfForwarded('没有前缀的 webhook 消息\n\n【机翻】 EN: x', opts)).toBe('没有前缀的 webhook 消息')
    expect(originalOfForwarded('[测试桥 - 舰长] 没有译文', opts)).toBe('没有译文')
  })
})

// ================================================================== 命令

describe('B14 纠错命令', () => {
  it('QQ 群里添加：马上写进数据表，回复「已添加」；命令和回复都不转发到 Discord', async () => {
    env = await setup()
    const replies = await ownerSays(env, '纠错 standing fleet = 值守舰队')
    expect(replies).toEqual(['已添加：standing fleet → 值守舰队（强制替换，英译中）'])
    expect(await rows(env)).toMatchObject([{ src: 'standing fleet', dst: '值守舰队', mode: 'force', dir: 'en2zh', createdBy: `onebot:${OWNER_QQ}` }])
    expect(env.discord.posts()).toHaveLength(0)
    // 术语表里已经有这条（不用 bridge.reload）
    expect(env.relay.translation.glossary!.apply('we need standing fleet now', 'en2zh').tokens).toEqual([{ token: '⟦G0⟧', value: '值守舰队' }])
  })

  it('中译英、-h 参考、-k 保留；-h 不会被当成帮助选项（即使装了 help 插件）', async () => {
    env = await setup()
    // 模拟 help 插件：每个命令都有 -h 选项，带 -h 时显示帮助
    const cmd = env.app.$commander.get('bridge.fix')!
    cmd.option('help', '-h')
    env.app.before('command/execute', (argv) => ((argv.options as any)?.help ? '这是帮助' : undefined))
    expect(await ownerSays(env, '纠错 全员集结 = CTA')).toEqual(['已添加：全员集结 → CTA（强制替换，中译英）'])
    expect(await ownerSays(env, '纠错 -h cyno = 诱导')).toEqual(['已添加：cyno → 诱导（只作参考，英译中）'])
    expect((await ownerSays(env, 'bridge.fix -k 老板'))[0]).toBe('已添加：老板（原样保留，中译英）')
    const g = env.relay.translation.glossary!
    expect(g.apply('明天全员集结', 'zh2en').tokens.map((t) => t.value)).toEqual(['CTA'])
    expect(g.apply('light the cyno', 'en2zh').hints).toEqual(['cyno => 诱导'])
    expect(env.discord.posts()).toHaveLength(0)
  })

  it('判断不出方向：回复用法，不添加', async () => {
    env = await setup()
    const replies = await ownerSays(env, '纠错 abc = def')
    expect(replies[0]).toContain('判断不出方向')
    expect(replies[0]).toContain('用法')
    expect(await rows(env)).toHaveLength(0)
  })

  it('权限不够：不添加，也不转发', async () => {
    env = await setup()
    await env.qqMessage(text('纠错 standing fleet = 值守舰队', { user_id: +QQ_USER }))
    await sleep(150)
    await env.idle()
    expect(await rows(env)).toHaveLength(0)
    expect(env.discord.posts()).toHaveLength(0)
    expect(env.qq.text(QQ_GROUP).join('\n')).not.toContain('已添加')
  })

  it('同一个原文再加一次（大小写不同也算）：覆盖旧的，回复里写原来是什么', async () => {
    env = await setup()
    await ownerSays(env, '纠错 standing fleet = 常备舰队')
    const replies = await ownerSays(env, '纠错 -h Standing Fleet = 值守舰队')
    expect(replies[0]).toBe('已修改：Standing Fleet → 值守舰队（只作参考，英译中）\n原来是：standing fleet → 常备舰队（强制替换，英译中）')
    expect(await rows(env)).toMatchObject([{ src: 'Standing Fleet', dst: '值守舰队', mode: 'hint' }])
  })

  it('常用词、3 个字母以内的词、太短的词', async () => {
    env = await setup()
    const common = await ownerSays(env, '纠错 keep = 保持阵型')
    expect(common[0]).toContain('⚠ keep 是常用词，强制替换可能误伤普通句子，确定吗？加 -h 改成参考')
    expect(common[0]).toContain('已添加')
    expect((await ownerSays(env, '纠错 FC = 指挥官'))[0]).toContain('只匹配大小写完全一致')
    expect((await ownerSays(env, '纠错 fc = 指'))[0]).toContain('没有添加')
    expect(await rows(env)).toHaveLength(2)
  })

  it('删除；列表带关键词；控制台 overrides 里有同一个原文时以控制台为准并标出来', async () => {
    env = await setup({ glossary: { ...PR2_DEFAULTS.glossary, overrides: [{ en: 'standing fleet', zh: '常驻舰队', mode: 'force', dir: 'both' }] } })
    const added = await ownerSays(env, '纠错 standing fleet = 值守舰队')
    expect(added[0]).toContain('以控制台为准')
    await ownerSays(env, '纠错 全员集结 = CTA')
    // 控制台的优先
    expect(env.relay.translation.glossary!.apply('standing fleet up', 'en2zh').tokens[0].value).toBe('常驻舰队')
    const list = (await ownerSays(env, '纠错 列表'))[0]
    expect(list).toBe('纠错词条 2 条：\n1. standing fleet → 值守舰队（强制替换，英译中）　⚠ 控制台的术语覆盖里也有，以控制台为准\n2. 全员集结 → CTA（强制替换，中译英）')
    expect((await ownerSays(env, '纠错 列表 cta'))[0]).toBe('包含「cta」的纠错词条 1 条：\n1. 全员集结 → CTA（强制替换，中译英）')
    expect(await ownerSays(env, '纠错 删除 全员集结')).toEqual(['已删除：全员集结 → CTA（强制替换，中译英）'])
    expect(env.relay.translation.glossary!.apply('明天全员集结', 'zh2en').tokens).toEqual([])
    expect((await ownerSays(env, '纠错 删除 全员集结'))[0]).toContain('没有找到')
    expect(await rows(env)).toHaveLength(1)
    expect(env.discord.posts()).toHaveLength(0)
  })

  it('列表很长时分段发送（每段不超过 1500 字）', async () => {
    env = await setup()
    const many = Array.from({ length: 80 }, (_, i) => ({
      key: `en2zh:term number ${i}`, src: `term number ${i}`, dst: `一个很长的编造译法第${i}号`, mode: 'force', dir: 'en2zh', createdBy: 'onebot:1', createdAt: new Date(1000 + i),
    }))
    await env.app.database.upsert('dcqqbridge_glossary', many)
    const replies = await ownerSays(env, '纠错 列表')
    expect(replies.length).toBeGreaterThan(1)
    for (const r of replies) expect(r.length).toBeLessThanOrEqual(1500)
    expect(replies.join('\n')).toContain('80. term number 79')
  })

  it('导出：写成黑话表格式的 YAML，黑话表加载器能读进来', async () => {
    env = await setup()
    const dir = await mkdtemp(join(tmpdir(), 'dcqq-fix-'))
    ;(env.app as any).baseDir = dir
    await ownerSays(env, '纠错 standing fleet = 值守舰队')
    await ownerSays(env, '纠错 全员集结 = CTA')
    await ownerSays(env, '纠错 -h cyno = 诱导')
    await ownerSays(env, '纠错 -k o7')
    const reply = (await ownerSays(env, '纠错 导出'))[0]
    const file = /已导出 4 条到：(\S+\.yaml)/.exec(reply)?.[1]
    expect(file).toBeTruthy()
    expect(file!.startsWith(join(dir, 'data/dcqq-bridge/fixes-'))).toBe(true)
    const parsed = parseSlangYaml(await readFile(file!, 'utf8'))
    expect(parsed.warnings).toEqual([])
    expect(parsed.entries).toEqual([
      { en: 'standing fleet', zh: '值守舰队', mode: 'force', dir: 'en2zh' },
      { en: 'CTA', zh: '全员集结', mode: 'force', dir: 'zh2en' },
      { en: 'cyno', zh: '诱导', mode: 'hint', dir: 'en2zh' },
      { en: 'o7', zh: 'o7', mode: 'keep', dir: 'en2zh' },
    ])
    const built = buildGlossary({ eve: false, systemStyle: 'en(zh)', overrides: [] }, { slang: parsed.entries, commonWords: loadCommonWords() })
    expect(built.warnings).toEqual([])
    expect(built.glossary.size).toBe(4)
  })

  it('Discord 频道里也能用（Discord 账号要单独给权限）；命令不转发到 QQ', async () => {
    env = await setup()
    await env.app.database.createUser('discord', DC_USER, { authority: 4 })
    await discordCommand(env, '纠错 全员集结 = CTA')
    await env.idle()
    const replies = env.discord.requests.filter((r) => r.method === 'POST' && r.path === `/channels/${DC_CHANNEL}/messages`)
    expect(replies.map((r) => r.json.content)).toEqual(['已添加：全员集结 → CTA（强制替换，中译英）'])
    expect(env.qq.text(QQ_GROUP)).toEqual([])
    expect(await rows(env)).toHaveLength(1)
  })

  it('Discord 上没有权限的账号：不添加', async () => {
    env = await setup()
    await discordCommand(env, '纠错 全员集结 = CTA')
    await env.idle()
    expect(await rows(env)).toHaveLength(0)
    expect(env.qq.text(QQ_GROUP)).toEqual([])
  })
})

// ================================================================== 翻译缓存、回复模式

describe('B14 纠错马上生效', () => {
  it('添加后翻译缓存失效：同一句话重新请求，译文里是新译法', async () => {
    env = await setup(translateOn())
    env.discordMessage({ content: 'we need standing fleet now' })
    await env.idle()
    expect(env.qq.text(QQ_GROUP).at(-1)).toContain('【机翻】 译：we need standing fleet now')
    // 同一句话第二次：走缓存，不再请求
    env.discordMessage({ content: 'we need standing fleet now' })
    await env.idle()
    expect(llm.texts).toHaveLength(1)
    const version = env.relay.translation.glossary!.version

    await ownerSays(env, '纠错 standing fleet = 值守舰队')
    expect(env.relay.translation.glossary!.version).not.toBe(version)
    env.discordMessage({ content: 'we need standing fleet now' })
    await env.idle()
    expect(llm.texts).toHaveLength(2)
    expect(llm.texts[1]).toBe('we need ⟦G0⟧ now')
    expect(env.qq.text(QQ_GROUP).at(-1)).toContain('【机翻】 译：we need 值守舰队 now')

    // 删除后也失效
    await ownerSays(env, '纠错 删除 standing fleet')
    env.discordMessage({ content: 'we need standing fleet now' })
    await env.idle()
    expect(llm.texts).toHaveLength(3)
    expect(llm.texts[2]).toBe('we need standing fleet now')
  })

  it('回复一条转发过来的消息来纠错：取回原文，用新词条重新翻译，只回复在这个群里', async () => {
    env = await setup(translateOn())
    env.discordMessage({ content: 'we need standing fleet now' })
    await env.idle()
    const forwarded = env.qq.sent.at(-1)!
    expect(forwarded.text).toBe('[测试桥 - 舰长]\nwe need standing fleet now\n\n【机翻】 译：we need standing fleet now')
    // LLBot 的 get_msg 能取到这条机器人发的消息
    env.qq.messages.set(forwarded.id, {
      message_id: +forwarded.id, message_type: 'group', group_id: +QQ_GROUP, user_id: +QQ_BOT, time: 1,
      sender: { user_id: +QQ_BOT, nickname: 'bot', card: '机器人' }, message: forwarded.segments,
    })
    const postsBefore = env.discord.posts().length
    const replies = await ownerSays(env, '纠错 standing fleet = 值守舰队', forwarded.id, 400)
    expect(replies).toEqual([
      '已添加：standing fleet → 值守舰队（强制替换，英译中）',
      '用新词条重新翻译：\n【机翻】 译：we need 值守舰队 now',
    ])
    expect(llm.texts.at(-1)).toBe('we need ⟦G0⟧ now')
    // 命令和两条回复都不转发
    expect(env.discord.posts()).toHaveLength(postsBefore)
    expect(await rows(env)).toHaveLength(1)
  })

  it('Discord 上回复一条从 QQ 转过来的消息来纠错：中译英重新翻译，只回复在这个频道', async () => {
    env = await setup(translateOn())
    await env.app.database.createUser('discord', DC_USER, { authority: 4 })
    const ids: string[] = []
    env.discord.beforeRespond = (_req, id) => void ids.push(id)
    await env.qqMessage(text('今晚全员集结'))
    await env.idle()
    const forwarded = env.discord.posts().at(-1)!
    expect(forwarded.json.content).toBe('今晚全员集结\n\n【机翻】 EN: 今晚全员集结')
    const qqBefore = env.qq.sent.length
    env.discord.requests = []
    const quoted = {
      id: ids[0], channel_id: DC_CHANNEL, type: 0, content: forwarded.json.content, webhook_id: '990000000000000001',
      author: { id: '990000000000000001', username: forwarded.json.username, bot: true }, mentions: [], attachments: [], embeds: [],
      timestamp: new Date().toISOString(),
    }
    // 适配器会再取一次被回复的消息
    env.discord.fault('GET', new RegExp(`^/channels/${DC_CHANNEL}/messages/${ids[0]}$`), { status: 200, body: quoted }, 5)
    await discordCommand(env, '纠错 全员集结 = CTA', { message_reference: { message_id: ids[0], channel_id: DC_CHANNEL }, referenced_message: quoted })
    await sleep(300)
    await env.idle()
    const replies = env.discord.requests.filter((r) => r.method === 'POST' && r.path === `/channels/${DC_CHANNEL}/messages`).map((r) => r.json.content)
    expect(replies).toEqual(['已添加：全员集结 → CTA（强制替换，中译英）', '用新词条重新翻译：\n【机翻】 EN: 今晚CTA'])
    expect(llm.texts.at(-1)).toBe('今晚⟦G0⟧')
    expect(env.qq.sent.length).toBe(qqBefore)
  })

  it('回复模式下重新翻译失败：词条照样加上', async () => {
    env = await setup(translateOn())
    env.discordMessage({ content: 'we need standing fleet now' })
    await env.idle()
    const forwarded = env.qq.sent.at(-1)!
    env.qq.messages.set(forwarded.id, {
      message_id: +forwarded.id, message_type: 'group', group_id: +QQ_GROUP, user_id: +QQ_BOT, time: 1,
      sender: { user_id: +QQ_BOT, nickname: 'bot', card: '机器人' }, message: forwarded.segments,
    })
    await llm.stop()
    const replies = await ownerSays(env, '纠错 standing fleet = 值守舰队', forwarded.id, 1500)
    expect(replies[0]).toBe('已添加：standing fleet → 值守舰队（强制替换，英译中）')
    expect(replies[1]).toContain('词条已经加上了')
    expect(await rows(env)).toHaveLength(1)
    await llm.start()
  })

  it('回复的是普通消息（不是转发过来的）：只加词条，说明没有重新翻译', async () => {
    env = await setup(translateOn())
    const plain = text('普通聊天')
    await env.qqMessage(plain)
    await env.idle()
    env.qq.messages.set(String(plain.message_id), {
      message_id: plain.message_id, message_type: 'group', group_id: +QQ_GROUP, user_id: +QQ_USER, time: 1,
      sender: { user_id: +QQ_USER, nickname: '小明', card: '群名片小明' }, message: [{ type: 'text', data: { text: '普通聊天' } }],
    })
    const replies = await ownerSays(env, '纠错 standing fleet = 值守舰队', String(plain.message_id))
    expect(replies).toEqual(['已添加：standing fleet → 值守舰队（强制替换，英译中）', '被回复的不是转发过来的消息，没有重新翻译。'])
    expect(env.discord.posts().map((p) => p.json.content).join('\n')).not.toContain('纠错')
  })
})
