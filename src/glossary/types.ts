// 术语表的公共类型（清单 §4.6、§12.3，PR 2 设计「Glossary」）

export type GlossaryMode = 'keep' | 'force' | 'hint'
export type GlossaryDir = 'both' | 'en2zh' | 'zh2en'
/** d2q = en2zh，q2d = zh2en */
export type Direction = 'en2zh' | 'zh2en'
/** 星系、星域、星座英译中时的写法：`Jita(吉他)` / `Jita` / `吉他` */
export type SystemStyle = 'en(zh)' | 'en' | 'zh'

export interface EveEntry {
  en: string
  zh: string
  kind: 'type' | 'group' | 'category' | 'system' | 'region' | 'constellation'
}

export interface EveData {
  buildNumber: number
  generatedAt: string
  entries: EveEntry[]
}

export interface SlangEntry {
  en: string
  zh: string
  mode: GlossaryMode
  dir: GlossaryDir
  en_aliases?: string[]
  zh_aliases?: string[]
}

export interface GlossaryOptions {
  eve: boolean
  systemStyle: SystemStyle
  overrides: Array<{ en: string; zh: string; mode: GlossaryMode; dir: GlossaryDir }>
}

export interface GlossarySources {
  eveData?: EveData | null
  slang?: SlangEntry[] | null
  /** 每条黑话给警告用的位置（多个黑话表文件时带文件名，T8）；不填时写「黑话表第 N 条」 */
  slangWhere?: string[]
  /** 纠错命令加的词条（B14），优先级和 overrides 相同，排在 overrides 后面（同一个原文以控制台为准） */
  fixes?: SlangEntry[] | null
  commonWords: Set<string>
}

export interface GlossaryApplication {
  /** force、keep 的词换成 ⟦G0⟧、⟦G1⟧…（每一处单独编号） */
  text: string
  /** 还原用：目标语言的标准写法（force 已按 systemStyle；keep 英文原文带复数 s 时补 s） */
  tokens: Array<{ token: string; value: string }>
  /** `EN => 中文`，去重，最多 30 行，按出现顺序 */
  hints: string[]
}

export const MODES: readonly GlossaryMode[] = ['keep', 'force', 'hint']
export const DIRS: readonly GlossaryDir[] = ['both', 'en2zh', 'zh2en']
