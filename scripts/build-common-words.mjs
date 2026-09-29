// 生成 data/common-words.txt（清单 §12.3「常用英语单词表」，决定 P1）
// 来源：SCOWL（npm 包 wordlist-english，devDependency），级别 english-words-10 + 20 + 35。
// 用法：node scripts/build-common-words.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = dirname(require.resolve('wordlist-english/package.json'))
const levels = [10, 20, 35]

const words = new Set()
for (const level of levels) {
  const list = JSON.parse(readFileSync(resolve(pkgDir, `english-words-${level}.json`), 'utf8'))
  for (const word of list) {
    const w = String(word).trim().toLowerCase()
    if (w) words.add(w)
  }
}

const sorted = [...words].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const header = `# SCOWL (Spell Checker Oriented Word Lists, Kevin Atkinson) via npm wordlist-english, levels english-words-${levels.join('/')}; lowercased, deduped, sorted. See data/NOTICE for the SCOWL copyright notice.`
const out = resolve(root, 'data/common-words.txt')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, header + '\n' + sorted.join('\n') + '\n')
console.log(`wrote ${sorted.length} words to data/common-words.txt`)
