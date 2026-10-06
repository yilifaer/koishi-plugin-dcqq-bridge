// 0.4.0 在线词表：黑话表、官方名称表写成网址，定时下载、缓存、失败时继续用旧的。
// 用本机的模拟服务器代替 GitHub，不访问外网；词条、网址都是编造的。

import { createHash } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeSettings } from '../src/bridges'
import { Config } from '../src/config'
import { loadEveData, parseOnlineEveData, parseSlangYaml, splitUrls } from '../src/glossary'
import { cacheStem } from '../src/online'
import { baseConfig, Env, flatten, OWNER_QQ, PR2_DEFAULTS, setup, sleep } from './harness'

// ------------------------------------------------------------------ 模拟写缓存失败

// 打开时，接下来 times 次写在线词表的内容文件（.yaml / .json 和它们的临时文件，不含 .meta.json）报错：
// rename = 改名时文件被占用（Windows 上杀毒软件开着文件），writeFile = 磁盘满了。别的时候照常读写。
const fsFault = vi.hoisted(() => ({ op: null as 'rename' | 'writeFile' | null, code: 'EPERM', times: 0, hits: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const CONTENT = /[\\/](slang|official)-[0-9a-f]{12}\.(yaml|json)(\.[0-9a-z-]+\.tmp)?$/
  const fault = (op: 'rename' | 'writeFile', path: unknown) => {
    if (fsFault.op !== op || fsFault.times <= 0 || !CONTENT.test(String(path))) return
    fsFault.times--
    fsFault.hits++
    throw Object.assign(new Error(`${fsFault.code}: 模拟写入失败，${op}`), { code: fsFault.code })
  }
  return {
    ...fs,
    writeFile: (async (path: any, ...rest: any[]) => {
      fault('writeFile', path)
      return (fs.writeFile as any)(path, ...rest)
    }) as typeof fs.writeFile,
    rename: (async (from: any, to: any) => {
      fault('rename', to)
      return fs.rename(from, to)
    }) as typeof fs.rename,
  }
})

// ------------------------------------------------------------------ 模拟的数据仓库

interface FakeFile {
  body: string
  etag?: string
  status?: number
  delayMs?: number
  /** 不用 body，尽快写这么多字节（不带 Content-Length），模拟很大的错误页 */
  bigBytes?: number
}

interface Hit {
  path: string
  ifNoneMatch?: string
  status: number
  /** bigBytes：已经写出去的字节数、有没有写完、连接是否已经关了 */
  sent?: number
  finished?: boolean
  closed?: boolean
}

class FakeRepo {
  server!: http.Server
  base = ''
  files = new Map<string, FakeFile>()
  hits: Hit[] = []
  /** 所有请求都断开连接（模拟断网） */
  down = false

  async start() {
    this.server = http.createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  url(path: string) {
    return `${this.base}${path}`
  }

  hitsOf(path: string) {
    return this.hits.filter((h) => h.path === path)
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const path = (req.url ?? '/').split('?')[0]
    const ifNoneMatch = req.headers['if-none-match'] as string | undefined
    if (this.down) {
      this.hits.push({ path, ifNoneMatch, status: 0 })
      return req.socket.destroy()
    }
    const file = this.files.get(path)
    if (file?.delayMs) await sleep(file.delayMs)
    let status = !file ? 404 : file.status ?? 200
    if (status === 200 && file?.etag && ifNoneMatch === file.etag) status = 304
    const hit: Hit = { path, ifNoneMatch, status }
    this.hits.push(hit)
    res.statusCode = status
    if (file?.etag) res.setHeader('ETag', file.etag)
    if (file?.bigBytes) return this.pump(res, file.bigBytes, hit)
    res.end(status === 200 ? file!.body : '')
  }

  /** 尽快写 total 字节；对方不读了（连接被关）就停下 */
  private pump(res: http.ServerResponse, total: number, hit: Hit) {
    res.setHeader('Content-Type', 'text/html')
    res.on('finish', () => { hit.finished = true })
    res.on('close', () => { hit.closed = true })
    res.on('error', () => {})
    const chunk = Buffer.alloc(64 * 1024, 0x78)
    hit.sent = 0
    const write = () => {
      while (hit.sent! < total) {
        if (res.destroyed) return
        hit.sent! += chunk.length
        if (!res.write(chunk)) return void res.once('drain', write)
      }
      res.end()
    }
    write()
  }

  stop() {
    this.server.closeAllConnections?.()
    return new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

// 和 eve-cn-slang 的 glossary.yaml 一样带 category、note、别名这些字段
const SLANG_V1 = `
- en: "stratop"
  zh: "战略行动"
  mode: force
  dir: both
  en_aliases: ["strat op"]
  zh_aliases: ["战略集结"]
  category: fleet
  note: "示例"
- en: "logi"
  zh: "后勤"
  mode: force
  dir: en2zh
  category: ship
  note: "示例"
`
const SLANG_V2 = SLANG_V1.replace('"后勤"', '"奶妈"')

const BUNDLED = loadEveData()!
/** 和插件自带的表一样、但去掉 cat、build 加 1 的在线官方表；再加一条编造的星系，用来认出用的是在线表 */
function remoteOfficial(patch: Record<string, unknown> = {}) {
  const entries = [...BUNDLED.entries.map(({ kind, en, zh }) => ({ kind, en, zh })), { kind: 'system', en: 'Zzyzx Testpoint', zh: '测试星点' }]
  return JSON.stringify({
    source: 'test', buildNumber: BUNDLED.buildNumber + 1, generatedAt: '2026-10-01T00:00:00Z', license: 'test',
    count: entries.length, entries, ...patch,
  })
}

const glossaryPatch = (glossary: Partial<typeof PR2_DEFAULTS.glossary> & { officialUrl?: string; refreshHours?: number }) => ({
  glossary: { ...PR2_DEFAULTS.glossary, ...glossary },
})

async function waitFor(check: () => boolean, ms = 4000) {
  for (let waited = 0; waited < ms; waited += 20) {
    if (check()) return
    await sleep(20)
  }
  throw new Error('等待超时')
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex')
const en2zh = (env: Env, text: string) => env.relay.translation.glossary!.apply(text, 'en2zh').tokens.map((t) => t.value)
const zh2en = (env: Env, text: string) => env.relay.translation.glossary!.apply(text, 'zh2en').tokens.map((t) => t.value)
const status = async (env: Env) => (await env.command(OWNER_QQ, 'bridge.status')).join('\n')
const privates = (env: Env) => env.qq.calls.filter((c) => c.action === 'send_private_msg').map((c) => flatten(c.params.message))
const reload = async (env: Env) => {
  const before = privates(env).length
  await env.command(OWNER_QQ, 'bridge.reload')
  // bridge.reload 要先下载，回复可能比 command() 默认等的久
  await waitFor(() => privates(env).length > before)
  return privates(env).slice(before).join('\n')
}

let repo: FakeRepo
let dir: string
let envs: Env[] = []
const cacheDir = () => join(dir, 'data/dcqq-bridge/cache')
const cacheFiles = () => (existsSync(cacheDir()) ? readdirSync(cacheDir()).sort() : [])

async function start(patch: Parameters<typeof setup>[0], relay: { onlineRefreshMs?: number } = {}) {
  const env = await setup(patch, { baseDir: dir, relay })
  envs.push(env)
  return env
}

async function stop(env: Env) {
  envs = envs.filter((e) => e !== env)
  await env.stop()
}

beforeEach(async () => {
  Object.assign(fsFault, { op: null, code: 'EPERM', times: 0, hits: 0 })
  repo = new FakeRepo()
  await repo.start()
  dir = mkdtempSync(join(tmpdir(), 'dcqq-online-'))
})

afterEach(async () => {
  for (const env of envs) await env.stop().catch(() => {})
  envs = []
  await repo.stop()
  rmSync(dir, { recursive: true, force: true })
})

// ================================================================== 配置

describe('0.4.0 配置：默认全部关闭', () => {
  it('网址默认空，检查间隔默认 6 小时；0 = 不定时；太小的值按半小时', () => {
    const c = Config({} as any)
    expect(c.glossary.officialUrl).toBe('')
    expect(c.glossary.refreshHours).toBe(6)
    expect(c.glossary.slangFile).toBe('')
    const s = (refreshHours: unknown) => normalizeSettings(baseConfig(glossaryPatch({ refreshHours: refreshHours as number }))).glossary.refreshHours
    expect(normalizeSettings(baseConfig()).glossary).toMatchObject({ officialUrl: '', refreshHours: 6 })
    expect(s(0)).toBe(0)
    expect(s(0.1)).toBe(0.5)
    expect(s(-1)).toBe(6)
    expect(s('abc')).toBe(6)
    expect(s(12)).toBe(12)
  })

  it('`||` 分隔备用网址；不是 http(s) 的部分单独列出来', () => {
    expect(splitUrls(' https://a.example/x.yaml || https://b.example/x.yaml ')).toEqual({ urls: ['https://a.example/x.yaml', 'https://b.example/x.yaml'], bad: [] })
    expect(splitUrls('https://a.example/x.yaml||data/x.yaml')).toEqual({ urls: ['https://a.example/x.yaml'], bad: ['data/x.yaml'] })
  })

  it('黑话表多出来的字段（category、note）不算错', () => {
    const parsed = parseSlangYaml(SLANG_V1)
    expect(parsed.warnings).toEqual([])
    expect(parsed.fatal).toBeUndefined()
    expect(parsed.entries).toHaveLength(2)
    expect(parseSlangYaml('<html>404</html>').fatal).toBe('最外层不是列表')
  })
})

// ================================================================== 在线黑话表

describe('0.4.0 在线黑话表', () => {
  it('和本地文件一样按顺序合并，后面的覆盖前面的；启动时不等下载', async () => {
    repo.files.set('/glossary.yaml', { body: SLANG_V1 })
    writeFileSync(join(dir, 'local.yaml'), '- en: logi\n  zh: 奶妈\n  mode: force\n  dir: en2zh\n')
    const env = await start(glossaryPatch({ slangFile: `${repo.url('/glossary.yaml')};;local.yaml` }))
    await waitFor(() => !!env.relay.translation.online.list()[0]?.lastSuccess && en2zh(env, 'stratop now').length > 0)
    expect(en2zh(env, 'stratop now')).toEqual(['战略行动'])
    expect(zh2en(env, '今晚战略集结')).toEqual(['stratop'])
    expect(en2zh(env, 'need logi')).toEqual(['奶妈']) // 本地文件在后面，覆盖在线的
    const text = await reload(env)
    expect(text).toContain('glossary.yaml（在线）2 条，更新于')
    expect(text).toContain('(UTC+8)')
    expect(text).toContain('local.yaml 1 条（覆盖前面文件里的 1 条）')
    // 缓存：一份内容、一份记录，内容和下载的一样
    const stem = cacheStem('slang', repo.url('/glossary.yaml'))
    expect(cacheFiles()).toEqual([`${stem}.meta.json`, `${stem}.yaml`])
    expect(readFileSync(join(cacheDir(), `${stem}.yaml`), 'utf8')).toBe(SLANG_V1)
  })

  it('第一个网址下载不了时用备用网址', async () => {
    repo.files.set('/mirror/glossary.yaml', { body: SLANG_V1 })
    const env = await start(glossaryPatch({ slangFile: `${repo.url('/gh/glossary.yaml')} || ${repo.url('/mirror/glossary.yaml')}` }))
    await waitFor(() => en2zh(env, 'stratop now').length > 0)
    expect(repo.hitsOf('/gh/glossary.yaml')[0].status).toBe(404)
    const source = env.relay.translation.online.list()[0]
    expect(source.error).toBeNull()
    expect(source.meta.url).toBe(repo.url('/mirror/glossary.yaml'))
    expect(await status(env)).toContain('在线黑话表 glossary.yaml：最近一次下载成功')
  })

  it('下载失败时用缓存：断网重启后马上就有词条，status 和 reload 写明用的是缓存', async () => {
    repo.files.set('/glossary.yaml', { body: SLANG_V1 })
    const config = glossaryPatch({ slangFile: repo.url('/glossary.yaml') })
    const first = await start(config)
    await waitFor(() => !!first.relay.translation.online.list()[0]?.lastSuccess)
    await stop(first)

    repo.down = true
    const env = await start(config)
    // 启动刚完成（后台下载还没结束）就已经能用缓存里的词条
    expect(en2zh(env, 'stratop now')).toEqual(['战略行动'])
    expect(env.relay.translation.online.list()[0].from).toBe('cache')
    await waitFor(() => !!env.relay.translation.online.list()[0].error)
    expect(en2zh(env, 'stratop now')).toEqual(['战略行动'])
    const text = await status(env)
    expect(text).toMatch(/⚠ 在线黑话表 glossary\.yaml：下载失败：127\.0\.0\.1:\d+ 网络错误.*，用的是 .*\(UTC\+8\) 的缓存/)
    const reply = await reload(env)
    expect(reply).toMatch(/glossary\.yaml（在线）读不到（.+），用的是 .+ 的缓存，2 条/)
    expect(en2zh(env, 'stratop now')).toEqual(['战略行动'])
  })

  it('没有缓存又下载不了：照常启动，黑话表算读不到', async () => {
    repo.down = true
    const env = await start(glossaryPatch({ slangFile: repo.url('/glossary.yaml') }))
    const reply = await reload(env)
    expect(reply).toMatch(/glossary\.yaml（在线）读不到（.+），还没有可用的版本/)
    expect(await status(env)).toContain('还没有下载成功过')
    expect(cacheFiles()).toEqual([])
  })

  it('下载到的内容不是 YAML 列表（例如错误页）：不替换手上的版本', async () => {
    repo.files.set('/glossary.yaml', { body: SLANG_V1 })
    const env = await start(glossaryPatch({ slangFile: repo.url('/glossary.yaml') }))
    await waitFor(() => en2zh(env, 'stratop now').length > 0)
    repo.files.set('/glossary.yaml', { body: '<html>rate limited</html>' })
    const reply = await reload(env)
    expect(reply).toContain('内容不对：最外层不是列表')
    expect(en2zh(env, 'stratop now')).toEqual(['战略行动'])
    expect(readFileSync(join(cacheDir(), `${cacheStem('slang', repo.url('/glossary.yaml'))}.yaml`), 'utf8')).toBe(SLANG_V1)
  })

  it('插件停用后，正在进行的下载结果不再使用、不写缓存', async () => {
    repo.files.set('/glossary.yaml', { body: SLANG_V1, delayMs: 600 })
    const begin = Date.now()
    const env = await start(glossaryPatch({ slangFile: repo.url('/glossary.yaml') }))
    expect(Date.now() - begin).toBeLessThan(3000) // 启动不等那 600 毫秒（setup 本身也要一点时间）
    expect(env.relay.translation.glossary?.size).toBe(0)
    await stop(env)
    await sleep(900)
    expect(cacheFiles()).toEqual([])
  })
})

// ================================================================== 不变不重建、变了就重建、定时检查

describe('0.4.0 定时检查', () => {
  it('内容没变不重建；变了就重建并让翻译缓存失效；停用后定时器停止', async () => {
    // 模拟翻译服务：记下请求次数
    let requests = 0
    const llm = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        requests++
        // 原样带回 <text> 里的内容（占位符不变）
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        const text = /<text>([\s\S]*)<\/text>/.exec(json.messages?.at(-1)?.content ?? '')?.[1] ?? ''
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `译：${text}` } }] }))
      })
    })
    await new Promise<void>((resolve) => llm.listen(0, '127.0.0.1', resolve))
    const llmBase = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`
    try {
      repo.files.set('/glossary.yaml', { body: SLANG_V1, etag: '"v1"' })
      const env = await start({
        ...glossaryPatch({ slangFile: repo.url('/glossary.yaml') }),
        translate: { ...PR2_DEFAULTS.translate, enabled: true, baseURL: llmBase, model: 'test-model' },
      }, { onlineRefreshMs: 100 })
      await waitFor(() => en2zh(env, 'need logi').length > 0)
      const g1 = env.relay.translation.glossary!
      expect(en2zh(env, 'need logi')).toEqual(['后勤'])
      // 定时检查：带 If-None-Match，服务器回复 304，术语表不重建
      await waitFor(() => repo.hitsOf('/glossary.yaml').filter((h) => h.status === 304).length >= 2)
      expect(repo.hitsOf('/glossary.yaml').find((h) => h.status === 304)?.ifNoneMatch).toBe('"v1"')
      expect(env.relay.translation.glossary).toBe(g1)
      // 没有 ETag、内容一样：也不重建
      repo.files.set('/glossary.yaml', { body: SLANG_V1 })
      const before = repo.hits.length
      await waitFor(() => repo.hits.slice(before).some((h) => h.status === 200))
      await sleep(50)
      expect(env.relay.translation.glossary).toBe(g1)

      // 翻译一次，第二次用缓存
      const msg = { platform: 'discord', translatable: 'please bring logi to the fleet tonight', protect: [] } as any
      expect(await env.relay.translation.translate(msg, 'en2zh')).toMatchObject({ ok: true })
      expect(await env.relay.translation.translate(msg, 'en2zh')).toMatchObject({ ok: true })
      expect(requests).toBe(1)

      // 内容变了：重建，版本变了，同一句话重新翻译
      repo.files.set('/glossary.yaml', { body: SLANG_V2, etag: '"v2"' })
      await waitFor(() => env.relay.translation.glossary !== g1)
      expect(env.relay.translation.glossary!.version).not.toBe(g1.version)
      expect(en2zh(env, 'need logi')).toEqual(['奶妈'])
      expect(await env.relay.translation.translate(msg, 'en2zh')).toMatchObject({ ok: true })
      expect(requests).toBe(2)
      // 缓存里还是只有一份，是新的内容
      const stem = cacheStem('slang', repo.url('/glossary.yaml'))
      expect(cacheFiles()).toEqual([`${stem}.meta.json`, `${stem}.yaml`])
      expect(readFileSync(join(cacheDir(), `${stem}.yaml`), 'utf8')).toBe(SLANG_V2)
      expect(JSON.parse(readFileSync(join(cacheDir(), `${stem}.meta.json`), 'utf8'))).toMatchObject({ etag: '"v2"' })

      // 停用后不再检查
      await stop(env)
      const count = repo.hits.length
      await sleep(400)
      expect(repo.hits.length).toBe(count)
    } finally {
      llm.closeAllConnections?.()
      await new Promise<void>((resolve) => llm.close(() => resolve()))
    }
  })

  it('refreshHours = 0：只在启动和 bridge.reload 时下载', async () => {
    repo.files.set('/glossary.yaml', { body: SLANG_V1 })
    const env = await start(glossaryPatch({ slangFile: repo.url('/glossary.yaml'), refreshHours: 0 }))
    await waitFor(() => repo.hits.length === 1)
    await sleep(300)
    expect(repo.hits).toHaveLength(1)
    await reload(env)
    expect(repo.hits).toHaveLength(2)
  })
})

// ================================================================== 在线官方名称表

describe('0.4.0 在线官方名称表', () => {
  it('检查格式：不是 JSON、没有 buildNumber、count 不符、缺字段、条数太少都不用；不认识的 kind 跳过', () => {
    expect(parseOnlineEveData('{', BUNDLED).error).toBe('不是有效的 JSON')
    expect(parseOnlineEveData('[]', BUNDLED).error).toBe('最外层不是对象')
    expect(parseOnlineEveData(remoteOfficial({ buildNumber: 'x' }), BUNDLED).error).toBe('没有 buildNumber')
    expect(parseOnlineEveData(remoteOfficial({ count: 5 }), BUNDLED).error).toMatch(/^count 是 5/)
    expect(parseOnlineEveData(remoteOfficial({ entries: [{ kind: 'type', en: 'X' }], count: 1 }), BUNDLED).error).toBe('entries 里有缺少 kind / en / zh 的条目')
    const few = Array.from({ length: 100 }, (_, i) => ({ kind: 'type', en: `Item ${i}`, zh: `物品${i}` }))
    expect(parseOnlineEveData(remoteOfficial({ entries: few, count: 100 }), BUNDLED).error).toMatch(/^只有 100 条，不到插件自带表的一半/)
    const extra = JSON.parse(remoteOfficial())
    extra.entries.push({ kind: 'faction', en: 'Some Faction', zh: '某势力' })
    extra.count++
    const ok = parseOnlineEveData(JSON.stringify(extra), BUNDLED)
    expect(ok.error).toBeUndefined()
    expect(ok.skipped).toBe(1)
    expect(ok.catFilled).toBeGreaterThan(400)
    // 文件里自己有 cat 时以文件为准，不补
    const withCat = JSON.parse(remoteOfficial())
    withCat.entries.push({ kind: 'type', en: 'Made Up Hull', zh: '编造舰级', cat: 'ship' })
    withCat.count++
    const own = parseOnlineEveData(JSON.stringify(withCat), BUNDLED)
    expect(own.catFilled).toBe(0)
    expect(own.data!.entries.filter((e) => e.cat)).toHaveLength(1)
  })

  it('在线表没有 cat：从自带表补上，末日沙场照样认得；status 显示在线表的 build', async () => {
    repo.files.set('/official/eve-official.json', { body: remoteOfficial() })
    const env = await start(glossaryPatch({ eve: true, officialUrl: repo.url('/official/eve-official.json') }))
    await waitFor(() => env.relay.translation.official?.from === 'online')
    expect(env.relay.translation.official).toMatchObject({ buildNumber: BUNDLED.buildNumber + 1, count: BUNDLED.entries.length + 1, name: 'eve-official.json' })
    expect(env.relay.translation.official!.catFilled).toBeGreaterThan(400)
    expect(zh2en(env, '末日沙场来了')).toEqual(['Armageddon'])
    expect(en2zh(env, 'staging in Zzyzx Testpoint')).toEqual(['Zzyzx Testpoint(测试星点)'])
    expect(env.relay.translation.glossary!.structureTypeNames()).toContain('Astrahus')
    expect(env.relay.translation.glossary!.structureTypeNames().length).toBeGreaterThan(0)
    expect(await status(env)).toContain(`官方名称表：eve-official.json（在线）build ${BUNDLED.buildNumber + 1}`)
  })

  it('格式不对的在线表不用：没有旧版本时用插件自带的，有旧版本时继续用旧的', async () => {
    repo.files.set('/official.json', { body: JSON.stringify({ buildNumber: 1, entries: [{ kind: 'type', en: 'X', zh: 'Y' }] }) })
    const env = await start(glossaryPatch({ eve: true, officialUrl: repo.url('/official.json') }))
    await waitFor(() => !!env.relay.translation.online.list()[0]?.error)
    expect(await status(env)).toMatch(new RegExp(`官方名称表：插件自带 build ${BUNDLED.buildNumber}，${BUNDLED.entries.length} 条（在线表读不到：.*内容不对：只有 1 条`))
    expect(cacheFiles()).toEqual([])

    repo.files.set('/official.json', { body: remoteOfficial() })
    let reply = await reload(env)
    expect(reply).toContain(`官方名称表：official.json（在线）build ${BUNDLED.buildNumber + 1}`)
    repo.files.set('/official.json', { body: '{"buildNumber": 9' })
    reply = await reload(env)
    expect(reply).toMatch(/official\.json（在线）build \d+.*最近一次下载失败：.*不是有效的 JSON/)
    expect(env.relay.translation.official?.from).toBe('online')
    expect(en2zh(env, 'staging in Zzyzx Testpoint')).toEqual(['Zzyzx Testpoint(测试星点)'])
  })

  it('没打开官方名称表时不下载，只提示', async () => {
    repo.files.set('/official.json', { body: remoteOfficial() })
    const env = await start(glossaryPatch({ eve: false, officialUrl: repo.url('/official.json') }))
    await sleep(200)
    expect(repo.hits).toHaveLength(0)
    expect(await status(env)).toContain('填了在线官方名称表，但没有打开「EVE 官方名称表」，不下载')
  })
})

// ================================================================== bridge.reload

describe('0.4.0 bridge.reload', () => {
  it('马上下载所有在线来源，并按来源报告', async () => {
    repo.files.set('/glossary.yaml', { body: SLANG_V1 })
    repo.files.set('/eve-official.json', { body: remoteOfficial() })
    writeFileSync(join(dir, 'local.yaml'), '- en: cyno\n  zh: 诱导\n  mode: force\n  dir: both\n')
    const env = await start(glossaryPatch({
      eve: true,
      slangFile: `${repo.url('/glossary.yaml')};;local.yaml;;${repo.url('/broken.yaml')}`,
      officialUrl: repo.url('/eve-official.json'),
    }))
    await waitFor(() => env.relay.translation.official?.from === 'online'
      && env.relay.translation.online.list().every((s) => s.lastSuccess || s.error))
    const hits = repo.hits.length
    const reply = await reload(env)
    expect(repo.hits.length).toBe(hits + 3)
    expect(reply).toMatch(/黑话表：glossary\.yaml（在线）2 条，更新于 .+\(UTC\+8\)，local\.yaml 1 条，broken\.yaml（在线）读不到（127\.0\.0\.1:\d+ HTTP 404），还没有可用的版本/)
    expect(reply).toContain(`官方名称表：eve-official.json（在线）build ${BUNDLED.buildNumber + 1}，${BUNDLED.entries.length + 1} 条，更新于`)
  })
})

// ================================================================== 缓存清理

describe('0.4.0 缓存只留一份', () => {
  it('不再配置的网址的缓存和记录被删掉；上次没写完的临时文件被删掉；别的文件不动', async () => {
    repo.files.set('/a.yaml', { body: SLANG_V1 })
    repo.files.set('/b.yaml', { body: SLANG_V2, delayMs: 500 })
    const first = await start(glossaryPatch({ slangFile: repo.url('/a.yaml') }))
    await waitFor(() => !!first.relay.translation.online.list()[0]?.lastSuccess)
    await stop(first)
    const a = cacheStem('slang', repo.url('/a.yaml'))
    const b = cacheStem('slang', repo.url('/b.yaml'))
    expect(cacheFiles()).toEqual([`${a}.meta.json`, `${a}.yaml`])
    // 写到一半断电留下的临时文件、使用者自己放的文件
    writeFileSync(join(cacheDir(), `${a}.yaml.1234-abcd.tmp`), 'half')
    writeFileSync(join(cacheDir(), 'notes.txt'), 'mine')
    writeFileSync(join(cacheDir(), 'other.tmp'), 'mine')

    const env = await start(glossaryPatch({ slangFile: repo.url('/b.yaml') }))
    expect(cacheFiles()).toEqual(['notes.txt', 'other.tmp'])
    await waitFor(() => !!env.relay.translation.online.list()[0]?.lastSuccess)
    expect(cacheFiles()).toEqual(['notes.txt', 'other.tmp', `${b}.meta.json`, `${b}.yaml`])
    // 下载成功以后才重新加载术语表（异步），等它加载完
    await waitFor(() => en2zh(env, 'need logi')[0] === '奶妈')
  })

  it('把在线网址全部删掉后，重启时缓存也清掉', async () => {
    mkdirSync(cacheDir(), { recursive: true })
    const stem = cacheStem('official', 'https://example.org/eve-official.json')
    writeFileSync(join(cacheDir(), `${stem}.json`), '{}')
    writeFileSync(join(cacheDir(), `${stem}.meta.json`), '{}')
    await start(glossaryPatch({}))
    expect(cacheFiles()).toEqual([])
  })
})

// ================================================================== 0.4.0 复查修正

describe('0.4.0 复查：检查间隔不超过 Node 定时器的上限', () => {
  it.each([720, 1000])('refreshHours = %i：按 168 小时（一周）算，不会变成不停地下载', async (hours) => {
    repo.files.set('/glossary.yaml', { body: SLANG_V1, etag: '"v1"' })
    const env = await start(glossaryPatch({ slangFile: repo.url('/glossary.yaml'), refreshHours: hours }))
    await waitFor(() => repo.hits.length >= 1 && !!env.relay.translation.online.list()[0]?.lastSuccess)
    await sleep(400)
    // 只有启动时的那一次（超过上限时 Node 会把间隔改成 1 毫秒，一秒几百次）
    expect(repo.hits).toHaveLength(1)
    expect(env.relay.translation.online.intervalMs).toBe(168 * 3600000)
    expect(normalizeSettings(baseConfig(glossaryPatch({ refreshHours: hours }))).glossary.refreshHours).toBe(168)
    expect(normalizeSettings(baseConfig(glossaryPatch({ refreshHours: 168 }))).glossary.refreshHours).toBe(168)
  })

  it('传进来的间隔超过 2^31-1 毫秒时按上限算', async () => {
    repo.files.set('/glossary.yaml', { body: SLANG_V1, etag: '"v1"' })
    const env = await start(glossaryPatch({ slangFile: repo.url('/glossary.yaml'), refreshHours: 0 }))
    await waitFor(() => repo.hits.length === 1)
    env.relay.translation.startOnline(3_000_000_000)
    await waitFor(() => repo.hits.length >= 2)
    await sleep(400)
    expect(repo.hits).toHaveLength(2)
    expect(env.relay.translation.online.intervalMs).toBe(2 ** 31 - 1)
  })
})

describe('0.4.0 复查：缓存的内容和记录要对得上', () => {
  const contentFile = (url: string) => join(cacheDir(), `${cacheStem('slang', url)}.yaml`)
  const metaOf = (url: string) => JSON.parse(readFileSync(join(cacheDir(), `${cacheStem('slang', url)}.meta.json`), 'utf8'))

  it.each([
    ['改名时文件被占用（EPERM）', 'rename', 'EPERM'],
    ['磁盘满了（ENOSPC）', 'writeFile', 'ENOSPC'],
  ] as const)('内容缓存写不进去（%s）：记录不换成新的 ETag，重启后重新下载整份，不被「没变」钉在旧版本', async (_, op, code) => {
    const url = repo.url('/glossary.yaml')
    const config = glossaryPatch({ slangFile: url })
    repo.files.set('/glossary.yaml', { body: SLANG_V1, etag: '"v1"' })
    const first = await start(config)
    await waitFor(() => !!first.relay.translation.online.list()[0]?.lastSuccess)
    expect(metaOf(url).etag).toBe('"v1"')

    // 上游换成 V2；这一次内容写不进去（记录照常能写）
    repo.files.set('/glossary.yaml', { body: SLANG_V2, etag: '"v2"' })
    Object.assign(fsFault, { op, code, times: 1 })
    await reload(first)
    expect(fsFault.hits).toBe(1)
    expect(en2zh(first, 'need logi')).toEqual(['奶妈']) // 这次运行里照样用新的
    expect(readFileSync(contentFile(url), 'utf8')).toBe(SLANG_V1)
    // 记录还是旧内容的：不能是旧内容配上新的 ETag
    expect(metaOf(url).etag).toBe('"v1"')
    expect(metaOf(url).hash).toBe(sha1(SLANG_V1))
    await stop(first)

    // 重启：带的是旧内容的 ETag，服务器发整份 V2
    const env = await start(config)
    expect(en2zh(env, 'need logi')).toEqual(['后勤']) // 启动时先用缓存
    await waitFor(() => en2zh(env, 'need logi')[0] === '奶妈')
    expect(repo.hitsOf('/glossary.yaml').at(-1)).toMatchObject({ status: 200, ifNoneMatch: '"v1"' })
    expect(readFileSync(contentFile(url), 'utf8')).toBe(SLANG_V2)
    expect(metaOf(url)).toMatchObject({ etag: '"v2"', hash: sha1(SLANG_V2) })
    // 之后服务器回复「没变」，用的还是 V2
    await reload(env)
    expect(repo.hitsOf('/glossary.yaml').at(-1)).toMatchObject({ status: 304, ifNoneMatch: '"v2"' })
    expect(en2zh(env, 'need logi')).toEqual(['奶妈'])
  })

  it('记录里的 sha1 和缓存的内容对不上（例如只换了一半）：不带 ETag，重新下载整份', async () => {
    const url = repo.url('/glossary.yaml')
    repo.files.set('/glossary.yaml', { body: SLANG_V2, etag: '"v2"' })
    mkdirSync(cacheDir(), { recursive: true })
    writeFileSync(contentFile(url), SLANG_V1)
    writeFileSync(join(cacheDir(), `${cacheStem('slang', url)}.meta.json`), JSON.stringify({
      urls: [url], url, etag: '"v2"', savedAt: Date.parse('2026-10-01T00:00:00Z'), hash: sha1(SLANG_V2),
    }))
    const env = await start(glossaryPatch({ slangFile: url }))
    expect(en2zh(env, 'need logi')).toEqual(['后勤'])
    await waitFor(() => !!env.relay.translation.online.list()[0]?.lastSuccess)
    expect(repo.hitsOf('/glossary.yaml')[0]).toMatchObject({ status: 200, ifNoneMatch: undefined })
    await waitFor(() => en2zh(env, 'need logi')[0] === '奶妈')
    expect(readFileSync(contentFile(url), 'utf8')).toBe(SLANG_V2)
    expect(metaOf(url)).toMatchObject({ etag: '"v2"', hash: sha1(SLANG_V2) })
  })

  it('第一次内容写不进去：下一次服务器回复「没变」时补写缓存，断网重启也有词条', async () => {
    const url = repo.url('/glossary.yaml')
    const config = glossaryPatch({ slangFile: url })
    repo.files.set('/glossary.yaml', { body: SLANG_V1, etag: '"v1"' })
    Object.assign(fsFault, { op: 'rename', code: 'EPERM', times: 1 })
    const env = await start(config)
    await waitFor(() => !!env.relay.translation.online.list()[0]?.lastSuccess)
    expect(fsFault.hits).toBe(1)
    expect(existsSync(contentFile(url))).toBe(false)
    await waitFor(() => en2zh(env, 'stratop now')[0] === '战略行动')

    await reload(env)
    expect(repo.hitsOf('/glossary.yaml').at(-1)).toMatchObject({ status: 304, ifNoneMatch: '"v1"' })
    expect(existsSync(contentFile(url))).toBe(true)
    expect(readFileSync(contentFile(url), 'utf8')).toBe(SLANG_V1)
    expect(metaOf(url)).toMatchObject({ etag: '"v1"', hash: sha1(SLANG_V1) })
    await stop(env)

    repo.down = true
    const again = await start(config)
    expect(en2zh(again, 'stratop now')).toEqual(['战略行动'])
    expect(again.relay.translation.online.list()[0].from).toBe('cache')
  })
})

describe('0.4.0 复查：错误状态不读错误页', () => {
  it.each([404, 500])('服务器回复 %i 并带一个 60 MB 的错误页：不读内容就断开，原因写 HTTP 状态码', async (code) => {
    const total = 60 * 1024 * 1024
    repo.files.set('/glossary.yaml', { body: '', status: code, bigBytes: total })
    const env = await start(glossaryPatch({ slangFile: repo.url('/glossary.yaml') }))
    await waitFor(() => !!env.relay.translation.online.list()[0]?.error)
    expect(env.relay.translation.online.list()[0].error!.reason).toMatch(new RegExp(`^127\\.0\\.0\\.1:\\d+ HTTP ${code}$`))
    const hit = repo.hitsOf('/glossary.yaml')[0]
    await waitFor(() => !!hit.closed)
    expect(hit.finished).toBeFalsy()
    expect(hit.sent).toBeLessThan(total)
    expect(await status(env)).toMatch(new RegExp(`⚠ 在线黑话表 glossary\\.yaml：下载失败：127\\.0\\.0\\.1:\\d+ HTTP ${code}`))
  })
})

describe('0.4.0 复查：改了、调换了 `||` 里的网址', () => {
  const stemOf = (url: string) => cacheStem('slang', url)
  const metaOf = (url: string) => JSON.parse(readFileSync(join(cacheDir(), `${stemOf(url)}.meta.json`), 'utf8'))

  it('断网时把镜像调到前面：缓存改成新的文件名接着用，只留一份；GitHub 还在，ETag 保留', async () => {
    const gh = repo.url('/gh/glossary.yaml')
    const mirror = repo.url('/mirror/glossary.yaml')
    repo.files.set('/gh/glossary.yaml', { body: SLANG_V1, etag: '"v1"' })
    const first = await start(glossaryPatch({ slangFile: `${gh} || ${mirror}` }))
    await waitFor(() => !!first.relay.translation.online.list()[0]?.lastSuccess)
    await stop(first)
    expect(cacheFiles()).toEqual([`${stemOf(gh)}.meta.json`, `${stemOf(gh)}.yaml`])

    repo.down = true
    const env = await start(glossaryPatch({ slangFile: `${mirror} || ${gh}` }))
    expect(en2zh(env, 'stratop now')).toEqual(['战略行动'])
    expect(env.relay.translation.online.list()[0].from).toBe('cache')
    expect(cacheFiles()).toEqual([`${stemOf(mirror)}.meta.json`, `${stemOf(mirror)}.yaml`])
    expect(readFileSync(join(cacheDir(), `${stemOf(mirror)}.yaml`), 'utf8')).toBe(SLANG_V1)
    expect(metaOf(mirror)).toMatchObject({ urls: [mirror, gh], url: gh, etag: '"v1"', hash: sha1(SLANG_V1) })
    await waitFor(() => !!env.relay.translation.online.list()[0].error)
    expect(en2zh(env, 'stratop now')).toEqual(['战略行动'])

    // 网络恢复：镜像上没有这个文件，GitHub 带着原来的 ETag 回复「没变」
    repo.down = false
    const before = repo.hits.length
    await reload(env)
    expect(repo.hits.slice(before).map((h) => [h.path, h.status, h.ifNoneMatch])).toEqual([
      ['/mirror/glossary.yaml', 404, undefined],
      ['/gh/glossary.yaml', 304, '"v1"'],
    ])
    expect(cacheFiles()).toEqual([`${stemOf(mirror)}.meta.json`, `${stemOf(mirror)}.yaml`])
  })

  it('第一个网址改了、备用网址还在：缓存接着用，但不带旧网址的 ETag', async () => {
    const gh = repo.url('/gh/glossary.yaml')
    const typo = repo.url('/gh-typo/glossary.yaml')
    const mirror = repo.url('/mirror/glossary.yaml')
    repo.files.set('/gh/glossary.yaml', { body: SLANG_V1, etag: '"v1"' })
    repo.files.set('/mirror/glossary.yaml', { body: SLANG_V1, etag: '"m1"' })
    const first = await start(glossaryPatch({ slangFile: `${gh} || ${mirror}` }))
    await waitFor(() => !!first.relay.translation.online.list()[0]?.lastSuccess)
    await stop(first)

    repo.down = true
    const env = await start(glossaryPatch({ slangFile: `${typo} || ${mirror}` }))
    expect(en2zh(env, 'stratop now')).toEqual(['战略行动'])
    expect(cacheFiles()).toEqual([`${stemOf(typo)}.meta.json`, `${stemOf(typo)}.yaml`])
    const meta = metaOf(typo)
    expect(meta).toMatchObject({ urls: [typo, mirror], hash: sha1(SLANG_V1) })
    expect(meta.url).toBeUndefined()
    expect(meta.etag).toBeUndefined()

    repo.down = false
    const before = repo.hits.length
    await reload(env)
    expect(repo.hits.slice(before).map((h) => [h.path, h.status, h.ifNoneMatch])).toEqual([
      ['/gh-typo/glossary.yaml', 404, undefined],
      ['/mirror/glossary.yaml', 200, undefined],
    ])
    expect(metaOf(typo)).toMatchObject({ url: mirror, etag: '"m1"' })
    expect(cacheFiles()).toEqual([`${stemOf(typo)}.meta.json`, `${stemOf(typo)}.yaml`])
  })
})

describe('0.4.0 复查：在线黑话表一条词条都没有时不用', () => {
  it.each([
    ['只有注释', '# maintenance\n'],
    ['空列表', '[]\n'],
    ['只有 ~', '~\n'],
  ])('下载到 %s 的内容：不替换手上的版本，缓存不变，status 和 reload 写原因', async (_, body) => {
    // 本地文件只有注释：照旧当作 0 条，不算错
    writeFileSync(join(dir, 'local.yaml'), '# 还没写\n')
    const url = repo.url('/glossary.yaml')
    repo.files.set('/glossary.yaml', { body: SLANG_V1 })
    const env = await start(glossaryPatch({ slangFile: `${url};;local.yaml` }))
    await waitFor(() => en2zh(env, 'stratop now').length > 0)
    const file = join(cacheDir(), `${cacheStem('slang', url)}.yaml`)
    expect(readFileSync(file, 'utf8')).toBe(SLANG_V1)

    repo.files.set('/glossary.yaml', { body })
    const reply = await reload(env)
    expect(reply).toMatch(/glossary\.yaml（在线）读不到（127\.0\.0\.1:\d+ 内容不对：没有可用的词条），用的是 .+ 的版本，2 条/)
    expect(reply).toContain('local.yaml 0 条')
    expect(await status(env)).toMatch(/⚠ 在线黑话表 glossary\.yaml：下载失败：127\.0\.0\.1:\d+ 内容不对：没有可用的词条/)
    expect(en2zh(env, 'stratop now')).toEqual(['战略行动'])
    expect(readFileSync(file, 'utf8')).toBe(SLANG_V1)
  })
})
