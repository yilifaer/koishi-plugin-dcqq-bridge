// 清单 §18.1 的 B5、B9、B13、B15、B16/B17 集成测试。所有 ID、名字都是编造的；只连 localhost。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from 'koishi'
import { OneBot } from 'koishi-plugin-adapter-onebot'
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { Config } from '../src/config'
import { describeError, redact } from '../src/log'
import { Relay } from '../src/relay'
import {
  bridge, DC_BOT, DC_CHANNEL, DC_CHANNEL2, DC_GUILD, discordPayload, Env, OWNER_QQ, QQ_BOT, QQ_GROUP, QQ_GROUP2, QQ_USER, qqPayload, setup, sleep, PR2_DEFAULTS } from './harness'

const ZW = '​'

let env: Env | undefined
afterEach(async () => {
  await env?.stop()
  env = undefined
})

// ------------------------------------------------------------------ 本地媒体服务器（给 QQ 图片 / 视频下载用）

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)])
const MP4 = Buffer.alloc(300, 3)
let media: http.Server
let mediaBase = ''
const mediaHits: string[] = []

beforeAll(async () => {
  media = http.createServer((req, res) => {
    mediaHits.push(req.url ?? '')
    if (req.url?.startsWith('/img')) {
      res.setHeader('Content-Type', 'image/png')
      return res.end(PNG)
    }
    if (req.url?.startsWith('/video')) {
      res.setHeader('Content-Type', 'video/mp4')
      return res.end(MP4)
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve) => media.listen(0, '127.0.0.1', resolve))
  mediaBase = `http://127.0.0.1:${(media.address() as AddressInfo).port}`
})

afterAll(async () => {
  media.closeAllConnections?.()
  await new Promise<void>((resolve) => media.close(() => resolve()))
})

// ------------------------------------------------------------------ 小工具

/**
 * FakeQQ 对 send_private_msg 返回 data: null，onebot 适配器读 message_id 时会抛错，
 * 命令回复（私聊、分段）在第一段之后就停了。这里让私聊也返回消息 ID。
 */
async function start(...args: Parameters<typeof setup>): Promise<Env> {
  const e = await setup(...args)
  const handle = e.qq.handle.bind(e.qq)
  let id = 8000
  e.qq.handle = (action: string, params: any) => {
    const result = handle(action, params)
    if (action === 'send_private_msg' && result?.status === 'ok') return { ...result, data: { message_id: ++id } }
    return result
  }
  return e
}

/** 去掉 Discord 转义的反斜杠，方便断言。 */
function unescape(s: string) {
  return s.replace(/\\([\\*_~`|[\]#>-])/g, '$1')
}

/** 某个时间点的 Discord snowflake（补发要求 6 小时内）。 */
function snowflakeAt(ms: number, seq: number) {
  return String(((BigInt(Math.floor(ms)) - 1420070400000n) << 22n) + BigInt(seq))
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(10)
  }
  throw new Error('等待超时')
}

/** 收集 Koishi 日志（所有 logger）。 */
function captureLogs() {
  const records: Array<{ name: string; type: string; content: string }> = []
  const target = { levels: { base: 3 }, record: (r: any) => records.push({ name: r.name, type: r.type, content: r.content }) }
  Logger.targets.push(target as any)
  return {
    records,
    ours: () => records.filter((r) => r.name === 'dcqq-bridge'),
    stop: () => {
      const i = Logger.targets.indexOf(target as any)
      if (i >= 0) Logger.targets.splice(i, 1)
    },
  }
}

function baseConfig(patch: Partial<Config> = {}): Config {
  return {
    discordSelfId: '',
    qqSelfId: '',
    timezone: 'Asia/Shanghai',
    discordAsWebhook: true,
    keepDays: 7,
    authority: 4,
    qqReorderMs: 0,
    bridges: [bridge()],
    atAll: { fallbackText: '【全体通知】', reserve: 0, dailyCap: 0, cooldownMinutes: 0, maxAgeMinutes: 10 },
    ...PR2_DEFAULTS,
    ...patch,
  }
}

function dispatchReady(e: Env) {
  e.dcBot.dispatch(e.dcBot.session({ type: 'internal', _type: 'discord/ready', _data: { user: { id: DC_BOT, username: 'bridge-bot' }, session_id: 's1' } }))
}

function historyGets(e: Env, channel = DC_CHANNEL) {
  return e.discord.requests.filter((r) => r.method === 'GET' && r.path.startsWith(`/channels/${channel}/messages`))
}

/** 等补发（READY 之后的异步流程）把消息放进队列并发完。 */
async function settleBackfill(e: Env) {
  await waitFor(() => historyGets(e).length > 0)
  await sleep(100)
  await e.idle()
}

// ================================================================== B5

describe('B5 QQ → Discord', () => {
  it('每种 QQ 元素都有输出，图片 / 表情包 / 视频下载后作为 multipart 文件上传', async () => {
    env = await start()
    env.qq.members.set(`${QQ_GROUP}:20002`, { role: 'member', card: '小红', nickname: 'hong' })
    mediaHits.length = 0
    await env.qqMessage(qqPayload([
      { type: 'text', data: { text: '开始 ' } },
      { type: 'at', data: { qq: '20003', name: '阿强' } },
      { type: 'text', data: { text: ' ' } },
      { type: 'at', data: { qq: '20002' } },
      { type: 'text', data: { text: ' ' } },
      { type: 'at', data: { qq: 'all' } },
      { type: 'face', data: { id: '14' } },
      { type: 'mface', data: { url: `${mediaBase}/img-mface.png`, summary: '[狗头]', emoji_id: 'e1', emoji_package_id: 1, key: 'k' } },
      { type: 'mface', data: { summary: '[无图]', emoji_id: 'e2' } },
      { type: 'image', data: { file: 'pic.png', url: `${mediaBase}/img-pic.png` } },
      { type: 'record', data: { file: 'voice.amr' } },
      { type: 'video', data: { file: 'clip.mp4', url: `${mediaBase}/video-clip.mp4` } },
      { type: 'file', data: { file: '报名表.xlsx', file_id: 'f1' } },
      { type: 'forward', data: { id: 'fw1' } },
      { type: 'json', data: { data: JSON.stringify({ app: 'com.tencent.miniapp', prompt: '周末活动报名' }) } },
      { type: 'markdown', data: { content: 'md 正文' } },
    ]))
    await env.idle()
    const posts = env.discord.posts()
    expect(posts).toHaveLength(1)
    const post = posts[0]
    const text = unescape(post.json.content)
    expect(text).toContain('开始 @阿强 @小红 @全体成员')
    expect(post.json.content).not.toContain('@everyone')
    expect(text).toContain('[微笑]')
    expect(text.match(/\[表情包\]/g)).toHaveLength(2)
    expect(text).toContain('[语音]')
    expect(text).toContain('[文件: 报名表.xlsx]')
    expect(text).toContain('[合并转发]')
    expect(text).toContain('[卡片: 周末活动报名]')
    expect(text).toContain('md 正文')
    // 下载成功的不写占位
    expect(text).not.toContain('[图片]')
    expect(text).not.toContain('[视频]')
    // 一次 multipart 请求，3 个文件：有地址的表情包、图片、视频
    expect(String(post.headers['content-type'])).toMatch(/^multipart\/form-data/)
    expect(post.files).toHaveLength(3)
    expect(post.files.map((f) => f.size).sort((a, b) => a - b)).toEqual([PNG.length, PNG.length, MP4.length])
    expect(post.files.some((f) => f.filename === 'pic.png')).toBe(true)
    expect(post.files.some((f) => /clip\.mp4$/.test(f.filename))).toBe(true)
    expect(post.json.attachments).toHaveLength(3)
    expect(post.json.allowed_mentions).toEqual({ parse: [] })
    expect(mediaHits.sort()).toEqual(['/img-mface.png', '/img-pic.png', '/video-clip.mp4'])
  })

  it('webhook 模式：<@123>、<@&123>、@everyone 被零宽空格打断，带 allowed_mentions', async () => {
    env = await start()
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: 'ping <@123> <@&123> @everyone @here <#456>' } }]))
    await env.idle()
    const [post] = env.discord.posts()
    expect(post.path).toMatch(/^\/webhooks\/\d+\/tok\d+\?wait=true$/)
    expect(post.json.allowed_mentions).toEqual({ parse: [] })
    expect(post.json.content).toBe(`ping <${ZW}@123> <${ZW}@&123> @${ZW}everyone @${ZW}here <${ZW}#456>`)
  })

  it('机器人模式：POST /channels/:id/messages，带 [桥名 - 名字] 前缀和 allowed_mentions', async () => {
    env = await start({ discordAsWebhook: false })
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '<@123> <@&123> @everyone' } }]))
    await env.idle()
    const posts = env.discord.posts()
    expect(posts).toHaveLength(1)
    expect(posts[0].path).toBe(`/channels/${DC_CHANNEL}/messages`)
    expect(posts[0].json.allowed_mentions).toEqual({ parse: [] })
    expect(posts[0].json.username).toBeUndefined()
    expect(unescape(posts[0].json.content)).toBe(`[测试桥 - 群名片小明] <${ZW}@123> <${ZW}@&123> @${ZW}everyone`)
    // 机器人模式不去取 webhook
    expect(env.discord.requests.some((r) => r.path.includes('/webhooks'))).toBe(false)
  })

  it('webhook 用户名：Discord / clyde 被拆开，全是空白用 QQ用户', async () => {
    env = await start()
    const send = async (card: string) => {
      await env!.qqMessage(qqPayload([{ type: 'text', data: { text: 'hi' } }], { sender: { user_id: +QQ_USER, nickname: 'nick', card, role: 'member' } }))
      await env!.idle()
      return env!.discord.posts().at(-1)!.json.username as string
    }
    const u1 = await send('Discord Fan')
    expect(u1).toBe(`[测试桥] Disc${ZW}ord Fan`)
    expect(u1.toLowerCase()).not.toContain('discord')
    const u2 = await send('CLYDE')
    expect(u2).toBe(`[测试桥] CL${ZW}YDE`)
    const u3 = await send('   ')
    expect(u3.trim()).toBe(u3)
    expect(u3).toBe('[测试桥] QQ用户')
  })

  it('webhook 用户名：桥名为空、名字全是空白 → QQ用户', async () => {
    env = await start({ bridges: [bridge({ label: '' })] })
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: 'hi' } }], { sender: { user_id: +QQ_USER, nickname: ' ', card: '  ', role: 'member' } }))
    await env.idle()
    expect(env.discord.posts()[0].json.username).toBe('QQ用户')
  })

  it('回复时 QQ 自动带的、指向机器人自己的 @ 被去掉', async () => {
    env = await start()
    const original = qqPayload([{ type: 'text', data: { text: '原消息' } }])
    await env.qqMessage(original)
    await env.idle()
    env.qq.messages.set(String(original.message_id), {
      message_id: original.message_id, message_type: 'group', group_id: +QQ_GROUP, user_id: +QQ_USER, time: 1,
      sender: { user_id: +QQ_USER, nickname: '小明', card: '群名片小明' }, message: [{ type: 'text', data: { text: '原消息' } }],
    })
    await env.qqMessage(qqPayload([
      { type: 'reply', data: { id: String(original.message_id) } },
      { type: 'at', data: { qq: QQ_BOT } },
      { type: 'text', data: { text: ' 收到' } },
    ]))
    await env.idle()
    const posts = env.discord.posts()
    expect(posts).toHaveLength(2)
    const content = unescape(posts[1].json.content)
    expect(content).not.toContain('@机器人')
    expect(content).not.toContain(`@${QQ_BOT}`)
    expect(content).toMatch(/↪ 回复 群名片小明：原消息/)
    expect(content.split('\n').at(-1)).toBe('收到')
  })

  it('onebot 取不到被回复的消息（get_msg 失败）时，回复 ID 仍然从原始数据取到', async () => {
    env = await start()
    const ids: string[] = []
    env.discord.beforeRespond = (_req, id) => void ids.push(id)
    const original = qqPayload([{ type: 'text', data: { text: '第一条' } }])
    await env.qqMessage(original)
    await env.idle()
    expect(ids).toHaveLength(1)
    // qq.messages 里没有这条 → get_msg 失败
    await env.qqMessage(qqPayload([
      { type: 'reply', data: { id: String(original.message_id) } },
      { type: 'text', data: { text: '回复内容' } },
    ]))
    await env.idle()
    expect(env.qq.calls.some((c) => c.action === 'get_msg')).toBe(true)
    const posts = env.discord.posts()
    expect(posts).toHaveLength(2)
    expect(posts[1].json.content).toContain(`https://discord.com/channels/${DC_GUILD}/${DC_CHANNEL}/${ids[0]}`)
    expect(unescape(posts[1].json.content)).toContain('回复内容')
  })

  it('onebot 取不到被回复的消息时，机器人模式用 message_reference 回复', async () => {
    env = await start({ discordAsWebhook: false })
    const ids: string[] = []
    env.discord.beforeRespond = (_req, id) => void ids.push(id)
    const original = qqPayload([{ type: 'text', data: { text: '第一条' } }])
    await env.qqMessage(original)
    await env.idle()
    await env.qqMessage(qqPayload([
      { type: 'reply', data: { id: String(original.message_id) } },
      { type: 'text', data: { text: '回复内容' } },
    ]))
    await env.idle()
    const posts = env.discord.posts()
    expect(posts).toHaveLength(2)
    expect(posts[1].json.message_reference).toEqual({ message_id: ids[0], fail_if_not_exists: false })
  })

  it('webhook 不可用（403 / 50013）→ 改用机器人模式发送，带前缀（O7）', async () => {
    env = await start()
    const logs = captureLogs()
    try {
      env.discord.fault('GET', /^\/channels\/\d+\/webhooks$/, { status: 403, body: { message: 'Missing Permissions', code: 50013 } }, 10)
      env.discord.fault('POST', /^\/channels\/\d+\/webhooks$/, { status: 403, body: { message: 'Missing Permissions', code: 50013 } }, 10)
      await env.qqMessage(qqPayload([{ type: 'text', data: { text: '@everyone 你好' } }]))
      await env.idle()
      await env.qqMessage(qqPayload([{ type: 'text', data: { text: '第二条' } }]))
      await env.idle()
      const posts = env.discord.posts()
      expect(posts).toHaveLength(2)
      expect(posts[0].path).toBe(`/channels/${DC_CHANNEL}/messages`)
      expect(posts[0].json.allowed_mentions).toEqual({ parse: [] })
      expect(unescape(posts[0].json.content)).toBe(`[测试桥 - 群名片小明] @${ZW}everyone 你好`)
      expect(unescape(posts[1].json.content)).toBe('[测试桥 - 群名片小明] 第二条')
      // 每个频道每小时只警告一次
      const warns = logs.ours().filter((r) => r.content.includes('无法使用 webhook'))
      expect(warns).toHaveLength(1)
      expect(warns[0].content).toContain('HTTP 403')
    } finally {
      logs.stop()
    }
  })
})

// ================================================================== B9

describe('B9 屏蔽词', () => {
  it('命中 embed 里的文字 → 不转发（不区分大小写）', async () => {
    env = await start({ bridges: [bridge({ blockWords: 'forbidden' })] })
    env.discordMessage({ content: '看这个', embeds: [{ type: 'rich', title: '公告', description: 'This is FORBIDDEN stuff' }] })
    env.discordMessage({ content: '普通消息' })
    await env.idle()
    const texts = env.qq.text(QQ_GROUP)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('普通消息')
  })

  it('写错的正则只跳过那一条，其余照常屏蔽，并在状态里提示', async () => {
    env = await start({ bridges: [bridge({ blockWords: 'foo(;;spam\\d+;;广告' })] })
    env.discordMessage({ content: 'SPAM123 here' })
    env.discordMessage({ content: '这是广告' })
    env.discordMessage({ content: 'foo( 本身' })
    env.discordMessage({ content: '正常内容' })
    await env.idle()
    const texts = env.qq.text(QQ_GROUP)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('foo( 本身')
    expect(texts[1]).toContain('正常内容')
    const row = env.relay.settings.rows[0]
    expect(row.warnings.some((w) => w.includes('foo('))).toBe(true)
    // QQ → Discord 方向同样屏蔽（不区分大小写）
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: 'spam42' } }]))
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: 'ok' } }]))
    await env.idle()
    expect(env.discord.posts().map((p) => p.json.content)).toEqual(['ok'])
    const status = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
    expect(status).toContain('屏蔽词写错，已跳过：foo(')
  })
})

// ================================================================== B13

describe('B13 管理命令', () => {
  it('权限不够的用户被拒绝', async () => {
    env = await start()
    const replies = await env.command(QQ_USER, 'bridge.status')
    const text = replies.join('\n')
    expect(text).not.toContain('测试桥')
    expect(text).not.toContain('24 小时')
    await env.command(QQ_USER, 'bridge.pause')
    expect(env.relay.isPaused()).toBe(false)
    // 有权限的人可以
    const owner = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
    expect(owner).toContain('测试桥')
  })

  it('桥名匹配到多个桥时列出候选并拒绝', async () => {
    env = await start({ bridges: [bridge({ label: '同名' }), bridge({ label: '同名', discord: DC_CHANNEL2, qq: QQ_GROUP2 })] })
    const text = (await env.command(OWNER_QQ, 'bridge.pause 同名')).join('\n')
    expect(text).toContain('有多个桥叫「同名」')
    expect(text).toContain(`1. ${DC_CHANNEL}:${QQ_GROUP}`)
    expect(text).toContain(`2. ${DC_CHANNEL2}:${QQ_GROUP2}`)
    expect(env.relay.settings.bridges.some((b) => env!.relay.isPaused(b))).toBe(false)
    // 用编号可以
    const ok = (await env.command(OWNER_QQ, 'bridge.pause 2')).join('\n')
    expect(ok).toContain('已暂停')
    expect(env.relay.isPaused(env.relay.settings.bridges[1])).toBe(true)
    expect(env.relay.isPaused(env.relay.settings.bridges[0])).toBe(false)
  })

  it('暂停在重载后仍然有效（新的 Relay 读同一个数据库）', async () => {
    const config = baseConfig({ bridges: [bridge(), bridge({ label: '第二桥', discord: DC_CHANNEL2, qq: QQ_GROUP2 })] })
    env = await start({ bridges: config.bridges })
    expect((await env.command(OWNER_QQ, 'bridge.pause 2')).join('\n')).toContain('已暂停')
    const r1 = new Relay(env.app, config, { timers: false })
    await r1.start()
    expect(r1.isPaused()).toBe(false)
    expect(r1.isPaused(r1.settings.bridges[1])).toBe(true)
    expect(r1.isPaused(r1.settings.bridges[0])).toBe(false)
    await r1.dispose()

    expect((await env.command(OWNER_QQ, 'bridge.pause')).join('\n')).toContain('已全局暂停')
    const r2 = new Relay(env.app, config, { timers: false })
    await r2.start()
    expect(r2.isPaused()).toBe(true)
    await r2.dispose()

    await env.command(OWNER_QQ, 'bridge.resume')
    const r3 = new Relay(env.app, config, { timers: false })
    await r3.start()
    expect(r3.isPaused()).toBe(false)
    expect(r3.isPaused(r3.settings.bridges[1])).toBe(true)
    await r3.dispose()
  })

  it('群里的 bridge.status 只显示这个群的桥', async () => {
    env = await start({ bridges: [bridge({ label: '甲桥' }), bridge({ label: '乙桥', discord: DC_CHANNEL2, qq: QQ_GROUP2 })] })
    const text = (await env.command(OWNER_QQ, 'bridge.status', QQ_GROUP)).join('\n')
    expect(text).toContain('甲桥')
    expect(text).not.toContain('乙桥')
    const all = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
    expect(all).toContain('甲桥')
    expect(all).toContain('乙桥')
  })

  it('bridge.import 在群里被拒绝', async () => {
    env = await start()
    ;(env.app as any).set('loader', { config: { plugins: {} } })
    const text = (await env.command(OWNER_QQ, 'bridge.import', QQ_GROUP)).join('\n')
    expect(text).toContain('请私聊')
    expect(text).not.toContain('生成了')
  })

  it('bridge.import 私聊：回复报告和 YAML，并把 YAML 写到 data/dcqq-bridge 下', async () => {
    env = await start()
    const dir = await mkdtemp(join(tmpdir(), 'dcqq-import-'))
    try {
      ;(env.app as any).baseDir = dir
      const old = {
        constants: {
          dcAlpha: { type: 'full', name: 'Discord-Alpha', platform: 'discord', channelId: '100000000000000001', selfId: '9001' },
          qqAlpha: { type: 'full', name: 'QQ-Alpha', platform: 'onebot', channelId: '20000001', selfId: '9002' },
        },
        rules: [{ source: 'dcAlpha', targets: ['qqAlpha'] }, { source: 'qqAlpha', targets: ['dcAlpha'] }],
      }
      ;(env.app as any).set('loader', { config: { plugins: { 'group:chat': { '~@myrtus/forward:x1': old } } } })
      const text = (await env.command(OWNER_QQ, 'bridge.import')).join('\n')
      expect(text).toContain('生成了 1 个桥')
      expect(text).toContain('旧插件目前是停用状态')
      expect(text).toMatch(/discord: ['"]100000000000000001['"]/)
      expect(text).toMatch(/qq: ['"]20000001['"]/)
      expect(text).toMatch(/label: ['"]?Alpha['"]?/)
      const files = await readdir(join(dir, 'data', 'dcqq-bridge'))
      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/^import-.*\.yaml$/)
      const saved = await readFile(join(dir, 'data', 'dcqq-bridge', files[0]), 'utf8')
      expect(saved).toMatch(/discord: ['"]100000000000000001['"]/)
      expect(text).toContain(join(dir, 'data', 'dcqq-bridge', files[0]))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('bridge.import 没有 loader 时回复「无法读取配置」', async () => {
    env = await start()
    const text = (await env.command(OWNER_QQ, 'bridge.import')).join('\n')
    expect(text).toContain('无法读取配置')
  })

  it('发送失败后 bridge.status 显示「最近一次失败」（只有原因，没有内容）', async () => {
    env = await start()
    env.discord.fault('POST', /^\/webhooks\//, { status: 400, body: { message: 'Invalid Form Body', code: 50035 } })
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '机密-内容-甲乙丙' } }]))
    await env.idle()
    const text = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
    expect(text).toContain('最近一次失败：HTTP 400 code 50035')
    expect(text).toContain('失败 1')
    expect(text).not.toContain('机密-内容-甲乙丙')
  })
})

// ================================================================== B15

describe('B15 断线补发', () => {
  it('没有 lastseen 时不补发，只用频道的 last_message_id 初始化', async () => {
    const last = snowflakeAt(Date.now() - 60000, 5)
    env = await start({}, { before: ({ discord }) => void (discord.channels.get(DC_CHANNEL)!.last_message_id = last) })
    env.discord.history.set(DC_CHANNEL, [discordPayload({ id: snowflakeAt(Date.now() - 120000, 1), content: '旧消息' })])
    dispatchReady(env)
    await waitFor(async () => (await env!.relay.store.get<string>(`lastseen:${DC_CHANNEL}`)) === last)
    await sleep(100)
    await env.idle()
    expect(historyGets(env)).toHaveLength(0)
    expect(env.qq.sent).toHaveLength(0)
  })

  it('READY 后补发 lastseen 之后的消息，标（补发），不 @全体；RESUMED 后不补', async () => {
    const t = Date.now()
    env = await start({ bridges: [bridge({ atAll: true })] })
    // 实时消息确定 lastseen
    env.discordMessage({ id: snowflakeAt(t - 3600000, 1), content: '断线前' })
    await env.idle()
    expect(env.qq.text()).toHaveLength(1)
    env.discord.history.set(DC_CHANNEL, [
      discordPayload({ id: snowflakeAt(t - 3600000, 1), content: '断线前' }),
      discordPayload({ id: snowflakeAt(t - 1800000, 1), content: '@everyone 集合', mention_everyone: true }),
      discordPayload({ id: snowflakeAt(t - 1700000, 1), content: '第二条' }),
    ])
    env.dcBot.dispatch(env.dcBot.session({ type: 'internal', _type: 'discord/resumed', _data: {} }))
    await sleep(200)
    await env.idle()
    expect(historyGets(env)).toHaveLength(0)
    expect(env.qq.text()).toHaveLength(1)

    dispatchReady(env)
    await settleBackfill(env)
    const texts = env.qq.text()
    expect(texts).toHaveLength(3)
    expect(texts[1]).toContain('[测试桥 - 舰长（补发）]')
    expect(texts[1]).toContain('@everyone 集合')
    expect(texts[2]).toContain('[测试桥 - 舰长（补发）]')
    expect(texts[2]).toContain('第二条')
    for (const s of env.qq.sent) expect(s.segments.some((seg: any) => seg.type === 'at' && seg.data.qq === 'all')).toBe(false)
    expect(historyGets(env)[0].path).toContain(`after=${snowflakeAt(t - 3600000, 1)}`)
  })

  it('补发跳过自己的 webhook 消息（重启后内存集合里没有这个 webhook 时靠对应表）', async () => {
    const t = Date.now()
    env = await start()
    env.discordMessage({ id: snowflakeAt(t - 3600000, 1), content: '断线前' })
    await env.idle()
    const echoId = snowflakeAt(t - 1800000, 1)
    await env.relay.store.addMapping({
      srcPlatform: 'onebot', srcChannel: QQ_GROUP, srcMessage: '31999', dstPlatform: 'discord', dstChannel: DC_CHANNEL, dstMessage: echoId, part: 0, srcAuthor: '群名片小明',
    }, new Date(env.clock.now))
    env.discord.history.set(DC_CHANNEL, [
      discordPayload({ id: echoId, content: '从 QQ 转过来的', webhook_id: '977000000000000001', author: { id: '977000000000000001', username: '[测试桥] 群名片小明', bot: true } }),
      discordPayload({ id: snowflakeAt(t - 1700000, 1), content: '真人消息' }),
    ])
    expect(env.relay.sender.ownWebhooks.has('977000000000000001')).toBe(false)
    dispatchReady(env)
    await settleBackfill(env)
    const texts = env.qq.text()
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain('真人消息')
    expect(texts.join('\n')).not.toContain('从 QQ 转过来的')
  })

  it('补发跳过当前 webhook 发出的消息', async () => {
    const t = Date.now()
    env = await start()
    // 先让插件建好 webhook
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: 'x' } }]))
    await env.idle()
    const wh = env.discord.webhooks.get(DC_CHANNEL)![0]
    env.discordMessage({ id: snowflakeAt(t - 3600000, 1), content: '断线前' })
    await env.idle()
    env.discord.history.set(DC_CHANNEL, [
      discordPayload({ id: snowflakeAt(t - 1800000, 2), content: '别的回声', webhook_id: wh.id, author: { id: wh.id, username: 'x', bot: true } }),
    ])
    dispatchReady(env)
    await settleBackfill(env)
    expect(env.qq.text()).toHaveLength(1)
  })

  it('超过 100 条时翻页', async () => {
    const t = Date.now()
    env = await start()
    env.discordMessage({ id: snowflakeAt(t - 3600000, 1), content: '断线前' })
    await env.idle()
    env.discord.history.set(DC_CHANNEL, Array.from({ length: 150 }, (_, i) => discordPayload({ id: snowflakeAt(t - 1800000, i + 1), content: `补${i + 1}` })))
    dispatchReady(env)
    await settleBackfill(env)
    const texts = env.qq.text().slice(1)
    expect(texts).toHaveLength(150)
    expect(texts[0]).toContain('补1')
    expect(texts[149]).toContain('补150')
    // 顺序不乱
    texts.forEach((s, i) => expect(s.endsWith(`补${i + 1}`)).toBe(true))
    expect(historyGets(env).length).toBeGreaterThanOrEqual(2)
  })

  it('每个频道最多补发 200 条，超出的写日志', async () => {
    const t = Date.now()
    env = await start()
    env.discordMessage({ id: snowflakeAt(t - 3600000, 1), content: '断线前' })
    await env.idle()
    const logs = captureLogs()
    try {
      env.discord.history.set(DC_CHANNEL, Array.from({ length: 250 }, (_, i) => discordPayload({ id: snowflakeAt(t - 1800000, i + 1), content: `补${i + 1}` })))
      dispatchReady(env)
      await settleBackfill(env)
      const texts = env.qq.text().slice(1)
      expect(texts).toHaveLength(200)
      expect(texts[199].endsWith('补200')).toBe(true)
      expect(texts.some((s) => s.endsWith('补201'))).toBe(false)
      expect(logs.ours().some((r) => r.content.includes('超过 200'))).toBe(true)
    } finally {
      logs.stop()
    }
  })

  it('补发期间到达的实时消息不会让缺口消失（READY 时同步取快照），同一条也只发一次', async () => {
    const t = Date.now()
    env = await start()
    env.discordMessage({ id: snowflakeAt(t - 3600000, 1), content: '断线前' })
    await env.idle()
    const liveId = snowflakeAt(t - 1000, 1)
    env.discord.history.set(DC_CHANNEL, [
      discordPayload({ id: snowflakeAt(t - 1800000, 1), content: '缺口一' }),
      discordPayload({ id: snowflakeAt(t - 1700000, 1), content: '缺口二' }),
      discordPayload({ id: liveId, content: '实时' }),
    ])
    dispatchReady(env)
    env.discordMessage({ id: liveId, content: '实时' })
    await settleBackfill(env)
    const texts = env.qq.text().slice(1)
    expect(texts).toHaveLength(3)
    expect(texts.filter((s) => s.includes('缺口一'))).toHaveLength(1)
    expect(texts.filter((s) => s.includes('缺口二'))).toHaveLength(1)
    expect(texts.filter((s) => s.includes('实时'))).toHaveLength(1)
    expect(historyGets(env)[0].path).toContain(`after=${snowflakeAt(t - 3600000, 1)}`)
  })
})

// ================================================================== B16 / B17

describe('B16/B17 自检和日志脱敏', () => {
  it('atAll 桥的机器人不是管理员 → 标「⚠ 不是管理员」，桥照常工作', async () => {
    env = await start({ bridges: [bridge({ atAll: true })] }, {
      before: ({ qq }) => void qq.members.set(`${QQ_GROUP}:${QQ_BOT}`, { role: 'member', card: '机器人', nickname: 'bot' }),
    })
    await env.relay.selfCheck()
    const key = env.relay.settings.bridges[0].key
    expect(env.relay.health.get(key)).toContain('⚠ 不是管理员')
    const status = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
    expect(status).toContain('⚠ 不是管理员')
    // 只标一个 ⚠（health 里的问题本身已经带 ⚠，状态行不应再加一个）
    expect(status).not.toContain('⚠ ⚠')
    expect(status).toContain('启用')
    env.discordMessage({ content: '照常转发' })
    await env.idle()
    expect(env.qq.text().some((s) => s.includes('照常转发'))).toBe(true)
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '反向也行' } }]))
    await env.idle()
    expect(env.discord.posts().some((p) => p.json.content === '反向也行')).toBe(true)
  })

  it('redact / describeError 替换错误网址里的 webhook token', () => {
    expect(redact('POST https://discord.com/api/v10/webhooks/123/secrettoken?wait=true failed')).toBe('POST https://discord.com/api/v10/webhooks/123/***?wait=true failed')
    expect(redact('/webhooks/123/secrettoken')).toBe('/webhooks/123/***')
    const plain = describeError({ name: 'HTTPError', message: 'request to https://discord.com/api/v10/webhooks/123/secrettoken?wait=true failed, reason: socket hang up' })
    expect(plain).not.toContain('secrettoken')
    expect(plain).toContain('/webhooks/123/***')
    const fetchError = describeError(Object.assign(new Error('fetch https://discord.com/api/v10/webhooks/123/secrettoken?wait=true failed'), { cause: { code: 'ECONNRESET' } }))
    expect(fetchError).not.toContain('secrettoken')
    const httpError = describeError({ [Symbol.for('cordis.http.error')]: true, message: 'POST /webhooks/123/secrettoken 500', response: { status: 500, url: 'https://discord.com/api/v10/webhooks/123/secrettoken', data: { code: 0, message: 'x' } } })
    expect(httpError).toBe('HTTP 500 code 0')
    expect(describeError('/webhooks/123/secrettoken')).not.toContain('secrettoken')
  })

  it('onebot 的 TimeoutError / SenderError 只记类型、动作名和 retcode，不记内容', async () => {
    const timeout = new OneBot.TimeoutError({ group_id: 1, message: [{ type: 'text', data: { text: '机密内容' } }] }, 'send_group_msg')
    const described = describeError(timeout)
    expect(described).toBe('TimeoutError send_group_msg')
    expect(described).not.toContain('机密内容')

    env = await start()
    env.qq.faults.set('send_group_msg', 'fail')
    let sender: any
    try {
      await env.qqBot.internal.sendGroupMsg(QQ_GROUP, '机密内容')
    } catch (e) {
      sender = e
    }
    expect(sender).toBeTruthy()
    expect(String(sender.message)).toContain('机密内容')
    const d2 = describeError(sender)
    expect(d2).toBe('SenderError send_group_msg retcode 1200')
  })

  it('QQ 发送失败时插件的日志里没有消息正文', async () => {
    env = await start()
    const logs = captureLogs()
    try {
      env.qq.faults.set('send_group_msg', 'timeout')
      env.discordMessage({ content: '绝密-集合点-乙7' })
      await env.idle()
      env.qq.faults.set('send_group_msg', 'fail')
      env.discordMessage({ content: '绝密-集合点-丙8' })
      await env.idle()
      const ours = logs.ours()
      const fails = ours.filter((r) => r.content.includes('转发失败'))
      expect(fails).toHaveLength(2)
      expect(fails[0].content).toContain('TimeoutError send_group_msg')
      expect(fails[1].content).toContain('SenderError send_group_msg retcode 1200')
      for (const r of ours) {
        expect(r.content).not.toContain('绝密')
        expect(r.content).not.toContain('集合点')
      }
      const status = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
      expect(status).toContain('最近一次失败：SenderError send_group_msg retcode 1200')
      expect(status).not.toContain('绝密')
    } finally {
      logs.stop()
    }
  })
})
