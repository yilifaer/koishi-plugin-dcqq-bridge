// 代码审查发现的问题的回归测试。
import { afterEach, describe, expect, it } from 'vitest'
import { bridge, Env, OWNER_QQ, QQ_GROUP, qqPayload, setup } from './harness'

let env: Env
afterEach(async () => {
  await env?.stop()
})

describe('审查修正', () => {
  it('QQ 发视频失败 → 改发「[视频: 文件名] 网址」文字', async () => {
    env = await setup()
    env.qq.failVideo = true
    env.discordMessage({
      content: 'look',
      attachments: [{ id: '1', filename: 'clip.mp4', content_type: 'video/mp4', size: 100, url: 'https://cdn.example.com/clip.mp4', proxy_url: 'https://media.example.com/clip.mp4' }],
    })
    await env.idle()
    const texts = env.qq.text(QQ_GROUP)
    expect(texts.some((t) => t.includes('[视频: clip.mp4] https://cdn.example.com/clip.mp4'))).toBe(true)
  })

  it('bridge.status 显示今天用了几次 @全体', async () => {
    env = await setup({ bridges: [bridge({ atAll: true })] })
    env.discordMessage({ content: '@everyone 集合', mention_everyone: true })
    await env.idle()
    const status = (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
    expect(status).toContain('今天用了 1 次')
  })

  it('webhook 失效又重建不了 → 改由机器人发', async () => {
    env = await setup()
    // 先正常发一条，让插件拿到 webhook
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '第一条' } }]))
    await env.idle()
    // webhook 被人删掉，而且机器人不能再建
    env.discord.webhooks.clear()
    env.discord.fault('POST', /^\/channels\/\d+\/webhooks$/, { status: 403, body: { message: 'Missing Permissions', code: 50013 } }, 5)
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: '第二条' } }]))
    await env.idle()
    const last = env.discord.posts().at(-1)!
    expect(last.path).toMatch(/^\/channels\/\d+\/messages$/)
    expect(last.json.content).toContain('第二条')
    expect(last.json.content).toMatch(/^\\\[测试桥 - 群名片小明\\\] /)
  })

  it('统计按消息计数：分成两段的一条消息只算 1 条', async () => {
    env = await setup()
    await env.qqMessage(qqPayload([{ type: 'text', data: { text: 'x '.repeat(1500) } }]))
    await env.idle()
    expect(env.discord.posts().length).toBeGreaterThan(1)
    expect(env.relay.stats.get(env.relay.settings.bridges[0].key).forwards).toBe(1)
  })
})
