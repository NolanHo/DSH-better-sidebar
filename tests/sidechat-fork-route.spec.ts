/**
 * R2 (route half) — `sidechat.events` must TELL the client where this thread
 * forked off its parent, and what the parent conversation looked like there.
 * Design basis: `/tmp/bsb-parity/forkpoint-recon.md` §Q3 (the cut point, what
 * precedes it, the field shape).
 *
 * Why this spec exists: a side thread's log begins with the inherited parent
 * log as a fork seed, and the route CUTS everything up to the last
 * `session/end-seed { inherited: true }` marker before sending anything. That
 * cut is invisible: the transcript opens on the side question with no hint that
 * it continues a conversation — the reader cannot see which question they were
 * asking in the main pane when they branched off. The parent prefix never
 * crosses the wire, so the client cannot reconstruct it; the host route must
 * summarise it in one additive field.
 *
 * ============================ CONTRACT ============================
 * 1. On the FIRST pull (`afterSeq === undefined`) the result carries an
 *    ADDITIVE `fork` field:
 *      `{ cutSeq: number, user?: { seq, text }, assistant?: { seq, text } }`
 *    where `cutSeq` is the seq of the inherited `session/end-seed` marker the
 *    route cut at (the LAST one — the same marker `threadOwnLogEvents` cuts at,
 *    so a restored/forked-of-a-fork log reports the cut it actually shows).
 * 2. `user` is the LAST real user message BEFORE the cut — "real" meaning a
 *    `user/message` that is NOT a surface REPLACEMENT (`surfaceOp` other than
 *    `'append'`): a compaction checkpoint is logged as a `user/message` and must
 *    never be presented as the question the reader typed. `assistant` is the
 *    last `assistant/message` text before the cut (its `text` blocks only —
 *    reasoning never leaks into the banner).
 * 3. Payload caps: `user.text` is at most 400 characters and `assistant.text`
 *    at most 240, truncating the TAIL and keeping the beginning (the reader
 *    needs the opening of the sentence, not its end).
 * 4. Independently optional: a message whose text blocks are empty (an
 *    image-only prompt) contributes nothing, so `user` is absent rather than
 *    `{ text: '' }`. With neither part present the field is still `{ cutSeq }`.
 * 5. Absent when it cannot be known: no inherited marker (an unseeded log) →
 *    NO `fork` field at all; and a DELTA pull (`afterSeq` given) never carries
 *    it (the client caches it from the first pull only).
 * 6. The field is additive: `events`, `live`, `pending` and `truncated` keep
 *    their shapes and values, and `events` is still the CUT tail (the parent
 *    prefix must not leak into the transcript through the new field's provider).
 * ==================================================================
 *
 * Kept in its own file (rather than appended to tests/sidechat-routes.spec.ts)
 * so the existing route assertions stay untouched. The fakes below are the
 * minimal live-agent face the `sidechat.events` handler reads.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildSidechatApi } from '../src/sidechat-routes.ts'
import type { Context } from '../src/context-types.ts'

/** The most the banner may carry of the parent's last question. */
const USER_CAP = 400
/** The most the banner may carry of the parent's last answer. */
const ASSISTANT_CAP = 240

/** One `{seq,text}` part of the fork field. */
interface ForkPart {
  seq: number
  text: string
}

/** The `sidechat.events` result, plus the field this contract adds. */
interface EventsResult {
  events: { seq: number; type: string }[]
  live: unknown[]
  pending: unknown[]
  truncated?: boolean
  fork?: { cutSeq: number; user?: ForkPart; assistant?: ForkPart }
}

/** The narrowest live agent the events handler reads. */
function agent(id: string, events: unknown[]) {
  const inbox = { nextTurn: [] as unknown[], nextStep: [] as unknown[], clear: vi.fn(), remove: vi.fn(() => true) }
  return {
    id,
    status: 'idle' as const,
    options: { provider: 'test', model: 'model-x' },
    ctx: { on: vi.fn(() => () => {}) },
    session: {
      id,
      header: { cwd: '/p', delegationDepth: 0 },
      inheritedEventCount: 0,
      snapshotEvents: () => events,
      append: vi.fn((type: string, data: unknown) => ({ type, seq: 0, time: 0, data })),
    },
    inject: vi.fn(),
    followup: vi.fn(),
    cancel: vi.fn(),
    inbox,
  }
}

/** A context serving only the agents service the handler needs. */
function ctxWithAgents(child: ReturnType<typeof agent>): Context {
  return {
    get: (key: string) => (key === 'agents' ? { get: (id: string) => (id === child.id ? child : undefined) } : undefined),
  } as unknown as Context
}

/** One plain `user/message` as the log records it. */
function userEvent(seq: number, text: string): unknown {
  return {
    type: 'user/message',
    seq,
    time: seq * 1_000,
    surfaceOp: 'append',
    data: { id: `mu-${String(seq)}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

/** One `assistant/message` whose content carries text and (optionally) reasoning. */
function assistantEvent(seq: number, text: string, reasoning = ''): unknown {
  const content: unknown[] = []
  if (reasoning !== '') content.push({ type: 'reasoning', text: reasoning })
  if (text !== '') content.push({ type: 'text', text })
  return {
    type: 'assistant/message',
    seq,
    time: seq * 1_000,
    surfaceOp: 'append',
    data: { turn: 1, step: 1, message: { content } },
  }
}

/** The inherited seed marker the route cuts at. */
function seedMarker(seq: number): unknown {
  return { type: 'session/end-seed', seq, time: seq * 1_000, data: { inherited: true } }
}

/** The parent conversation: two question/answer pairs, then the cut. */
function parentLog(): unknown[] {
  return [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    userEvent(1, 'PARENT-QUESTION-ONE'),
    assistantEvent(2, 'PARENT-ANSWER-ONE'),
    userEvent(3, 'PARENT-QUESTION-TWO'),
    assistantEvent(4, 'PARENT-ANSWER-TWO'),
  ]
}

/** The thread's own events after the cut. */
function ownLog(): unknown[] {
  return [
    userEvent(7, 'SIDE-QUESTION'),
    { type: 'turn/start', seq: 8, time: 8_000, data: { turn: 1 } },
  ]
}

/** The default thread log: parent prefix, cut marker at 6, own events after. */
function seededLog(): unknown[] {
  return [...parentLog(), seedMarker(6), ...ownLog()]
}

/**
 * Read the events route over one thread log.
 * @param events - the full decoded log (seed + own).
 * @param payload - extra request fields (`afterSeq` for a delta pull).
 */
async function eventsRoute(events: unknown[], payload: Record<string, unknown> = {}): Promise<EventsResult> {
  const child = agent('child', events)
  const api = buildSidechatApi(ctxWithAgents(child))
  const result = await api['sidechat.events']({ childId: 'child', ...payload })
  return result as unknown as EventsResult
}

describe('sidechat.events fork point (R2)', () => {
  it('reports the cut and the parent question/answer on the first pull', async () => {
    const result = await eventsRoute(seededLog())
    expect(result.fork, 'the first pull carries the fork point').toBeDefined()
    expect(result.fork?.cutSeq, 'the cut is the inherited seed marker').toBe(6)
    expect(result.fork?.user, 'the parent question is summarised').toMatchObject({
      seq: 3,
      text: 'PARENT-QUESTION-TWO',
    })
    expect(result.fork?.assistant, 'the parent answer tail is summarised').toMatchObject({
      seq: 4,
      text: 'PARENT-ANSWER-TWO',
    })
  })

  it('still returns the CUT tail as the transcript events', async () => {
    const result = await eventsRoute(seededLog())
    expect(
      result.events.map(event => event.seq),
      'the parent prefix never leaks into the transcript',
    ).toEqual([7, 8])
    expect(result.truncated, 'the existing fields keep their shapes').toBe(false)
    expect(Array.isArray(result.live)).toBe(true)
    expect(Array.isArray(result.pending)).toBe(true)
  })

  it('skips a compaction checkpoint instead of presenting it as the question', async () => {
    const checkpoint = {
      type: 'user/message',
      seq: 5,
      time: 5_000,
      // A replacement surface event: the compacted summary masquerading as a
      // user message (`compactSource`, host `command.ts:60-77`).
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 4 },
      data: {
        id: 'm-checkpoint',
        role: 'user',
        content: [{ type: 'text', text: 'COMPACTED SUMMARY OF THE OLD TURNS' }],
        source: { kind: 'compact-checkpoint', compactionId: 'cp1' },
      },
    }
    const result = await eventsRoute([...parentLog(), checkpoint, seedMarker(6), ...ownLog()])
    expect(result.fork?.cutSeq).toBe(6)
    expect(result.fork?.user?.seq, 'the real question, not the checkpoint').toBe(3)
    expect(result.fork?.user?.text).toBe('PARENT-QUESTION-TWO')
  })

  it('reads the LAST inherited marker, like the transcript cut does', async () => {
    // A restored / re-forked log can carry more than one inherited marker; the
    // cut that matters is the one whose tail is on screen.
    const result = await eventsRoute([
      userEvent(0, 'OLDEST-QUESTION'),
      seedMarker(1),
      userEvent(2, 'MIDDLE-QUESTION'),
      assistantEvent(3, 'MIDDLE-ANSWER'),
      seedMarker(4),
      userEvent(5, 'SIDE-QUESTION'),
    ])
    expect(result.fork?.cutSeq, 'the last inherited marker is the cut').toBe(4)
    expect(result.fork?.user?.text, 'the question before THAT cut').toBe('MIDDLE-QUESTION')
    expect(result.fork?.assistant?.text).toBe('MIDDLE-ANSWER')
  })

  it('caps the carried text and keeps the beginning of each part', async () => {
    const longQuestion = `${'Q'.repeat(900)}-TAIL-OF-QUESTION`
    const longAnswer = `${'A'.repeat(900)}-TAIL-OF-ANSWER`
    const result = await eventsRoute([
      userEvent(1, longQuestion),
      assistantEvent(2, longAnswer),
      seedMarker(3),
      ...ownLog(),
    ])
    const user = result.fork?.user?.text ?? ''
    const assistant = result.fork?.assistant?.text ?? ''
    expect(user.length, 'the question is capped').toBeLessThanOrEqual(USER_CAP)
    expect(assistant.length, 'the answer is capped').toBeLessThanOrEqual(ASSISTANT_CAP)
    expect(user.startsWith('QQQQ'), 'the opening of the question survives').toBe(true)
    expect(assistant.startsWith('AAAA'), 'the opening of the answer survives').toBe(true)
    expect(user.endsWith('-TAIL-OF-QUESTION'), 'the tail is what gets dropped').toBe(false)
  })

  it('never leaks reasoning into the answer tail', async () => {
    const result = await eventsRoute([
      userEvent(1, 'PARENT-QUESTION'),
      assistantEvent(2, 'PARENT-ANSWER', 'PRIVATE-REASONING'),
      seedMarker(3),
      ...ownLog(),
    ])
    expect(result.fork?.assistant?.text).toBe('PARENT-ANSWER')
    expect(result.fork?.assistant?.text ?? '', 'reasoning is not banner material').not.toContain('PRIVATE-REASONING')
  })

  it('omits a part whose message carries no text', async () => {
    const imageOnly = {
      type: 'user/message',
      seq: 2,
      time: 2_000,
      surfaceOp: 'append',
      data: {
        id: 'm-image',
        role: 'user',
        content: [{ type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } }],
        source: { kind: 'user' },
      },
    }
    const result = await eventsRoute([userEvent(1, 'PARENT-QUESTION'), imageOnly, seedMarker(3), ...ownLog()])
    expect(result.fork?.cutSeq).toBe(3)
    expect(result.fork?.user, 'an image-only prompt has no text to show').toBeUndefined()
  })

  it('still reports the cut when the parent prefix carries nothing usable', async () => {
    const result = await eventsRoute([seedMarker(0), ...ownLog()])
    expect(result.fork, 'an empty seed still says where the thread forked').toEqual({ cutSeq: 0 })
  })

  it('omits the field for an unseeded log', async () => {
    const unseeded = [
      { type: 'session/end-seed', seq: 0, time: 0, data: {} },
      userEvent(1, 'FIRST-QUESTION'),
    ]
    const result = await eventsRoute(unseeded)
    expect('fork' in result ? result.fork : undefined, 'no inherited marker, no fork point').toBeUndefined()
  })

  it('omits the field on a delta pull', async () => {
    const result = await eventsRoute(seededLog(), { afterSeq: 7 })
    expect(result.events.map(event => event.seq), 'the delta itself is unchanged').toEqual([8])
    expect('fork' in result ? result.fork : undefined, 'only the first pull carries it').toBeUndefined()
  })
})
