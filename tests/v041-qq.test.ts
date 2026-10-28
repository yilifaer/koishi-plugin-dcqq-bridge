// 0.4.1 补充清单 V3、V9、V10、V11：发 QQ 超时后核对、QQ 没登录时的健康检查、掉线提醒、掉线期间的消息恢复后补发。
// 所有 ID、名字都是编造的；翻译服务用本地的模拟服务器。

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { h, Logger, Universal } from 'koishi'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { statusText } from '../src/commands'
import { normalizeSettings } from '../src/bridges'
import { Config } from '../src/config'
import { probeLogin } from '../src/qq/api'
import { checkDelivered, findOwn, headOf } from '../src/qq/verify'
import {
  bridge, DC_CHANNEL, DC_CHANNEL2, Env, installRelay, baseConfig, PR2_DEFAULTS, QQ_BOT, QQ_GROUP, QQ_GROUP2, setup, sleep,
} from './harness'

let env: Env | undefined
afterEach(async () => {
  await env?.stop()
  env = undefined
})

const BRIDGE_KEY = `${DC_CHANNEL}:${QQ_GROUP}`
/** 编造的 Discord 用户 ID（掉线提醒私信的对象）。 */
const ALERT_USER = '900000000000000099'

/** 收集 Koishi 日志。 */
function captureLogs() {
  const records: Array<{ name: string; type: string; content: string }> = []
  const target = { levels: { base: 3 }, record: (r: any) => records.push({ name: r.name, type: r.type, content: r.content }) }
  Logger.targets.push(target as any)
  return {
    ours: () => records.filter((r) => r.name === 'dcqq-bridge'),
    stop: () => {
      const i = Logger.targets.indexOf(target as any)
      if (i >= 0) Logger.targets.splice(i, 1)
    },
  }
}

function sendCalls(e: Env) {
  return e.qq.calls.filter((c) => c.action === 'send_group_msg')
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(10)
  }
  throw new Error('等待超时')
}

/** 发到 Discord 频道（和私信）的提醒。 */
function alertPosts(e: Env) {
  return e.discord.posts().filter((p) => p.path.startsWith('/channels/') && p.json?.content?.match(/QQ 机器人|Discord 机器人/))
}

// ================================================================== V3 发 QQ 超时后核对

describe('V3 发 QQ 超时后，先去群里核对再决定要不要重发', () => {
  it('超时，群里没有这条 → 重发一次，送达，不算失败', async () => {
    env = await setup()
    const logs = captureLogs()
    try {
      env.qq.faultOnce('send_group_msg', 'timeout')
      env.discordMessage({ content: '集合了' })
      await env.idle()
      expect(sendCalls(env)).toHaveLength(2)
      expect(env.qq.text()).toEqual(['[测试桥 - 舰长]\n集合了'])
      expect(env.qq.calls.filter((c) => c.action === 'get_group_msg_history')).toHaveLength(1)
      const stats = env.relay.stats.get(BRIDGE_KEY)
      expect(stats.forwards).toBe(1)
      expect(stats.failures).toBe(0)
      const line = logs.ours().find((r) => r.content.includes('超时后核对'))
      expect(line?.content).toContain('未送达，已重发')
      expect(line?.content).not.toContain('集合了')
    } finally {
      logs.stop()
    }
  })

  it('超时，但群里已经有这条（LLBot 发出后回复慢了）→ 不重发，当作送达', async () => {
    env = await setup()
    const logs = captureLogs()
    try {
      env.qq.deliverOnTimeout = true
      env.qq.faultOnce('send_group_msg', 'timeout')
      const d = env.discordMessage({ content: '集合了' })
      await env.idle()
      expect(sendCalls(env)).toHaveLength(1)
      expect(env.qq.text()).toEqual(['[测试桥 - 舰长]\n集合了'])
      const stats = env.relay.stats.get(BRIDGE_KEY)
      expect(stats.forwards).toBe(1)
      expect(stats.failures).toBe(0)
      // 回复对应表用的是群里那条消息的 ID
      const rows = await env.relay.store.bySource(DC_CHANNEL, d.id)
      expect(rows.map((r) => r.dstMessage)).toEqual([env.qq.sent[0].id])
      expect(logs.ours().some((r) => r.content.includes('超时后核对：已送达，不重发'))).toBe(true)
    } finally {
      logs.stop()
    }
  })

  it('超时，核对时查询失败 → 不重发（宁可丢，不重复），算失败', async () => {
    env = await setup()
    const logs = captureLogs()
    try {
      env.qq.faultOnce('send_group_msg', 'timeout')
      env.qq.faults.set('get_group_msg_history', 'fail')
      env.discordMessage({ content: '集合了' })
      await env.idle()
      expect(sendCalls(env)).toHaveLength(1)
      expect(env.qq.sent).toHaveLength(0)
      expect(env.relay.stats.get(BRIDGE_KEY).failures).toBe(1)
      expect(logs.ours().some((r) => r.content.includes('超时后核对：查询失败') && r.content.includes('不重发'))).toBe(true)
    } finally {
      logs.stop()
    }
  })

  it('LLBot 明确回复失败（retcode 1200）→ 不核对也不重发，照原来的规则', async () => {
    env = await setup()
    env.qq.faultOnce('send_group_msg', 'fail')
    env.discordMessage({ content: '集合了' })
    await env.idle()
    expect(sendCalls(env)).toHaveLength(1)
    expect(env.qq.calls.filter((c) => c.action === 'get_group_msg_history')).toHaveLength(0)
    expect(env.relay.stats.get(BRIDGE_KEY).failures).toBe(1)
  })

  it('重发又超时 → 最多重发一次，不再核对第二轮', async () => {
    env = await setup()
    env.qq.faults.set('send_group_msg', 'timeout')
    env.discordMessage({ content: '集合了' })
    await env.idle()
    expect(sendCalls(env)).toHaveLength(2)
    expect(env.qq.calls.filter((c) => c.action === 'get_group_msg_history')).toHaveLength(1)
    expect(env.relay.stats.get(BRIDGE_KEY).failures).toBe(1)
  })

  it('核对完已经超过 60 秒的发送期限 → 不重发', async () => {
    env = await setup()
    const logs = captureLogs()
    try {
      env.qq.faultOnce('send_group_msg', 'timeout')
      const e = env
      e.qq.onTimeout = () => void (e.clock.now += 61000)
      env.discordMessage({ content: '集合了' })
      await env.idle()
      expect(sendCalls(env)).toHaveLength(1)
      expect(env.relay.stats.get(BRIDGE_KEY).failures).toBe(1)
      expect(logs.ours().some((r) => r.content.includes('超时后核对：未送达，但已超过 60 秒发送期限，不重发'))).toBe(true)
    } finally {
      logs.stop()
    }
  })

  it('核对只看机器人自己发的消息，按前缀加前 30 个字比对', async () => {
    const bot = (messages: any[]) => ({ selfId: QQ_BOT, internal: { getGroupMsgHistory: async () => ({ messages }) } })
    const prefix = '[测试桥 - 舰长]'
    const body = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十甲乙丙丁'
    const elements = [h.text(`${prefix}\n${body}`)]
    expect(headOf(elements, prefix.length)).toBe(`${prefix}\n${body.slice(0, 30)}`)
    const own = (text: string, id = 1) => ({ message_id: id, sender: { user_id: +QQ_BOT }, message: [{ type: 'text', data: { text } }] })
    const other = { message_id: 9, sender: { user_id: 20001 }, message: [{ type: 'text', data: { text: `${prefix}\n${body}` } }] }
    // 别人发的同样内容不算
    expect(await checkDelivered(bot([other]), QQ_GROUP, elements, prefix.length)).toEqual({ state: 'missing' })
    // 前 30 个字之后不同，仍然算同一条
    expect(await checkDelivered(bot([own(`${prefix}\n${body.slice(0, 30)}后面不一样`, 5)]), QQ_GROUP, elements, prefix.length)).toEqual({ state: 'sent', messageId: '5' })
    // 前 30 个字里有不同的
    expect(await checkDelivered(bot([own(`${prefix}\n${body.slice(0, 29)}错`)]), QQ_GROUP, elements, prefix.length)).toEqual({ state: 'missing' })
    // CQ 码字符串格式（上报格式不是数组时）
    expect(findOwn([{ message_id: 6, sender: { user_id: +QQ_BOT }, message: `[CQ:at,qq=all]\n${prefix}\n${body.slice(0, 5)}&#91;x&#93;` }], QQ_BOT, `\n${prefix}\n${body.slice(0, 5)}[x]`.trim())).toBe('6')
    // 只发了图片、没有文字：无法比对
    const noText = await checkDelivered(bot([own(prefix)]), QQ_GROUP, [h.image(Buffer.from('x'), 'image/png')], prefix.length)
    expect(noText.state).toBe('unknown')
    // 返回的内容不对、抛错
    expect((await checkDelivered({ selfId: QQ_BOT, internal: { getGroupMsgHistory: async () => null } }, QQ_GROUP, elements, prefix.length)).state).toBe('unknown')
    expect((await checkDelivered({ selfId: QQ_BOT, internal: { getGroupMsgHistory: async () => { throw new Error('x') } } }, QQ_GROUP, elements, prefix.length)).state).toBe('unknown')
    // 只看最近 20 条
    const many = Array.from({ length: 25 }, (_, i) => own(`别的消息${i}`, 100 + i))
    expect(findOwn([own(`${prefix}\n${body}`, 1), ...many], QQ_BOT, `${prefix}\n${body.slice(0, 30)}`)).toBeUndefined()
  })
})

// ================================================================== V9 QQ 没登录时的健康检查

describe('V9 QQ 没登录时，健康检查只写一行', () => {
  const bridges = [
    bridge({ label: '一', atAll: true }),
    bridge({ label: '二', discord: DC_CHANNEL2, qq: QQ_GROUP2, atAll: true }),
    bridge({ label: '三', discord: DC_CHANNEL2, atAll: true }),
  ]

  it('get_status 说没登录：跑 10 轮只有 1 行警告，不去查各个桥；恢复后 1 行恢复日志', async () => {
    env = await setup({ bridges })
    const logs = captureLogs()
    try {
      env.qq.loggedIn = false
      env.qq.calls = []
      for (let i = 0; i < 10; i++) await env.relay.selfCheck()
      const warns = logs.ours().filter((r) => r.type === 'warn')
      expect(warns).toHaveLength(1)
      expect(warns[0].content).toContain('QQ 机器人没有登录（从')
      expect(warns[0].content).toContain('暂停检查各个桥')
      // 没有对每座桥查群、查身份
      expect(env.qq.calls.filter((c) => c.action === 'get_group_info' || c.action === 'get_group_member_info')).toHaveLength(0)

      env.clock.now += 5 * 60000
      env.qq.loggedIn = true
      await env.relay.selfCheck()
      const recovered = logs.ours().filter((r) => r.content.includes('已重新登录'))
      expect(recovered).toHaveLength(1)
      expect(recovered[0].type).toBe('info')
      expect(recovered[0].content).toContain('离线 5 分钟')
      // 恢复后照常检查各个桥
      expect(env.qq.calls.filter((c) => c.action === 'get_group_info').length).toBeGreaterThan(0)
      // 再跑几轮：没有新的恢复日志
      await env.relay.selfCheck()
      await env.relay.selfCheck()
      expect(logs.ours().filter((r) => r.content.includes('已重新登录'))).toHaveLength(1)
    } finally {
      logs.stop()
    }
  })

  it('每座桥的健康问题只在第一次出现、内容变化、恢复时各写一行', async () => {
    env = await setup({ bridges: [bridge({ atAll: true })] })
    const logs = captureLogs()
    try {
      const lines = () => logs.ours().filter((r) => r.content.startsWith('第 1 个桥'))
      env.qq.faults.set('get_group_info', 'fail')
      await env.relay.selfCheck()
      await env.relay.selfCheck()
      await env.relay.selfCheck()
      expect(lines()).toHaveLength(1)
      expect(lines()[0].type).toBe('warn')
      // 内容变了（群查得到了，但机器人不是管理员）：再写一行
      env.qq.faults.delete('get_group_info')
      env.qq.members.set(`${QQ_GROUP}:${QQ_BOT}`, { role: 'member', card: '机器人', nickname: 'bot' })
      await env.relay.selfCheck()
      await env.relay.selfCheck()
      expect(lines()).toHaveLength(2)
      expect(lines()[1].content).toContain('不是管理员')
      // 恢复：写一行 info
      env.qq.members.set(`${QQ_GROUP}:${QQ_BOT}`, { role: 'admin', card: '机器人', nickname: 'bot' })
      await env.relay.selfCheck()
      await env.relay.selfCheck()
      expect(lines()).toHaveLength(3)
      expect(lines()[2].type).toBe('info')
      expect(lines()[2].content).toContain('已恢复')
      expect(env.relay.health.size).toBe(0)
    } finally {
      logs.stop()
    }
  })

  it('bridge.status 最上面显示「QQ 机器人没有登录（从 X 起）」', async () => {
    env = await setup({ bridges })
    env.qq.loggedIn = false
    await env.relay.watch.tick()
    const text = await statusText(env.relay, () => true)
    expect(text.split('\n')[0]).toMatch(/^⚠ QQ 机器人没有登录（从 \d\d\/\d\d \d\d:\d\d \(UTC\+8\) 起）$/)
    env.qq.loggedIn = true
    await env.relay.watch.tick()
    expect(await statusText(env.relay, () => true)).not.toContain('没有登录')
  })

  it('probeLogin：online 为 false 或 retcode 1200 = 没登录；其他错误、超时 = 说不准', async () => {
    const withStatus = (fn: () => Promise<any>) => ({ internal: { getStatus: fn } })
    expect(await probeLogin(withStatus(async () => ({ online: false, good: true })))).toBe('out')
    expect(await probeLogin(withStatus(async () => ({ online: true, good: true })))).toBe('in')
    expect(await probeLogin(withStatus(async () => null))).toBe('in')
    expect(await probeLogin(withStatus(async () => { throw Object.assign(new Error('x'), { url: 'get_status', code: 1200 }) }))).toBe('out')
    expect(await probeLogin(withStatus(async () => { throw Object.assign(new Error('x'), { url: 'get_status', code: 1404 }) }))).toBe('unknown')
    expect(await probeLogin(withStatus(async () => { throw new Error('boom') }))).toBe('unknown')
    expect(await probeLogin(withStatus(() => new Promise(() => {})), 20)).toBe('unknown')
  })
})

// ================================================================== V10 掉线提醒

describe('V10 掉线提醒', () => {
  const alert = { discordChannel: DC_CHANNEL2, discordUser: ALERT_USER, afterMinutes: 10, qqGroup: '' }

  it('掉线 9 分钟不提醒；11 分钟提醒一次（频道和私信）；一直掉线不重复；恢复后发一次恢复提醒', async () => {
    env = await setup({ alert })
    const logs = captureLogs()
    try {
      env.qq.loggedIn = false
      await env.relay.watch.tick()
      env.clock.now += 9 * 60000
      await env.relay.watch.tick()
      expect(alertPosts(env)).toHaveLength(0)

      env.clock.now += 2 * 60000
      await env.relay.watch.tick()
      let posts = alertPosts(env)
      expect(posts).toHaveLength(2)
      const dm = env.discord.dms.get(ALERT_USER)!
      expect(posts.map((p) => p.path).sort()).toEqual([`/channels/${DC_CHANNEL2}/messages`, `/channels/${dm}/messages`].sort())
      for (const post of posts) {
        expect(post.json.content).toMatch(/^⚠ QQ 机器人 10000 掉线了（从 .+ 起），QQ 和 Discord 之间暂停转发。可以在 LLBot 里点停止再启动；登不上就要扫码。$/)
        expect(post.json.allowed_mentions).toEqual({ parse: [] })
      }
      // 状态里写明已提醒
      expect(await statusText(env.relay, () => true)).toContain('已在 Discord 发出提醒')

      // 一直掉线：不重复
      for (const minutes of [1, 5, 30]) {
        env.clock.now += minutes * 60000
        await env.relay.watch.tick()
      }
      expect(alertPosts(env)).toHaveLength(2)

      // 恢复：发一次恢复提醒（共离线 9 + 2 + 36 = 47 分钟）
      env.qq.loggedIn = true
      await env.relay.watch.tick()
      posts = alertPosts(env)
      expect(posts).toHaveLength(4)
      expect(posts.slice(2).map((p) => p.json.content)).toEqual(['✅ QQ 机器人已恢复，离线 47 分钟', '✅ QQ 机器人已恢复，离线 47 分钟'])
      await env.relay.watch.tick()
      expect(alertPosts(env)).toHaveLength(4)

      // 再掉线一次：重新计时，同样提醒一次
      env.qq.loggedIn = false
      env.clock.now += 60000
      await env.relay.watch.tick()
      env.clock.now += 9 * 60000
      await env.relay.watch.tick()
      expect(alertPosts(env)).toHaveLength(4)
      env.clock.now += 2 * 60000
      await env.relay.watch.tick()
      expect(alertPosts(env)).toHaveLength(6)
      expect(logs.ours().some((r) => r.content.includes('已在 Discord 发出提醒'))).toBe(true)
    } finally {
      logs.stop()
    }
  })

  it('只填频道：只往频道发；只填用户：只发私信', async () => {
    env = await setup({ alert: { ...alert, discordUser: '' } })
    env.qq.loggedIn = false
    await env.relay.watch.tick()
    env.clock.now += 11 * 60000
    await env.relay.watch.tick()
    expect(alertPosts(env).map((p) => p.path)).toEqual([`/channels/${DC_CHANNEL2}/messages`])
    expect(env.discord.dms.size).toBe(0)
    await env.stop()

    env = await setup({ alert: { ...alert, discordChannel: '' } })
    env.qq.loggedIn = false
    await env.relay.watch.tick()
    env.clock.now += 11 * 60000
    await env.relay.watch.tick()
    const dm = env.discord.dms.get(ALERT_USER)!
    expect(alertPosts(env).map((p) => p.path)).toEqual([`/channels/${dm}/messages`])
  })

  it('默认什么都不填：不提醒，也不创建私信', async () => {
    env = await setup()
    env.qq.loggedIn = false
    await env.relay.watch.tick()
    env.clock.now += 60 * 60000
    await env.relay.watch.tick()
    expect(alertPosts(env)).toHaveLength(0)
    expect(env.discord.requests.filter((r) => r.method === 'POST')).toHaveLength(0)
  })

  it('OneBot 连接断开也算掉线', async () => {
    env = await setup({ alert })
    env.qqBot.offline()
    await env.relay.watch.tick()
    env.clock.now += 11 * 60000
    await env.relay.watch.tick()
    expect(alertPosts(env)).toHaveLength(2)
    env.qqBot.online()
    await env.relay.watch.tick()
    expect(alertPosts(env).slice(2).map((p) => p.json.content)).toEqual(['✅ QQ 机器人已恢复，离线 11 分钟', '✅ QQ 机器人已恢复，离线 11 分钟'])
  })

  it('提醒发不出去（Discord 出错）→ 下一分钟再试，发出去才算提醒过', async () => {
    env = await setup({ alert: { ...alert, discordUser: '' } })
    const logs = captureLogs()
    try {
      env.qq.loggedIn = false
      await env.relay.watch.tick()
      env.clock.now += 11 * 60000
      env.discord.fault('POST', new RegExp(`^/channels/${DC_CHANNEL2}/messages$`), { status: 500, body: { code: 0, message: 'x' } }, 2)
      await env.relay.watch.tick()
      await env.relay.watch.tick()
      expect(env.relay.watch.qq?.alerted).toBe(false)
      // 失败的原因同一次掉线只写一次日志
      expect(logs.ours().filter((r) => r.content.includes('没有发到 Discord'))).toHaveLength(1)
      await env.relay.watch.tick()
      expect(env.relay.watch.qq?.alerted).toBe(true)
      expect(env.discord.posts().filter((p) => p.json?.content?.includes('掉线了')).length).toBeGreaterThanOrEqual(1)
    } finally {
      logs.stop()
    }
  })

  it('反过来：Discord 断开超过同样时间，在 alert.qqGroup 里提醒一次，恢复后再发一条', async () => {
    env = await setup({ alert: { discordChannel: '', discordUser: '', afterMinutes: 10, qqGroup: QQ_GROUP2 } })
    env.dcBot.status = Universal.Status.OFFLINE
    await env.relay.watch.tick()
    env.clock.now += 9 * 60000
    await env.relay.watch.tick()
    expect(env.qq.text(QQ_GROUP2)).toEqual([])
    env.clock.now += 2 * 60000
    await env.relay.watch.tick()
    expect(env.qq.text(QQ_GROUP2)).toHaveLength(1)
    expect(env.qq.text(QQ_GROUP2)[0]).toMatch(/^⚠ Discord 机器人掉线了（从 .+ 起），Discord 和 QQ 之间暂停转发。$/)
    // QQ 提醒里没有 @全体
    expect(env.qq.sent[0].segments.every((s: any) => s.type === 'text')).toBe(true)
    env.clock.now += 30 * 60000
    await env.relay.watch.tick()
    expect(env.qq.text(QQ_GROUP2)).toHaveLength(1)
    env.dcBot.status = Universal.Status.ONLINE
    await env.relay.watch.tick()
    expect(env.qq.text(QQ_GROUP2)).toHaveLength(2)
    expect(env.qq.text(QQ_GROUP2)[1]).toBe('✅ Discord 机器人已恢复，离线 41 分钟')
    // 没填 qqGroup 时不提醒
    await env.stop()
    env = await setup()
    env.dcBot.status = Universal.Status.OFFLINE
    await env.relay.watch.tick()
    env.clock.now += 60 * 60000
    await env.relay.watch.tick()
    expect(env.qq.sent).toHaveLength(0)
  })

  it('配置：ID 写错只忽略那一项；afterMinutes 默认 10', () => {
    const s = normalizeSettings(Config({ alert: { discordChannel: 'abc', discordUser: ALERT_USER, qqGroup: '12x' } } as any))
    expect(s.alert).toEqual({ discordChannel: '', discordUser: ALERT_USER, afterMinutes: 10, qqGroup: '' })
    expect(s.problems.filter((p) => p.includes('掉线提醒'))).toHaveLength(2)
    expect(normalizeSettings({}).alert).toEqual({ discordChannel: '', discordUser: '', afterMinutes: 10, qqGroup: '' })
    expect(normalizeSettings({ alert: { afterMinutes: -1 } } as any).alert.afterMinutes).toBe(0)
    expect(normalizeSettings({ alert: { afterMinutes: 'x' } } as any).alert.afterMinutes).toBe(10)
  })
})

// ================================================================== V11 QQ 掉线期间的消息恢复后补发

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
        this.chat.push(json)
        const user = json.messages?.at(-1)?.content ?? ''
        const text = /<text>([\s\S]*)<\/text>/.exec(user)?.[1] ?? ''
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `译：${text}` } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }))
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

describe('V11 QQ 掉线期间 Discord → QQ 的消息，恢复后补发', () => {
  const optIn = { bridges: [bridge({ qqBackfill: true })] }

  /** 在 QQ 没登录时发几条 Discord 消息，并让 Discord 的"取单条消息"接口能取到它们。 */
  async function sendWhileDown(e: Env, contents: string[], extra: Record<string, any> = {}) {
    const payloads: any[] = []
    for (const content of contents) payloads.push(e.discordMessage({ content, ...extra }))
    e.discord.history.set(DC_CHANNEL, [...(e.discord.history.get(DC_CHANNEL) ?? []), ...payloads])
    await e.idle()
    return payloads
  }

  it('QQ 没登录时发 3 条：不算转发失败、进待补发；恢复后按顺序补发 3 条，带（补发）', async () => {
    env = await setup(optIn)
    env.qq.loggedIn = false
    await sendWhileDown(env, ['一号', '二号', '三号'])
    expect(env.qq.sent).toHaveLength(0)
    const stats = env.relay.stats.get(BRIDGE_KEY)
    expect(stats.failures).toBe(0)
    expect(stats.forwards).toBe(0)
    const rows = await env.relay.store.pending()
    expect(rows).toHaveLength(3)
    expect(await env.relay.store.pendingCount(BRIDGE_KEY)).toBe(3)
    // bridge.status 显示待补发条数
    expect(await statusText(env.relay, () => true)).toContain('QQ 掉线补发：开，待补发 3 条')

    // 还没恢复：补发不会开始
    await env.relay.replayPending()
    expect(env.qq.sent).toHaveLength(0)

    env.qq.loggedIn = true
    await env.relay.watch.tick()
    await env.idle()
    expect(env.qq.text()).toEqual([
      '[测试桥 - 舰长（补发）]\n一号',
      '[测试桥 - 舰长（补发）]\n二号',
      '[测试桥 - 舰长（补发）]\n三号',
    ])
    expect(await env.relay.store.pending()).toHaveLength(0)
    expect(env.relay.stats.get(BRIDGE_KEY).forwards).toBe(3)
    expect(env.relay.stats.get(BRIDGE_KEY).failures).toBe(0)
    expect(await statusText(env.relay, () => true)).toContain('待补发 0 条')
    // 再检查一次：不会重复补发
    await env.relay.watch.tick()
    await env.idle()
    expect(env.qq.sent).toHaveLength(3)
  })

  it('补发的消息不 @全体（即使这个桥打开了 @全体）', async () => {
    env = await setup({ bridges: [bridge({ qqBackfill: true, atAll: true })] })
    env.qq.loggedIn = false
    await sendWhileDown(env, ['全体集合'], { mention_everyone: true })
    expect(env.qq.sent).toHaveLength(0)
    // 第一次没发出去，@全体 的次数不能被占用
    expect(await env.relay.gate.usedToday(QQ_GROUP).catch(() => 0)).toBe(0)
    env.qq.loggedIn = true
    await env.relay.watch.tick()
    await env.idle()
    expect(env.qq.sent).toHaveLength(1)
    expect(env.qq.sent[0].segments.some((s: any) => s.type === 'at')).toBe(false)
    expect(env.qq.sent[0].text).toContain('全体集合')
    expect(env.qq.sent[0].text).toContain('（补发）')
    expect(await env.relay.gate.usedToday(QQ_GROUP)).toBe(0)
  })

  it('超过时限的不补，只在日志里写一行；时限内的照补', async () => {
    env = await setup({ ...optIn, backfill: { qqOfflineMinutes: 30 } })
    const logs = captureLogs()
    try {
      env.qq.loggedIn = false
      const old = new Date(env.clock.now - 45 * 60000).toISOString()
      const fresh = new Date(env.clock.now - 5 * 60000).toISOString()
      await sendWhileDown(env, ['太旧一'], { timestamp: old })
      await sendWhileDown(env, ['太旧二'], { timestamp: old })
      await sendWhileDown(env, ['还来得及'], { timestamp: fresh })
      expect(await env.relay.store.pending()).toHaveLength(3)
      env.qq.loggedIn = true
      await env.relay.watch.tick()
      await env.idle()
      expect(env.qq.text()).toEqual(['[测试桥 - 舰长（补发）]\n还来得及'])
      expect(await env.relay.store.pending()).toHaveLength(0)
      const line = logs.ours().find((r) => r.content.includes('没有补发'))
      expect(line?.content).toBe('QQ 掉线期间有 2 条超过 30 分钟，没有补发')
    } finally {
      logs.stop()
    }
  })

  it('没打开「QQ掉线补发」的桥照旧：QQ 没登录时发送失败就丢', async () => {
    env = await setup()
    env.qq.loggedIn = false
    await sendWhileDown(env, ['丢了'])
    expect(env.relay.stats.get(BRIDGE_KEY).failures).toBe(1)
    expect(await env.relay.store.pending()).toHaveLength(0)
    env.qq.loggedIn = true
    await env.relay.watch.tick()
    await env.idle()
    expect(env.qq.sent).toHaveLength(0)
    expect(await statusText(env.relay, () => true)).not.toContain('QQ 掉线补发')
  })

  it('OneBot 连接断开（已知掉线）时不等 60 秒，直接记进待补发；恢复后补发', async () => {
    env = await setup(optIn)
    env.qqBot.offline()
    await env.relay.watch.tick()
    const started = Date.now()
    await sendWhileDown(env, ['断线中'])
    expect(Date.now() - started).toBeLessThan(5000)
    expect(await env.relay.store.pending()).toHaveLength(1)
    expect(env.relay.stats.get(BRIDGE_KEY).failures).toBe(0)
    env.qqBot.online()
    await env.relay.watch.tick()
    await env.idle()
    expect(env.qq.text()).toEqual(['[测试桥 - 舰长（补发）]\n断线中'])
  })

  it('补发的消息有译文（和网关断线补发不同）', async () => {
    const llm = new FakeLLM()
    await llm.start()
    try {
      env = await setup({
        bridges: [bridge({ qqBackfill: true, translate: true })],
        translate: { ...PR2_DEFAULTS.translate, enabled: true, baseURL: llm.base, apiKey: 'test-key', model: 'test-model', timeoutMs: 800 },
      })
      env.qq.loggedIn = false
      await sendWhileDown(env, ['Fleet forms in Jita tonight'])
      env.qq.loggedIn = true
      await env.relay.watch.tick()
      await env.idle()
      expect(env.qq.text()).toEqual(['[测试桥 - 舰长（补发）]\nFleet forms in Jita tonight\n\n【机翻】 译：Fleet forms in Jita tonight'])
    } finally {
      await llm.stop()
    }
  })

  it('Discord 上已经删掉的消息不补发，记录也清掉', async () => {
    env = await setup(optIn)
    env.qq.loggedIn = false
    await sendWhileDown(env, ['保留', '已删除'])
    // 第二条在 Discord 上被删了
    env.discord.history.set(DC_CHANNEL, env.discord.history.get(DC_CHANNEL)!.slice(0, 1))
    env.qq.loggedIn = true
    await env.relay.watch.tick()
    await env.idle()
    expect(env.qq.text()).toEqual(['[测试桥 - 舰长（补发）]\n保留'])
    expect(await env.relay.store.pending()).toHaveLength(0)
  })

  it('补发到一半 QQ 又掉线：没发的留在待补发列表里，等下次恢复；不算失败', async () => {
    env = await setup(optIn)
    env.qq.loggedIn = false
    await sendWhileDown(env, ['甲', '乙'])
    expect(await env.relay.store.pending()).toHaveLength(2)
    env.qq.loggedIn = true
    const e = env
    // 补发的第一次发送请求一到，LLBot 就掉线了
    e.qq.beforeHandle = (action) => {
      if (action === 'send_group_msg') {
        e.qq.loggedIn = false
        e.qq.beforeHandle = null
      }
    }
    await env.relay.watch.tick()
    await env.idle()
    expect(env.qq.sent).toHaveLength(0)
    expect(await env.relay.store.pending()).toHaveLength(2)
    expect(env.relay.stats.get(BRIDGE_KEY).failures).toBe(0)
    // 又恢复：按顺序补发
    env.qq.loggedIn = true
    await env.relay.watch.tick()
    await env.idle()
    expect(env.qq.text()).toEqual(['[测试桥 - 舰长（补发）]\n甲', '[测试桥 - 舰长（补发）]\n乙'])
    expect(await env.relay.store.pending()).toHaveLength(0)
  })

  it('待补发的记录在数据库里：插件重载（新的实例）后也能补发', async () => {
    env = await setup(optIn)
    env.qq.loggedIn = false
    await sendWhileDown(env, ['重启前'])
    expect(await env.relay.store.pending()).toHaveLength(1)
    env.qq.loggedIn = true
    const { relay, dispose } = await installRelay(env, baseConfig(optIn))
    try {
      await relay.watch.tick()
      await env.idle()
      expect(env.qq.text()).toEqual(['[测试桥 - 舰长（补发）]\n重启前'])
      expect(await relay.store.pending()).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('补发到一半插件停了（重载）：没发的记录留在数据库里，由新实例补发', async () => {
    env = await setup(optIn)
    env.qq.loggedIn = false
    await sendWhileDown(env, ['甲', '乙', '丙'])
    expect(await env.relay.store.pending()).toHaveLength(3)
    env.qq.loggedIn = true
    const e = env
    // 第一条发出去的时候插件被停掉
    e.qq.beforeHandle = (action) => {
      if (action === 'send_group_msg') {
        e.qq.beforeHandle = null
        void e.relay.dispose()
      }
    }
    await env.relay.watch.tick()
    await env.idle()
    expect(env.qq.text()).toHaveLength(1)
    expect(await env.relay.store.pending()).toHaveLength(2)
    // 新实例接着补发剩下的
    const { relay, dispose } = await installRelay(env, baseConfig(optIn))
    try {
      await relay.watch.tick()
      await env.idle()
      expect(env.qq.text()).toHaveLength(3)
      expect(await relay.store.pending()).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('桥表格里的列默认关；补发时限默认 30 分钟，范围 1 到 10080', () => {
    const rows = normalizeSettings(Config({ bridges: [{ label: 'a', discord: '100000000000000001', qq: '200000001', qqBackfill: true }, { label: 'b', discord: '100000000000000002', qq: '200000002' }] } as any))
    expect(rows.bridges.map((b) => b.qqBackfill)).toEqual([true, false])
    expect(normalizeSettings({}).backfill.qqOfflineMinutes).toBe(30)
    expect(normalizeSettings({ backfill: { qqOfflineMinutes: 0 } } as any).backfill.qqOfflineMinutes).toBe(1)
    expect(normalizeSettings({ backfill: { qqOfflineMinutes: 999999 } } as any).backfill.qqOfflineMinutes).toBe(10080)
    expect(normalizeSettings({ backfill: { qqOfflineMinutes: 'x' } } as any).backfill.qqOfflineMinutes).toBe(30)
    // 写成别的值时整行无效（和其他开关一样）
    const bad = normalizeSettings(Config({ bridges: [{ label: 'a', discord: '100000000000000001', qq: '200000001', qqBackfill: 'yes' }] } as any))
    expect(bad.rows[0].invalid).toContain('有写错的字段')
  })
})

