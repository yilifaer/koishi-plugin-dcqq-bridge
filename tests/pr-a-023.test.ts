// PR A（0.2.3）的 A8 测试：本插件的命令不转发、自检去重、@全体 剩余次数实时查询、时间带时区、统计开始时间。
// 所有 ID、名字都是编造的；只连 localhost。

import { afterEach, describe, expect, it } from 'vitest'
import { statusText, timeFormatter } from '../src/commands'
import { utcOffset } from '../src/util'
import {
  baseConfig, bridge, DC_BOT, DC_CHANNEL, DC_CHANNEL2, Env, installRelay, OWNER_QQ, QQ_BOT, QQ_GROUP, QQ_GROUP2, qqPayload, QQ_USER, setup, sleep,
} from './harness'

let env: Env | undefined
afterEach(async () => {
  await env?.stop()
  env = undefined
})

const text = (t: string) => qqPayload([{ type: 'text', data: { text: t } }])

// ================================================================== A8-1 本插件的命令不转发

describe('A8 本插件的命令不转发', () => {
  it('QQ 群里所有者发的 bridge.status 不转发到 Discord，回复照常发在群里', async () => {
    env = await setup()
    const replies = await env.command(OWNER_QQ, 'bridge.status', QQ_GROUP)
    await env.idle()
    expect(replies.join('\n')).toContain('测试桥')
    expect(env.discord.posts()).toHaveLength(0)
    // 普通消息照常转发
    await env.qqMessage(text('大家好'))
    await env.idle()
    expect(env.discord.posts().map((p) => p.json.content)).toEqual(['大家好'])
  })

  it('子命令、中文别名、带参数、空格写法、没有权限的人发的都不转发', async () => {
    env = await setup()
    for (const t of ['bridge.status 1', '桥接状态', 'bridge status', 'bridge  status -a', 'BRIDGE.STATUS', 'bridge.reload', 'bridge.import', '桥接恢复 1']) {
      await env.qqMessage(text(t))
    }
    // 没有权限的人发也不转发（命令被拒绝，但它仍然是本插件的命令）
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: 'bridge.pause' } }], { user_id: +QQ_USER }))
    await env.idle()
    expect(env.discord.posts()).toHaveLength(0)
    expect(env.relay.isPaused()).toBe(false)
  })

  it('开头 @机器人 的命令也不转发；@别人 开头的普通消息照常转发', async () => {
    env = await setup()
    await env.qqMessage(qqPayload([{ type: 'at', data: { qq: QQ_BOT } }, { type: 'text', data: { text: ' bridge.status' } }]))
    await env.idle()
    expect(env.discord.posts()).toHaveLength(0)
    await env.qqMessage(qqPayload([{ type: 'at', data: { qq: QQ_USER } }, { type: 'text', data: { text: ' 你好' } }]))
    await env.idle()
    expect(env.discord.posts()).toHaveLength(1)
  })

  it('配置了前缀：带不带前缀都不转发；其他插件的命令照常转发', async () => {
    env = await setup()
    ;(env.app.root.config as any).prefix = ['!', '#']
    env.app.command('jita <item:text>').alias('吉他').action(() => 'price')
    await env.qqMessage(text('!bridge.status'))
    await env.qqMessage(text('#桥接状态'))
    await env.qqMessage(text('bridge.status'))
    await env.qqMessage(text('!jita plex'))
    await env.qqMessage(text('吉他 伊甸币'))
    await env.idle()
    expect(env.discord.posts().map((p) => p.json.content)).toEqual(['!jita plex', '吉他 伊甸币'])
  })

  it('以后加在 bridge 下面的新命令自动算本插件的命令', async () => {
    env = await setup()
    // 模拟下一个版本加的命令：挂在本插件的 bridge 下面
    env.app.command('bridge.later-fix').alias('纠错测试').action(() => 'ok')
    await env.qqMessage(text('bridge.later-fix 原文 译文'))
    await env.qqMessage(text('纠错测试 原文 译文'))
    await env.idle()
    expect(env.discord.posts()).toHaveLength(0)
  })

  it('Discord 频道里的命令不转发到 QQ（带前缀、@机器人 开头都算）；其他插件的命令照常转发', async () => {
    env = await setup()
    ;(env.app.root.config as any).prefix = ['!']
    env.app.command('jita <item:text>').action(() => 'price')
    env.discordMessage({ content: 'bridge.status' })
    env.discordMessage({ content: '!bridge.pause 1' })
    env.discordMessage({ content: `<@${DC_BOT}> 桥接状态` })
    env.discordMessage({ content: `<@!${DC_BOT}> bridge.status` })
    env.discordMessage({ content: 'jita plex' })
    env.discordMessage({ content: '正常消息' })
    await env.idle()
    const sent = env.qq.text(QQ_GROUP)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toContain('jita plex')
    expect(sent[1]).toContain('正常消息')
    expect(env.relay.isPaused()).toBe(false)
  })

  it('只有「bridge」一个词（后面不是子命令）不算命令，照常转发', async () => {
    env = await setup()
    await env.qqMessage(text('bridge'))
    await env.qqMessage(text('bridge is down'))
    await env.qqMessage(text('bridge 修好了吗'))
    await env.idle()
    expect(env.discord.posts().map((p) => p.json.content)).toEqual(['bridge', 'bridge is down', 'bridge 修好了吗'])
  })

  it('isOwnCommand：解析不到、别的插件的顶层命令、空消息都不算', async () => {
    env = await setup()
    env.app.command('other.status').action(() => 'x')
    expect(env.relay.isOwnCommand('')).toBe(false)
    expect(env.relay.isOwnCommand('   ')).toBe(false)
    expect(env.relay.isOwnCommand('bridgeX')).toBe(false)
    expect(env.relay.isOwnCommand('bridge')).toBe(false)
    expect(env.relay.isOwnCommand('bridge status')).toBe(true)
    expect(env.relay.isOwnCommand('other.status')).toBe(false)
    expect(env.relay.isOwnCommand('bridge.resume -t')).toBe(true)
    expect(env.relay.isOwnCommand('桥接暂停')).toBe(true)
  })
})

// ================================================================== A8-2 自检去重

describe('A8 自检按群、按频道去重', () => {
  it('10 个桥指向同一个 QQ 群：每个群、每个频道只查一次，问题照样标到每个桥上', async () => {
    // 10 个不同的频道（其中两个各被两个桥用到：一个 d2q、一个 q2d）都指向同一个群
    const channels = Array.from({ length: 8 }, (_, i) => `92000000000000010${i}`)
    const bridges = [
      ...channels.map((discord, i) => bridge({ label: `桥${i + 1}`, discord, qq: QQ_GROUP, atAll: true })),
      bridge({ label: '桥9', discord: DC_CHANNEL, qq: QQ_GROUP, atAll: true }),
      bridge({ label: '桥10', discord: DC_CHANNEL2, qq: QQ_GROUP, atAll: true }),
    ]
    env = await setup({ bridges }, {
      before: ({ discord, qq }) => {
        for (const id of channels) discord.channels.set(id, { id, guild_id: '910000000000000001', name: '编造频道' })
        qq.members.set(`${QQ_GROUP}:${QQ_BOT}`, { role: 'member', card: '机器人', nickname: 'bot' })
      },
    })
    expect(env.relay.settings.bridges).toHaveLength(10)
    env.qq.calls = []
    env.discord.requests = []
    await env.relay.selfCheck()
    const count = (action: string) => env!.qq.calls.filter((c) => c.action === action).length
    expect(count('get_group_info')).toBe(1)
    expect(count('get_group_member_info')).toBe(1)
    const gets = (path: string) => env!.discord.requests.filter((r) => r.method === 'GET' && r.path === path).length
    for (const id of [...channels, DC_CHANNEL, DC_CHANNEL2]) {
      expect(gets(`/channels/${id}`)).toBe(1)
      expect(gets(`/channels/${id}/webhooks`)).toBeLessThanOrEqual(1)
    }
    for (const b of env.relay.settings.bridges) expect(env.relay.health.get(b.key)).toContain('⚠ 不是管理员')
  })

  it('不同的群分别查；每次自检重新查', async () => {
    env = await setup({ bridges: [bridge(), bridge({ label: '二', qq: QQ_GROUP2 }), bridge({ label: '三', discord: DC_CHANNEL2, qq: QQ_GROUP2 })] })
    env.qq.calls = []
    await env.relay.selfCheck()
    const groups = () => env!.qq.calls.filter((c) => c.action === 'get_group_info').map((c) => String(c.params.group_id)).sort()
    expect(groups()).toEqual([QQ_GROUP, QQ_GROUP2].sort())
    await env.relay.selfCheck()
    expect(groups()).toHaveLength(4)
  })

  it('查不到的群：指向它的每个桥都标出问题', async () => {
    env = await setup({ bridges: [bridge(), bridge({ label: '二', discord: DC_CHANNEL2 })] })
    env.qq.faults.set('get_group_info', 'fail')
    env.qq.calls = []
    await env.relay.selfCheck()
    expect(env.qq.calls.filter((c) => c.action === 'get_group_info')).toHaveLength(1)
    for (const b of env.relay.settings.bridges) expect(env.relay.health.get(b.key)?.some((p) => p.startsWith('取不到 QQ 群'))).toBe(true)
  })
})

// ================================================================== A8-3 @全体 剩余次数

describe('A8 bridge.status 实时查询 @全体 剩余次数', () => {
  it('没有缓存时也实时查到；同一个群的多个桥只查一次，并更新缓存', async () => {
    env = await setup({ bridges: [bridge({ atAll: true }), bridge({ label: '二', discord: DC_CHANNEL2, atAll: true }), bridge({ label: '三', qq: QQ_GROUP2 })] })
    env.qq.atAllRemain = { can_at_all: true, remain_at_all_count_for_group: 9, remain_at_all_count_for_uin: 4 }
    env.qq.calls = []
    const status = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
    expect(status).toContain('剩余 4 / 9（机器人 / 全群）')
    expect(status).not.toContain('未知')
    const calls = env.qq.calls.filter((c) => c.action === 'get_group_at_all_remain')
    expect(calls.map((c) => String(c.params.group_id))).toEqual([QQ_GROUP])
    expect(env.relay.gate.remain.get(QQ_GROUP)).toMatchObject({ forGroup: 9, forUin: 4 })
  })

  it('查询出错：写「查询失败：原因」；以前查到过时附上那次的结果', async () => {
    env = await setup({ bridges: [bridge({ atAll: true })] })
    env.qq.faults.set('get_group_at_all_remain', 'fail')
    let status = await statusText(env.relay, () => true)
    expect(status).toMatch(/剩余 查询失败：SenderError get_group_at_all_remain retcode 1200$/m)
    env.qq.faults.delete('get_group_at_all_remain')
    await statusText(env.relay, () => true)
    env.qq.faults.set('get_group_at_all_remain', 'fail')
    status = await statusText(env.relay, () => true)
    expect(status).toMatch(/剩余 查询失败：SenderError get_group_at_all_remain retcode 1200（上次查到 10 \/ 10，\d\d\/\d\d \d\d:\d\d \(UTC\+8\)）/)
  })

  it('返回的内容不对 → 「查询失败：返回的内容不对」', async () => {
    env = await setup({ bridges: [bridge({ atAll: true })] })
    env.qq.atAllRemain = { can_at_all: 'yes' }
    expect(await statusText(env.relay, () => true)).toContain('剩余 查询失败：返回的内容不对')
  })

  it('超时 → 「查询失败：超时」，不会一直等', async () => {
    env = await setup({ bridges: [bridge({ atAll: true }), bridge({ label: '二', discord: DC_CHANNEL2, qq: QQ_GROUP2, atAll: true })] })
    ;(env.relay.gate as any).queryTimeout = 100
    ;(env.qqBot.internal as any).getGroupAtAllRemain = () => new Promise(() => {})
    const started = Date.now()
    const status = await statusText(env.relay, () => true)
    // 两个群并行查：总共只等一个超时
    expect(Date.now() - started).toBeLessThan(1000)
    expect(status.match(/剩余 查询失败：超时/g)).toHaveLength(2)
  })

  it('QQ 机器人不在线 → 「QQ 机器人不在线」，不去查', async () => {
    env = await setup({ bridges: [bridge({ atAll: true })] })
    env.qqBot.offline()
    env.qq.calls = []
    const status = await statusText(env.relay, () => true)
    expect(status).toContain('剩余 QQ 机器人不在线')
    expect(env.qq.calls.filter((c) => c.action === 'get_group_at_all_remain')).toHaveLength(0)
  })

  it('没开 @全体 的桥、不显示的桥不查', async () => {
    env = await setup({ bridges: [bridge(), bridge({ label: '二', discord: DC_CHANNEL2, qq: QQ_GROUP2, atAll: true })] })
    env.qq.calls = []
    await env.command(OWNER_QQ, 'bridge.status', QQ_GROUP)
    expect(env.qq.calls.filter((c) => c.action === 'get_group_at_all_remain')).toHaveLength(0)
  })
})

// ================================================================== A8-4 时间带时区

describe('A8 时间后面标时区', () => {
  const at = Date.UTC(2026, 8, 30, 4, 38)

  it('utcOffset：整点、半小时、45 分钟、负数、零偏移、夏令时', () => {
    expect(utcOffset(at, 'Asia/Shanghai')).toBe('UTC+8')
    expect(utcOffset(at, 'Australia/Adelaide')).toBe('UTC+9:30')
    expect(utcOffset(Date.UTC(2026, 0, 15), 'Australia/Adelaide')).toBe('UTC+10:30')
    expect(utcOffset(at, 'Asia/Kathmandu')).toBe('UTC+5:45')
    expect(utcOffset(at, 'America/St_Johns')).toBe('UTC-2:30')
    expect(utcOffset(Date.UTC(2026, 0, 15), 'America/St_Johns')).toBe('UTC-3:30')
    expect(utcOffset(at, 'UTC')).toBe('UTC')
    expect(utcOffset(Date.UTC(2026, 0, 15), 'Europe/London')).toBe('UTC')
    expect(utcOffset(at, 'Europe/London')).toBe('UTC+1')
  })

  it('timeFormatter：时间后面带时区；没有时间显示「无」', () => {
    expect(timeFormatter('Asia/Shanghai')(at)).toBe('09/30 12:38 (UTC+8)')
    expect(timeFormatter('Australia/Adelaide')(at)).toBe('09/30 14:08 (UTC+9:30)')
    expect(timeFormatter('UTC')(at)).toBe('09/30 04:38 (UTC)')
    expect(timeFormatter('Asia/Shanghai')(0)).toBe('无')
  })

  it('bridge.status 的「最近转发」「最近一次失败」带时区', async () => {
    env = await setup()
    await env.qqMessage(text('第一条'))
    await env.idle()
    env.discord.fault('POST', /^\/webhooks\//, { status: 400, body: { message: 'Invalid Form Body', code: 50035 } })
    await env.qqMessage(text('第二条'))
    await env.idle()
    const status = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
    const shown = timeFormatter('Asia/Shanghai')(env.clock.now)
    expect(shown).toMatch(/^\d\d\/\d\d \d\d:\d\d \(UTC\+8\)$/)
    expect(status).toContain(`最近转发 ${shown}`)
    expect(status).toContain(`最近一次失败：HTTP 400 code 50035（${shown}）`)
  })
})

// ================================================================== A8-5 统计开始时间

describe('A8 bridge.status 第一行写统计从什么时候开始', () => {
  it('第一行是「统计从 … 重载后开始」，在全局暂停等提示之前', async () => {
    env = await setup()
    await env.command(OWNER_QQ, 'bridge.pause')
    const status = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
    const lines = status.split('\n')
    expect(lines[0]).toMatch(/^统计从 \d\d\/\d\d \d\d:\d\d \(UTC\+8\) 重载后开始$/)
    expect(lines[1]).toBe('⏸ 全局暂停中')
  })

  it('重载后从新的时间开始', async () => {
    env = await setup()
    env.clock.now = Date.UTC(2026, 8, 30, 4, 38)
    const reloaded = await installRelay(env, baseConfig({ timezone: 'Australia/Adelaide' }))
    try {
      const status = await statusText(reloaded.relay, () => true)
      expect(status.split('\n')[0]).toBe('统计从 09/30 14:08 (UTC+9:30) 重载后开始')
      expect(status).toContain('最近转发 无')
    } finally {
      reloaded.dispose()
      await sleep(20)
    }
  })
})
