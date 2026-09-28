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

declare module 'koishi' {
  interface Tables {
    dcqqbridge_message: MessageRow
    dcqqbridge_state: StateRow
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
