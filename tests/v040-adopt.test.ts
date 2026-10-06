// 0.4.0 复查 F5 的两个边角：接旧网址缓存时和后台下载撞在一起；改名失败时这次运行也要有词条。

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const hook = vi.hoisted(() => ({
  onReaddir: null as null | (() => Promise<void>),
  failRename: 0,
}))
vi.mock('node:fs/promises', async (orig) => {
  const fs = await orig<typeof import('node:fs/promises')>()
  return {
    ...fs,
    readdir: (async (...a: any[]) => {
      const r = await (fs.readdir as any)(...a)
      const h = hook.onReaddir
      if (h) {
        hook.onReaddir = null
        await h()
      }
      return r
    }) as any,
    rename: (async (from: string, to: string) => {
      // 只让「接旧缓存」那一步改名失败（临时文件改名不受影响）
      if (hook.failRename > 0 && !String(from).includes('.tmp')) {
        hook.failRename--
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      }
      return fs.rename(from, to)
    }) as any,
  }
})

import { parseSlangYaml } from '../src/glossary'
import { cacheStem, OnlineSources } from '../src/online'

const sha1 = (t: string) => createHash('sha1').update(t).digest('hex')
const V1 = '- en: stratop\n  zh: 战略行动\n  mode: force\n  dir: both\n'
const V2 = V1.replace('战略行动', '战略集结')
const A = 'https://a.example/g.yaml'
const B = 'https://b.example/g.yaml'
const check = (_k: string, text: string) => {
  const p = parseSlangYaml(text)
  return p.fatal ? { error: p.fatal } : p.entries.length ? {} : { error: '没有可用的词条' }
}

const dirs: string[] = []
afterEach(() => {
  hook.onReaddir = null
  hook.failRename = 0
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup(serve: () => string | null, preSync = false) {
  const base = mkdtempSync(join(tmpdir(), 'dcqq-adopt-'))
  dirs.push(base)
  const cdir = join(base, 'data/dcqq-bridge/cache')
  mkdirSync(cdir, { recursive: true })
  const ctx: any = {
    baseDir: base,
    http: async (url: string) => {
      const body = url === B ? serve() : null
      if (body === null) throw new Error('offline')
      return { status: 200, data: new TextEncoder().encode(body).buffer, headers: new Map([['etag', '"b2"']]) }
    },
    setInterval: () => () => {},
  }
  const sources = new OnlineSources(ctx, { warn: () => {}, info: () => {} } as any, check as any)
  // 插件已经在用「B || A」运行（还没有缓存），旧缓存是后来才出现的（例如上次启动改名失败留下的）
  if (preSync) await sources.sync([{ kind: 'slang', urls: [B, A], active: true }] as any)
  // 旧配置是「A || B」时留下的缓存（V1）
  const sa = cacheStem('slang', A)
  writeFileSync(join(cdir, `${sa}.yaml`), V1)
  writeFileSync(join(cdir, `${sa}.meta.json`), JSON.stringify({ urls: [A, B], url: A, etag: '"a1"', savedAt: 1, hash: sha1(V1) }))
  return { cdir, sources, sa, sb: cacheStem('slang', B) }
}

it('接旧缓存时后台下载刚好拿到新版本：不用旧缓存盖住新文件', async () => {
  let online = false
  const { cdir, sources, sb } = await setup(() => (online ? V2 : null), true)
  online = true
  // 读目录的那一刻，定时下载正好完成
  hook.onReaddir = async () => { await sources.refreshAll() }
  await sources.sync([{ kind: 'slang', urls: [B, A], active: true }] as any)
  await sources.refreshAll()
  expect(sources.list()[0].text).toBe(V2)
  expect(readFileSync(join(cdir, `${sb}.yaml`), 'utf8')).toBe(V2)
  expect(JSON.parse(readFileSync(join(cdir, `${sb}.meta.json`), 'utf8')).hash).toBe(sha1(V2))
  expect(readdirSync(cdir).sort()).toEqual([`${sb}.meta.json`, `${sb}.yaml`].sort())
})

it('接旧缓存时改名失败（文件被占用）：这次运行直接读旧的那份，断网也有词条；下次能下载时补写成自己的', async () => {
  let online = false
  const { cdir, sources, sa, sb } = await setup(() => (online ? V2 : null))
  hook.failRename = 1
  await sources.sync([{ kind: 'slang', urls: [B, A], active: true }] as any)
  const source = sources.list()[0]
  expect(source.text).toBe(V1)
  expect(source.from).toBe('cache')
  // 旧的那份还在（下次再接），自己名下还没有
  expect(readdirSync(cdir).sort()).toEqual([`${sa}.meta.json`, `${sa}.yaml`].sort())
  online = true
  await sources.refreshAll()
  expect(sources.list()[0].text).toBe(V2)
  expect(readFileSync(join(cdir, `${sb}.yaml`), 'utf8')).toBe(V2)
  // 下一次同步：自己名下有了，旧的那份清掉，只剩一份
  await sources.sync([{ kind: 'slang', urls: [B, A], active: true }] as any)
  expect(readdirSync(cdir).sort()).toEqual([`${sb}.meta.json`, `${sb}.yaml`].sort())
})

it('改名失败、读的是旧网址那份时，断网发 bridge.reload（再同步一次）也不会把唯一的那份删掉', async () => {
  let online = false
  const { cdir, sources, sa, sb } = await setup(() => (online ? V1 : null))
  hook.failRename = 1
  await sources.sync([{ kind: 'slang', urls: [B, A], active: true }] as any)
  expect(sources.list()[0].text).toBe(V1)
  // 仍然断网，再同步一次（bridge.reload、纠错都会这样）：手上有内容，不再接，但借来的那份要留着
  await sources.sync([{ kind: 'slang', urls: [B, A], active: true }] as any)
  expect(readdirSync(cdir).sort()).toEqual([`${sa}.meta.json`, `${sa}.yaml`].sort())
  // 联网后下载到同样的内容：补写自己名下的，下一次同步删掉借来的
  online = true
  await sources.refreshAll()
  expect(readFileSync(join(cdir, `${sb}.yaml`), 'utf8')).toBe(V1)
  await sources.sync([{ kind: 'slang', urls: [B, A], active: true }] as any)
  expect(readdirSync(cdir).sort()).toEqual([`${sb}.meta.json`, `${sb}.yaml`].sort())
})
