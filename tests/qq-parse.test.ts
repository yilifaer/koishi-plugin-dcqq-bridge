import { beforeAll, describe, expect, it } from 'vitest'
import { Context, h } from 'koishi'
import type { Session } from 'koishi'
import { OneBot, OneBotBot } from 'koishi-plugin-adapter-onebot'
import { collectAtIds, parseQQMessage, renderQQElements, replyIdFromRaw } from '../src/qq/parse'
import type { QQSessionLike } from '../src/qq/parse'

// 编造的号码
const SELF = '10000'
const GROUP = 123456
const USER = 20001
const OTHER = 20002

const names: Record<string, string> = { [OTHER]: '缓存名' }
const env = { selfId: SELF, now: 1_700_000_000_000, memberName: (id: string) => names[id] }

// 真实的 adapter-onebot：用它的 adaptSession 从原始事件生成 session
let app: Context
let bot: OneBotBot<Context>
let getMsg: ((id: unknown) => any) | undefined

beforeAll(async () => {
  app = new Context()
  await app.start()
  bot = new OneBotBot(app, { selfId: SELF, protocol: 'none', advanced: { splitMixedContent: true } } as any)
  // get_msg 失败时 adapter 会打一条警告，测试里不需要
  bot.logger.warn = () => {}
  ;(bot.internal as any)._request = async (action: string, params: any) => {
    if (action === 'get_msg' && getMsg) return { status: 'ok', retcode: 0, data: getMsg(params.message_id) }
    return { status: 'failed', retcode: 100, data: null }
  }
})


function rawEvent(message: any, extra: Record<string, any> = {}) {
  return {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 555,
    group_id: GROUP,
    user_id: USER,
    self_id: Number(SELF),
    time: 1_700_000_100,
    message,
    sender: { user_id: USER, nickname: '昵称甲', card: '名片甲' },
    ...extra,
  }
}

async function adapt(message: any, extra?: Record<string, any>): Promise<Session> {
  const data = rawEvent(message, extra)
  const session = (await OneBot.adaptSession(bot as any, data as any))!
  session.setInternal('onebot', data)
  return session
}

const seg = (type: string, data: Record<string, any> = {}) => ({ type, data })

describe('renderQQElements', () => {
  it('每种元素都有输出', () => {
    const els = [
      h.text('你好'),
      h('at', { id: '1', name: '有名字' }),
      h('at', { id: OTHER }),
      h('at', { id: '30003' }),
      h('at', { type: 'all' }),
      h('face', { id: '14', name: '微笑', platform: 'onebot' }),
      h('face', { id: '999' }),
      h('mface', { url: 'https://example.com/m.gif', summary: '[x]' }),
      h('mface', {}),
      h('img', { src: 'https://example.com/a.png', file: 'a.png' }),
      h('image', { url: 'https://example.com/b.png' }),
      h('audio', { src: 'https://example.com/a.amr' }),
      h('record', {}),
      h('video', { src: 'https://example.com/v.mp4', file: 'v.mp4' }),
      h('file', { src: 'https://example.com/f', file: '报告.pdf', fileSize: '100' }),
      h('forward', { id: 'abc' }),
      h('json', { data: JSON.stringify({ prompt: '[QQ小程序]某个小程序' }) }),
      h('json', { data: JSON.stringify({ meta: { news: { title: '新闻标题' } } }) }),
      h('json', { data: JSON.stringify({ meta: { detail_1: { desc: '说明文字' } } }) }),
      h('json', { data: 'not json' }),
      h('markdown', { content: 'md 文字' }),
      h('markdown', { data: JSON.stringify({ content: 'md2' }) }),
      h('reply', { id: '9' }),
      h('poke', {}),
    ]
    const { text, media } = renderQQElements(els, env)
    expect(text).toBe(
      '你好@有名字@缓存名@30003@全体成员[微笑][表情][表情包][表情包][语音][语音][文件: 报告.pdf][合并转发]' +
        '[卡片: [QQ小程序]某个小程序][卡片: 新闻标题][卡片: 说明文字][卡片]md 文字md2[poke]',
    )
    expect(media).toEqual([
      { kind: 'image', urls: ['https://example.com/m.gif'], name: '', placeholder: '[表情包]' },
      { kind: 'image', urls: ['https://example.com/a.png'], name: 'a.png', placeholder: '[图片]' },
      { kind: 'image', urls: ['https://example.com/b.png'], name: '', placeholder: '[图片]' },
      { kind: 'video', urls: ['https://example.com/v.mp4'], name: 'v.mp4', size: undefined, placeholder: '[视频]' },
    ])
  })

  it('at 的名字用 ||：空名字回退到缓存名，再回退到号码', () => {
    expect(renderQQElements([h('at', { id: OTHER, name: '' })], env).text).toBe('@缓存名')
    expect(renderQQElements([h('at', { id: '40004', name: '' })], { memberName: () => '' }).text).toBe('@40004')
  })

  it('@全体 只是文字，没有 Discord 的 @everyone', () => {
    const { text } = renderQQElements([h('at', { type: 'all' }), h.text(' 开会')], env)
    expect(text).toBe('@全体成员 开会')
    expect(text).not.toContain('@everyone')
  })
})

describe('collectAtIds / replyIdFromRaw', () => {
  it('只收集非全体的 at', () => {
    expect(collectAtIds([h('at', { type: 'all' }), h('at', { id: '1' }), h.text('x'), h('at', { id: '2' })])).toEqual(['1', '2'])
  })
  it('数组和 CQ 码两种形式', () => {
    expect(replyIdFromRaw([seg('text', { text: 'a' }), seg('reply', { id: 77 })])).toBe('77')
    expect(replyIdFromRaw('[CQ:reply,id=-12345][CQ:at,qq=1] hi')).toBe('-12345')
    expect(replyIdFromRaw('[CQ:reply,seq=3,id=88]')).toBe('88')
    expect(replyIdFromRaw('plain')).toBeUndefined()
    expect(replyIdFromRaw(undefined)).toBeUndefined()
    expect(replyIdFromRaw([seg('text', { text: 'a' })])).toBeUndefined()
  })
})

describe('parseQQMessage（真实 adapter-onebot 生成的 session）', () => {
  it('普通消息：作者、头像 https、seq、时间、正文从 elements 取', async () => {
    const session = await adapt([seg('text', { text: 'a < b &amp; c' }), seg('image', { url: 'https://example.com/i.png', file: 'i.png' })], { message_seq: 42 })
    const msg = parseQQMessage(session, env)
    expect(msg.platform).toBe('onebot')
    expect(msg.channelId).toBe(String(GROUP))
    expect(msg.messageId).toBe('555')
    expect(msg.authorId).toBe(String(USER))
    expect(msg.author).toBe('名片甲')
    expect(msg.avatar).toMatch(/^https:\/\/q\.qlogo\.cn\//)
    expect(msg.seq).toBe(42)
    expect(msg.timestamp).toBe(1_700_000_100_000)
    expect(msg.body).toBe('a < b &amp; c ')
    expect(msg.media).toHaveLength(1)
    expect(msg.reply).toBeUndefined()
    expect(msg.mentionEveryone).toBe(false)
    expect(msg.silent).toBe(false)
    expect(msg.blocks).toEqual([])
    expect(msg.backfill).toBe(false)
  })

  it('名片为空时用昵称', async () => {
    const session = await adapt([seg('text', { text: 'x' })], { sender: { user_id: USER, nickname: '昵称甲', card: '' } })
    expect(parseQQMessage(session, env).author).toBe('昵称甲')
  })

  it('没有 message_seq 时 seq 为 undefined', async () => {
    const session = await adapt([seg('text', { text: 'x' })])
    expect(parseQQMessage(session, env).seq).toBeUndefined()
  })

  it('回复：去掉自动加的 @机器人，引用内容从 elements 渲染（不是 XML content）', async () => {
    getMsg = () => ({
      message_id: 777,
      group_id: GROUP,
      time: 1_700_000_000,
      message: [seg('text', { text: '1 < 2 ' }), seg('at', { qq: OTHER }), seg('face', { id: '14' })],
      sender: { user_id: OTHER, nickname: '昵称乙', card: '名片乙' },
    })
    const session = await adapt([seg('reply', { id: 777 }), seg('at', { qq: SELF }), seg('text', { text: ' 收到' })])
    getMsg = undefined
    expect(session.quote).toBeDefined()
    const msg = parseQQMessage(session, env)
    expect(msg.body).toBe('收到')
    expect(msg.reply).toEqual({ messageId: '777', author: '名片乙', content: '1 < 2 @缓存名[微笑]', deleted: false })
  })

  it('回复但 @ 的不是机器人：保留', async () => {
    const session = await adapt([seg('reply', { id: 777 }), seg('at', { qq: OTHER }), seg('text', { text: ' 你看' })])
    expect(parseQQMessage(session, env).body).toBe('@缓存名 你看')
  })

  it('不是回复时，@机器人 保留', async () => {
    const session = await adapt([seg('at', { qq: SELF }), seg('text', { text: ' 在吗' })])
    expect(parseQQMessage(session, env).body).toBe(`@${SELF} 在吗`)
  })

  it('取不到被回复的消息（session.quote 为空）时，回复 ID 仍从原始数据取（S20）', async () => {
    const session = await adapt([seg('reply', { id: 888 }), seg('at', { qq: SELF }), seg('text', { text: ' ok' })])
    expect(session.quote).toBeUndefined()
    const msg = parseQQMessage(session, env)
    expect(msg.reply).toEqual({ messageId: '888', author: '', content: '', deleted: false })
    expect(msg.body).toBe('ok')
  })

  it('CQ 码字符串形式的原始消息', async () => {
    const session = await adapt('[CQ:reply,id=999][CQ:at,qq=10000] 好的')
    expect(parseQQMessage(session, env).reply?.messageId).toBe('999')
    expect(parseQQMessage(session, env).body).toBe('好的')
  })

  it('checkText 含文件名', async () => {
    const session = await adapt([seg('text', { text: '看这个' }), seg('file', { file: '清单.xlsx', url: 'https://example.com/f' })])
    const msg = parseQQMessage(session, env)
    expect(msg.body).toBe('看这个[文件: 清单.xlsx]')
    expect(msg.checkText).toContain('清单.xlsx')
  })
})

describe('parseQQMessage（手写的 session）', () => {
  const base = (over: Partial<QQSessionLike>): QQSessionLike => ({
    channelId: '1',
    messageId: '2',
    userId: '3',
    event: {},
    ...over,
  })

  it('作者按顺序回退，最后是号码；没有时间用 now', () => {
    const msg = parseQQMessage(base({ elements: [h.text('x')] }), env)
    expect(msg.author).toBe('3')
    expect(msg.timestamp).toBe(env.now)
    expect(msg.avatar).toBeUndefined()
    expect(parseQQMessage(base({ event: { member: { nick: '' }, user: { name: '用户名' } } }), env).author).toBe('用户名')
    expect(parseQQMessage(base({ onebot: { sender: { card: '', nickname: '昵称' } } }), env).author).toBe('昵称')
  })

  it('回复 ID 回退到 session.quote.id；引用作者用 user.name', () => {
    const msg = parseQQMessage(
      base({ elements: [h.text('  '), h('at', { id: SELF }), h.text(' 嗯')], quote: { id: '66', user: { name: '某人' }, elements: [h.text('原文')] } }),
      env,
    )
    expect(msg.reply).toEqual({ messageId: '66', author: '某人', content: '原文', deleted: false })
    expect(msg.body).toBe('  嗯')
  })
})
