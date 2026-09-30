// 术语表（清单 §4.6、§12.3）：EVE 官方名称表 + 黑话表 + 控制台 overrides
export type {
  GlossaryMode, GlossaryDir, Direction, SystemStyle, EveEntry, EveData, SlangEntry,
  GlossaryOptions, GlossarySources, GlossaryApplication,
} from './types'
export { parseSlangYaml } from './slang'
export { buildGlossary, Glossary, sourceTraits, userTermProblem } from './glossary'
export { loadCommonWords, loadEveData } from './load'
