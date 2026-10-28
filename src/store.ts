// 插件自己的数据表（清单 §5），表名都带 dcqqbridge_ 前缀。不读写旧插件的表。

import type { Context } from 'koishi'
import type { Platform } from './types'

export interface MessageRow {
  id: number
  time: Date
  srcPlatform: string
  srcChannel: string
  srcMessage: string
  dstPlatform: string
  dstChannel: string
  dstMessage: string
  /** 这是第几次发送（从 0 开始）。 */
  part: number
  /** 来源作者的显示名（给文字引用用）。 */
  srcAuthor: string
}

export interface StateRow {
  key: string
  value: string
}

/** 纠错命令加的词条（B14）。key = 方向 + 来源写法（3 个字母以上不分大小写），同一个 key 再加就覆盖。 */
export interface GlossaryRow {
  key: string
  /** 来源写法（原样） */
  src: string
  /** 换成的写法；keep 时和 src 相同 */
  dst: string
  mode: string
  /** en2zh / zh2en */
  dir: string
  /** `平台:用户ID` */
  createdBy: string
  createdAt: Date
}

/** QQ 掉线期间没发出去、等恢复后补发的 Discord 消息（0.4.1 V11）。只存位置，补发时再向 Discord 取内容。 */
export interface PendingRow {
  /** `桥 key:Discord 消息 ID`；同一条消息同一座桥只有一行。 */
  key: string
  /** 桥的 key（`<discord>:<qq>`）。 */
  bridge: string
  channel: string
  message: string
  /** Discord 消息发出的时间（判断是否超过补发时限）。 */
  sentAt: Date
}

declare module 'koishi' {
  interface Tables {
    dcqqbridge_message: MessageRow
    dcqqbridge_state: StateRow
    dcqqbridge_glossary: GlossaryRow
    dcqqbridge_pending: PendingRow
  }
}

export function extendModels(ctx: Context) {
  ctx.model.extend('dcqqbridge_message', {
    id: 'unsigned',
    time: 'timestamp',
    srcPlatform: 'string(16)',
    srcChannel: 'string(64)',
    srcMessage: 'string(64)',
    dstPlatform: 'string(16)',
    dstChannel: 'string(64)',
    dstMessage: 'string(64)',
    part: 'unsigned',
    srcAuthor: 'string(64)',
  }, {
    autoInc: true,
    indexes: [['srcChannel', 'srcMessage'], ['dstChannel', 'dstMessage']],
  })
  ctx.model.extend('dcqqbridge_state', {
    key: 'string(128)',
    value: 'string(1024)',
  }, { primary: 'key' })
  ctx.model.extend('dcqqbridge_glossary', {
    key: 'string(300)',
    src: 'string(255)',
    dst: 'string(255)',
    mode: 'string(8)',
    dir: 'string(8)',
    createdBy: 'string(128)',
    createdAt: 'timestamp',
  }, { primary: 'key' })
  ctx.model.extend('dcqqbridge_pending', {
    key: 'string(160)',
    bridge: 'string(140)',
    channel: 'string(64)',
    message: 'string(64)',
    sentAt: 'timestamp',
  }, { primary: 'key' })
}

export class Store {
  constructor(private ctx: Context) {}

  private get db() {
    return this.ctx.database
  }

  async addMapping(row: Omit<MessageRow, 'id' | 'time'>, time = new Date()) {
    await this.db.create('dcqqbridge_message', { ...row, srcAuthor: row.srcAuthor.slice(0, 64), time })
  }

  /** 这条来源消息已经转发到过哪些地方。 */
  bySource(srcChannel: string, srcMessage: string) {
    return this.db.get('dcqqbridge_message', { srcChannel, srcMessage })
  }

  /** 这条消息是不是插件转发出来的结果。 */
  byTarget(dstChannel: string, dstMessage: string) {
    return this.db.get('dcqqbridge_message', { dstChannel, dstMessage })
  }

  async hasSource(srcChannel: string, srcMessage: string, dstChannel?: string) {
    const rows = await this.db.get('dcqqbridge_message', dstChannel ? { srcChannel, srcMessage, dstChannel } : { srcChannel, srcMessage }, ['id'])
    return rows.length > 0
  }

  async cleanup(keepDays: number, now = Date.now()) {
    const result = await this.db.remove('dcqqbridge_message', { time: { $lt: new Date(now - keepDays * 86400000) } })
    return (result as any)?.removed ?? 0
  }

  // ---------------------------------------------------------------- QQ 掉线待补发（V11）

  /** 记一条待补发的消息；同一座桥同一条消息再记一次只是覆盖。 */
  async addPending(bridge: string, channel: string, message: string, sentAt: Date) {
    await this.db.upsert('dcqqbridge_pending', [{ key: `${bridge}:${message}`, bridge, channel, message, sentAt }])
  }

  async pending(): Promise<PendingRow[]> {
    return this.db.get('dcqqbridge_pending', {})
  }

  /** 某座桥现在有几条待补发（给 bridge.status）。 */
  async pendingCount(bridge: string) {
    return (await this.db.get('dcqqbridge_pending', { bridge }, ['key'])).length
  }

  async removePending(key: string) {
    await this.db.remove('dcqqbridge_pending', { key })
  }

  /** 清掉发出时间早于 before 的行（长期不恢复时不让表越长越大）。 */
  async prunePending(before: Date) {
    const result = await this.db.remove('dcqqbridge_pending', { sentAt: { $lt: before } })
    return (result as any)?.removed ?? 0
  }

  // ---------------------------------------------------------------- 键值表

  async get<T>(key: string): Promise<T | undefined> {
    const [row] = await this.db.get('dcqqbridge_state', { key })
    if (!row) return undefined
    try {
      return JSON.parse(row.value) as T
    } catch {
      return undefined
    }
  }

  async set(key: string, value: unknown) {
    await this.db.upsert('dcqqbridge_state', [{ key, value: JSON.stringify(value) }])
  }

  async delete(key: string) {
    await this.db.remove('dcqqbridge_state', { key })
  }

  async entries(prefix: string): Promise<Array<{ key: string; value: any }>> {
    const rows = await this.db.get('dcqqbridge_state', { key: { $regex: new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) } })
    return rows.map((row) => {
      let value: any
      try {
        value = JSON.parse(row.value)
      } catch {}
      return { key: row.key, value }
    })
  }
}

export function platformOf(platform: string): Platform {
  return platform === 'discord' ? 'discord' : 'onebot'
}
