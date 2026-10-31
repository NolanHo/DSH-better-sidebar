// @vitest-environment jsdom
/**
 * The transcript's mention vocabulary covers files this thread PRODUCED — and
 * only those. Regression guard for the source set, not for the renderer (see
 * `tests/sidechat-file-mentions.spec.tsx` for the mention control itself).
 *
 * Why this spec exists: the first cut of the vocabulary read `file_path` / `path`
 * out of EVERY `tool/call`, so a `read` target and a `grep`/`glob` root entered
 * it too. The host's own produced-path set is narrower — it counts the mutation
 * tools only (`ui-deliverables/turn-deliverables.ts`'s `mutationPath`: write /
 * edit / str_replace_editor) plus deliveries — and the difference is visible: a
 * directory spelled `` `src` `` or a file the thread merely READ became an
 * openable mention, so clicking it landed the editor on a folder or on a file
 * the thread never wrote.
 *
 * ============================ CONTRACT ============================
 * 1. `producedFilePaths` returns the targets of successful `write` / `edit` /
 *    `str_replace_editor` calls and the `deliverables` paths — nothing else.
 * 2. A `read` target and a `grep` `path` (a directory) are NOT mentions in the
 *    rendered transcript: their inline code stays an inert `<code>`.
 * 3. The mutation targets and the delivered file ARE mentions (the guard: the
 *    narrowing must not empty the vocabulary).
 * ==================================================================
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { producedFilePaths } from '../src/client/sidechat-mentions.ts'
import { transcriptRows } from '../src/client/sidechat-transcript.ts'
import type { SidebarHistoryEntry, SidebarSessionEvent } from '../src/context-types.ts'

/** One `tool/call` + its successful `tool/result`. */
function call(name: string, seq: number, args: Record<string, unknown>): SidebarSessionEvent[] {
  const callId = `c-${name}`
  return [
    {
      type: 'tool/call',
      seq,
      time: seq * 1_000,
      data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) },
    } as SidebarSessionEvent,
    {
      type: 'tool/result',
      seq: seq + 1,
      time: (seq + 1) * 1_000,
      data: {
        turn: 1,
        step: 1,
        message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }] },
      },
    } as SidebarSessionEvent,
  ]
}

/** The paths this thread produced, by tool. */
const READ_PATH = 'src/read-me.ts'
const SEARCH_ROOT = 'src'
const WRITTEN = 'src/written.ts'
const EDITED = 'src/edited.ts'
const EDITOR_PATH = 'src/editor-created.ts'
const DELIVERED = 'src/delivered.ts'

/** The answer that spells every candidate token in inline code. */
const ANSWER = `I read \`${READ_PATH}\`, searched \`${SEARCH_ROOT}\`, wrote \`${WRITTEN}\`, `
  + `edited \`${EDITED}\`, created \`${EDITOR_PATH}\`, and delivered \`${DELIVERED}\`.`

/** A thread that reads, searches, mutates and delivers. */
function events(): SidebarSessionEvent[] {
  return [
    { type: 'session/end-seed', seq: 0, time: 0, data: { inherited: true } } as SidebarSessionEvent,
    {
      type: 'user/message',
      seq: 1,
      time: 1_000,
      data: { content: [{ type: 'text', text: 'which files?' }], source: { kind: 'user' } },
    } as SidebarSessionEvent,
    { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } } as SidebarSessionEvent,
    ...call('read', 3, { file_path: READ_PATH }),
    ...call('grep', 5, { pattern: 'needle', path: SEARCH_ROOT }),
    ...call('write', 7, { file_path: WRITTEN, content: 'x' }),
    ...call('edit', 9, { file_path: EDITED, old_string: 'a', new_string: 'b' }),
    ...call('str_replace_editor', 11, { command: 'create', path: EDITOR_PATH, file_text: 'x' }),
    {
      type: 'deliverables/presented',
      seq: 13,
      time: 13_000,
      data: { turn: 1, files: [{ path: DELIVERED }] },
    } as SidebarSessionEvent,
    {
      type: 'assistant/message',
      seq: 14,
      time: 14_000,
      data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: ANSWER }] } },
    } as SidebarSessionEvent,
  ]
}

/** History rows from a plain event list (the wire's shape). */
function entries(list: readonly SidebarSessionEvent[]): SidebarHistoryEntry[] {
  return list.map(event => ({ event }))
}

/** The mention control inside the inline code whose own text is exactly `token`. */
function mentionOf(container: HTMLElement, token: string): HTMLButtonElement | undefined {
  const codes = [...container.querySelectorAll<HTMLElement>('code')]
  const code = codes.find(element => element.textContent?.trim() === token)
  expect(code, `the token "${token}" renders as inline code`).toBeDefined()
  return code?.querySelector<HTMLButtonElement>('button') ?? undefined
}

let harness: SidechatHarness

beforeEach(() => {
  harness = installSidechatHarness()
})

afterEach(() => {
  harness.cleanup()
})

describe('the mention vocabulary is scoped to producing tools (D12)', () => {
  it('collects mutation targets and deliveries only', () => {
    expect(producedFilePaths(transcriptRows(entries(events())))).toEqual([
      WRITTEN,
      EDITED,
      EDITOR_PATH,
      DELIVERED,
    ])
  })

  it('leaves a read target and a search root inert while the mutations stay clickable', async () => {
    harness.wire.events = events()
    const rendered = harness.mount()
    await harness.flush(4)
    try {
      const { container } = rendered
      expect(mentionOf(container, READ_PATH), 'a file the thread only READ is not a mention').toBeUndefined()
      expect(mentionOf(container, SEARCH_ROOT), 'a search root (a directory) is not a mention').toBeUndefined()

      expect(mentionOf(container, WRITTEN), 'a written file is a mention').toBeDefined()
      expect(mentionOf(container, EDITED), 'an edited file is a mention').toBeDefined()
      expect(mentionOf(container, EDITOR_PATH), 'an editor-created file is a mention').toBeDefined()
      expect(mentionOf(container, DELIVERED), 'a delivered file is a mention').toBeDefined()
    } finally {
      rendered.unmount()
    }
  })
})
