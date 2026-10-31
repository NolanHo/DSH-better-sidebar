/**
 * Inline-code file mentions for the Side Chat transcript — the plugin-side
 * mirror of the host's produced-path vocabulary
 * (`ui-deliverables/turn-deliverables.ts`, `producedFileMentions`).
 *
 * The main conversation makes `` `src/client/api.ts` `` clickable because the
 * chat view hands `MarkdownText` a resolver over the paths the turn PRODUCED.
 * The side chat rendered the same answers as dead code, and the host's resolver
 * is deliberately cheap: it never stats the filesystem, it only matches the
 * turn's produced/delivered paths and declines an ambiguous basename. A compact
 * transcript can rebuild exactly that vocabulary from its own rows, which is
 * what this module does — no request per token, no guess at what "looks like" a
 * path.
 *
 * Only two row shapes carry evidence of production:
 * - a `tool/call`'s arguments (`file_path` for the fs tools, `path` for the
 *   search/read family),
 * - a `deliverables` row (`files[].path`, the authoritative delivery record).
 */
import type { SidechatTranscriptRow } from './sidechat-transcript.ts'
import { parseArgsObject } from './sidechat-transcript.ts'
import { baseName } from './paths.ts'

/** The call-argument keys that name a file the call touched, in priority order. */
const MENTION_ARG_KEYS = ['file_path', 'path'] as const

/**
 * Every path this thread produced, in first-seen order and deduplicated.
 * @param rows - the thread's mapped transcript rows.
 * @returns the produced paths exactly as the producing row spelled them
 * (relative call arguments stay relative; delivery events are absolute).
 */
export function producedFilePaths(rows: readonly SidechatTranscriptRow[]): string[] {
  const seen = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim() !== '') seen.add(value)
  }
  for (const row of rows) {
    if (row.kind === 'tool') {
      const args = parseArgsObject(row.args)
      if (args === undefined) continue
      for (const key of MENTION_ARG_KEYS) add(args[key])
    } else if (row.kind === 'deliverables') {
      for (const file of row.files) add(file.path)
    }
  }
  return [...seen]
}

/**
 * The produced path one inline-code token names, or undefined when it names
 * none — the token must equal the path or its basename, and EXACTLY ONE
 * produced path may match (two `dup.ts` under different directories are
 * ambiguous, so the token stays inert rather than opening a guess).
 * @param paths - the thread's produced paths ({@link producedFilePaths}).
 * @param token - the authored inline-code text, exactly as written.
 * @returns the matching produced path, or undefined for an inert token.
 */
export function resolveProducedPath(paths: readonly string[], token: string): string | undefined {
  const wanted = token.trim()
  if (wanted === '') return undefined
  let match: string | undefined
  for (const path of paths) {
    if (path !== wanted && baseName(path) !== wanted) continue
    if (match !== undefined) return undefined
    match = path
  }
  return match
}
