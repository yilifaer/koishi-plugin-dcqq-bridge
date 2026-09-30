#!/usr/bin/env node
// 从 CCP 官方静态数据（SDE，JSONL 格式）生成 data/eve-glossary.json（官方中英名称表）。
// Builds data/eve-glossary.json (official EN/ZH names) from CCP's static data export (JSONL zip).
//
// 用法 / Usage:
//   node scripts/build-eve-glossary.mjs [--zip <local path>] [--url <zip url>] [--out data/eve-glossary.json]
//
// 不带 --zip / --url 时：先读 latest.jsonl 拿到 buildNumber，再下载对应版本的 zip 到临时文件（流式写盘）。
// zip 内的每个文件都用 yauzl 流式读取 + readline 逐行解析，不会整个解压进内存。
//
// 本脚本代码按 MIT 许可发布；它生成的数据文件不属于 MIT，见 data/NOTICE。

import { createWriteStream, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

const SDE_BASE = 'https://developers.eveonline.com/static-data/tranquility'
const LATEST_URL = `${SDE_BASE}/latest.jsonl`
const zipUrlFor = (build) => `${SDE_BASE}/eve-online-static-data-${build}-jsonl.zip`

/** 收录物品的类别：材料、舰船、装备、弹药、商品、无人机、植入体、可部署物、星堡、小行星、子系统、建筑、建筑装备、铁骑 */
export const TYPE_CATEGORIES = new Set([4, 6, 7, 8, 17, 18, 20, 22, 23, 25, 32, 65, 66, 87])
/** 不收的类别：SKIN、蓝图、服装、技能、特别版；「个性化」按名字在数据里找 */
const EXCLUDED_CATEGORY_IDS = new Set([91, 9, 30, 16, 63])
const PERSONALIZATION_NAME = 'personalization'
/** 代号星系（以及同样形式的星域、星座名） */
const CODE_NAME = /^[A-Z0-9]{1,5}-[A-Z0-9]{1,5}$/
/** 虫洞空间等特殊空间：星系按 regionID，星域按 _key，星座按 _key / regionID */
const WH_REGION_MIN = 11000000
const WH_CONSTELLATION_MIN = 21000000
export const KIND_ORDER = ['type', 'group', 'category', 'system', 'region', 'constellation']
/**
 * 物品词条额外带上的类别标记（只给运行时要用的类别加，保持文件小）：
 * ship = 舰船（去掉「级」的写法，U4），structure = 建筑（建筑通知里的建筑类型，U6）
 */
export const TYPE_CAT_MARKERS = new Map([[6, 'ship'], [65, 'structure']])

function parseArgs(argv) {
  const args = { zip: null, url: null, out: 'data/eve-glossary.json' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} 需要一个参数 / ${a} requires a value`)
      return v
    }
    if (a === '--zip') args.zip = next()
    else if (a === '--url') args.url = next()
    else if (a === '--out') args.out = next()
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/build-eve-glossary.mjs [--zip <local path>] [--url <zip url>] [--out data/eve-glossary.json]')
      process.exit(0)
    } else throw new Error(`未知参数 / unknown argument: ${a}`)
  }
  if (args.zip && args.url) throw new Error('--zip 和 --url 只能选一个 / use either --zip or --url')
  return args
}

async function fetchLatestBuild() {
  const res = await fetch(LATEST_URL)
  if (!res.ok) throw new Error(`GET ${LATEST_URL} → HTTP ${res.status}`)
  const text = await res.text()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const obj = JSON.parse(line)
    if (obj._key === 'sde' && Number.isInteger(obj.buildNumber)) return obj.buildNumber
  }
  throw new Error(`${LATEST_URL} 里没有 buildNumber`)
}

async function download(url, dest) {
  console.error(`下载 / downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`GET ${url} → HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
  console.error(`已保存 / saved ${statSync(dest).size} bytes → ${dest}`)
}

function openZip(path) {
  return new Promise((ok, fail) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return fail(err)
      const entries = new Map()
      zip.on('entry', (entry) => {
        entries.set(entry.fileName.replace(/^.*\//, ''), entry)
        zip.readEntry()
      })
      zip.on('end', () => ok({ zip, entries }))
      zip.on('error', fail)
      zip.readEntry()
    })
  })
}

/** 逐行流式读取 zip 里的一个 JSONL 文件 */
async function eachLine(zipCtx, name, onObject) {
  const entry = zipCtx.entries.get(name)
  if (!entry) throw new Error(`zip 里缺少 ${name}`)
  const stream = await new Promise((ok, fail) => {
    zipCtx.zip.openReadStream(entry, (err, s) => (err ? fail(err) : ok(s)))
  })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let n = 0
  for await (const line of rl) {
    n++
    if (!line.trim()) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch (e) {
      throw new Error(`${name} 第 ${n} 行不是合法 JSON: ${e.message}`)
    }
    onObject(obj)
  }
}

/** 取出修剪过的中英文名；任一缺失或相同则返回 null */
function names(obj) {
  const en = typeof obj?.name?.en === 'string' ? obj.name.en.trim() : ''
  const zh = typeof obj?.name?.zh === 'string' ? obj.name.zh.trim() : ''
  if (!en || !zh) return { en, zh, ok: false, same: false }
  if (en === zh) return { en, zh, ok: false, same: true }
  return { en, zh, ok: true, same: false }
}

export async function buildFromZip(zipPath) {
  const ctx = await openZip(zipPath)
  const stats = {
    counts: Object.fromEntries(KIND_ORDER.map((k) => [k, 0])),
    skippedSame: Object.fromEntries(KIND_ORDER.map((k) => [k, 0])),
    skippedMissing: Object.fromEntries(KIND_ORDER.map((k) => [k, 0])),
    excludedCategories: [],
    duplicates: 0,
  }
  try {
    let buildNumber = null
    await eachLine(ctx, '_sde.jsonl', (o) => {
      if (o._key === 'sde' && Number.isInteger(o.buildNumber)) buildNumber = o.buildNumber
    })
    if (buildNumber == null) throw new Error('_sde.jsonl 里没有 buildNumber')

    const raw = []
    const add = (kind, obj, cat) => {
      const n = names(obj)
      if (!n.ok) {
        if (n.same) stats.skippedSame[kind]++
        else stats.skippedMissing[kind]++
        return
      }
      raw.push(cat ? { en: n.en, zh: n.zh, kind, cat } : { en: n.en, zh: n.zh, kind })
    }

    // 类别
    const categories = new Map()
    await eachLine(ctx, 'categories.jsonl', (o) => categories.set(o._key, o))
    const excludedCats = new Set()
    for (const [id, c] of categories) {
      const en = typeof c?.name?.en === 'string' ? c.name.en.trim() : ''
      if (EXCLUDED_CATEGORY_IDS.has(id) || en.toLowerCase() === PERSONALIZATION_NAME) {
        excludedCats.add(id)
        stats.excludedCategories.push({ id, en, zh: c?.name?.zh ?? null })
      }
    }
    for (const [id, c] of categories) {
      if (c.published === true && !excludedCats.has(id)) add('category', c)
    }

    // 组别
    const groupCategory = new Map()
    await eachLine(ctx, 'groups.jsonl', (g) => {
      groupCategory.set(g._key, g.categoryID)
      if (g.published === true && !excludedCats.has(g.categoryID)) add('group', g)
    })

    // 物品（最大的文件，153 MB，逐行处理）
    await eachLine(ctx, 'types.jsonl', (t) => {
      if (t.published !== true || t.marketGroupID == null) return
      const cat = groupCategory.get(t.groupID)
      if (!TYPE_CATEGORIES.has(cat) || excludedCats.has(cat)) return
      add('type', t, TYPE_CAT_MARKERS.get(cat))
    })

    // 地图：排除代号名字和虫洞等特殊空间
    const isCode = (o) => CODE_NAME.test(typeof o?.name?.en === 'string' ? o.name.en.trim() : '')
    await eachLine(ctx, 'mapRegions.jsonl', (r) => {
      if (r._key >= WH_REGION_MIN || isCode(r)) return
      add('region', r)
    })
    await eachLine(ctx, 'mapConstellations.jsonl', (c) => {
      if (c._key >= WH_CONSTELLATION_MIN || (c.regionID ?? 0) >= WH_REGION_MIN || isCode(c)) return
      add('constellation', c)
    })
    await eachLine(ctx, 'mapSolarSystems.jsonl', (s) => {
      if ((s.regionID ?? 0) >= WH_REGION_MIN || isCode(s)) return
      add('system', s)
    })

    // 去掉完全相同的条目，排序：先按 kind，再按 en，再按 zh（按码位比较，结果确定）
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
    raw.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || cmp(a.en, b.en) || cmp(a.zh, b.zh))
    const entries = []
    for (const e of raw) {
      const last = entries[entries.length - 1]
      if (last && last.kind === e.kind && last.en === e.en && last.zh === e.zh) {
        stats.duplicates++
        continue
      }
      entries.push(e)
      stats.counts[e.kind]++
    }
    return { data: { buildNumber, generatedAt: new Date().toISOString(), entries }, stats }
  } finally {
    ctx.zip.close()
  }
}

/** 紧凑输出，每条一行，方便看 diff */
export function serialize(data) {
  const head = `{"buildNumber":${JSON.stringify(data.buildNumber)},"generatedAt":${JSON.stringify(data.generatedAt)},"entries":[`
  const lines = data.entries.map((e) => JSON.stringify(e.cat ? { en: e.en, zh: e.zh, kind: e.kind, cat: e.cat } : { en: e.en, zh: e.zh, kind: e.kind }))
  return lines.length ? `${head}\n${lines.join(',\n')}\n]}\n` : `${head}]}\n`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let zipPath = args.zip
  let tmp = null
  try {
    if (!zipPath) {
      let url = args.url
      if (!url) {
        const build = await fetchLatestBuild()
        console.error(`最新版本 / latest buildNumber: ${build}`)
        url = zipUrlFor(build)
      }
      tmp = mkdtempSync(join(tmpdir(), 'eve-sde-'))
      zipPath = join(tmp, 'sde.zip')
      await download(url, zipPath)
    }
    const { data, stats } = await buildFromZip(resolve(zipPath))
    const out = resolve(args.out)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, serialize(data))

    console.log(`buildNumber: ${data.buildNumber}`)
    console.log('排除的类别 / excluded categories:')
    for (const c of stats.excludedCategories) console.log(`  ${c.id}\t${c.en}\t${c.zh ?? ''}`)
    console.log('条目 / entries per kind (skipped en==zh, skipped missing name):')
    for (const k of KIND_ORDER) {
      console.log(`  ${k.padEnd(13)} ${String(stats.counts[k]).padStart(6)}   (${stats.skippedSame[k]}, ${stats.skippedMissing[k]})`)
    }
    console.log(`  duplicates removed: ${stats.duplicates}`)
    console.log(`合计 / total: ${data.entries.length}`)
    console.log(`文件 / file: ${out} (${statSync(out).size} bytes)`)
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}

import { pathToFileURL } from 'node:url'
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err?.stack ?? String(err))
    process.exit(1)
  })
}
