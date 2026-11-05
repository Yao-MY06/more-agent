/**
 * Makes Chinese searchable in a plain FTS5 index, which treats a run of Han characters as one token and so cannot find a word
 * inside it. Runs become overlapping pairs before they reach the index, on both sides. Follows OpenClaw's memory-core tokenizer;
 * `trigram` was the alternative, but it cannot match two-character words, and those are most Chinese keywords.
 */
const CJK_CLASS = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff'
/** The second branch excludes CJK, or `Token消耗` would stay one token, and mixed text like that is common. */
const TOKEN = new RegExp(`[${CJK_CLASS}]+|(?:(?![${CJK_CLASS}])[\\p{L}\\p{N}_])+`, 'gu')
const CJK_RUN = new RegExp(`^[${CJK_CLASS}]`, 'u')
/** Beyond this a long message only slows the query down, and its opening already says what it is about. */
const MAX_QUERY_TERMS = 64

function pairs(run: string): string[] {
  const characters = [...run]
  if (characters.length === 1) return characters
  return characters.slice(1).map((character, index) => `${characters[index]}${character}`)
}

export function memoryTokens(text: string): string[] {
  const words = text.normalize('NFKC').toLowerCase().match(TOKEN) ?? []
  return words.flatMap((word) => (CJK_RUN.test(word) ? pairs(word) : [word]))
}

/** Any term may match, and BM25 ranks by how many do. Every term is quoted, so what a person wrote cannot become FTS syntax. */
export function ftsQuery(text: string): string | undefined {
  const terms = [...new Set(memoryTokens(text))].slice(0, MAX_QUERY_TERMS)
  return terms.length ? terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ') : undefined
}
