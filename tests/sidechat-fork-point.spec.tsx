// @vitest-environment jsdom
/**
 * R2 (client half) — the transcript says WHERE it forked off the parent
 * conversation, and what was being discussed there. Design basis:
 * `/tmp/bsb-parity/forkpoint-recon.md` §Q3/§Q4 (field shape, the parent title
 * the session list already carries, the top-chrome precedent at
 * `SideChatView.tsx:1884-1890` next to `data-sidechat-truncated-notice`).
 *
 * Why this spec exists: a side thread opens on the side question, as if the
 * conversation began there. The reader has no way to see which main-pane
 * question they branched from, nor what the main pane had just answered — yet
 * that context is exactly what the side thread was forked to continue. The
 * route now summarises it (`fork`, see tests/sidechat-fork-route.spec.ts); the
 * transcript must show it.
 *
 * ============================ CONTRACT ============================
 * 1. PLACEMENT AND SHAPE. When the first pull carries `fork` with something to
 *    show, the transcript renders ONE banner inside the transcript's scroll
 *    container, ABOVE the first mounted transcript row (the same chrome region
 *    as the truncation notice). The banner is a native disclosure —
 *    `<details data-sidechat-fork-point>` with a `<summary>` — and it starts
 *    COLLAPSED.
 * 2. COLLAPSED LINE: the localized label `t('sideChatForkBanner')`, the
 *    parent's last question summary (the route's `fork.user.text`, rendered
 *    verbatim), and the parent session's title when the session list knows the
 *    thread's `parentId` (the host field is `displayTitle`).
 * 3. EXPANDED BODY: the parent's answer tail (`fork.assistant.text`) under the
 *    localized heading `t('sideChatForkAnswer')`, so the reader can see what
 *    was answered just before they branched.
 * 4. NOTHING TO SAY = NO BANNER: without the field, or with a field carrying
 *    neither `user` nor `assistant` (an empty seed), the transcript renders no
 *    banner at all.
 * 5. CHROME, NOT CONVERSATION: the banner carries no
 *    `data-sidechat-transcript-row` and changes neither the number nor the
 *    content of the mounted transcript rows.
 *
 * Locale keys this contract needs (every shipped dictionary, not just zh/en):
 *   `sideChatForkBanner` — the banner's line ("forked from the main session")
 *   `sideChatForkAnswer` — the heading of the expanded answer tail
 * ==================================================================
 *
 * The harness's fetch stub answers `sidechat.events` from `wire`, which owns no
 * `fork` field; this spec wraps the stub (the harness is untouched) to inject
 * it into the envelope, exactly as the host route does — the same technique the
 * truncation notice spec uses for `truncated`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installSidechatHarness, type SidechatHarness } from './helpers/sidechat-view-harness.tsx'
import { t } from '../src/client/locales.ts'

/** The banner's line label. */
const BANNER_KEY = 'sideChatForkBanner'
/** The expanded answer tail's heading. */
const ANSWER_KEY = 'sideChatForkAnswer'

/** What the route reports for the parent's last exchange. */
const PARENT_QUESTION = 'PARENT-QUESTION-TWO'
const PARENT_ANSWER = 'PARENT-ANSWER-TWO'
/** The parent session's `displayTitle` in the harness's own session list. */
const PARENT_TITLE = '主会话'

/** Translate a key this spec names but the build may not have yet. */
function copy(key: string, params?: Record<string, string | number>): string {
  return (t as unknown as (key: string, params?: Record<string, string | number>) => string)(key, params)
}

/** The field the route adds to the `sidechat.events` result. */
interface ForkField {
  cutSeq: number
  user?: { seq: number; text: string }
  assistant?: { seq: number; text: string }
}

/** The thread's own (seed-cut) log: the side question and its answer. */
function events(): unknown[] {
  return [
    { type: 'session/end-seed', seq: 0, time: 0, data: { inherited: true } },
    {
      type: 'user/message',
      seq: 1,
      time: 1_000,
      surfaceOp: 'append',
      data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'SIDE-QUESTION' }], source: { kind: 'user' } },
    },
    { type: 'turn/start', seq: 2, time: 2_000, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 3,
      time: 3_000,
      surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'SIDE-ANSWER' }] } },
    },
    { type: 'turn/end', seq: 4, time: 4_000, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/**
 * Wrap the harness's `sidechat.events` envelope so the FIRST pull carries
 * `fork`, the way the host route will.
 * @param fork - the field to inject, or undefined to leave the response alone.
 */
function reportFork(fork: ForkField | undefined): void {
  if (fork === undefined) return
  const stubbed = globalThis.fetch
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const response = await stubbed(input as string, init)
    if (!String(input).endsWith('sidechat.events')) return response
    const body = await response.json() as { ok?: boolean; value?: Record<string, unknown> }
    // A delta poll answers without the field, exactly like the route.
    const isFirstPull = !String(init?.body ?? '').includes('afterSeq')
    return {
      ok: response.ok,
      status: response.status,
      json: async () => ({ ...body, value: { ...body.value, ...(isFirstPull ? { fork } : {}) } }),
    } as unknown as Response
  })
}

/** The transcript's scroll container. */
function scrollerOf(container: HTMLElement): HTMLElement {
  const scroller = container.querySelector('[data-genui-surface="dsh-better-sidebar/sidechat"]')
  expect(scroller, 'the transcript renders its scroll container').not.toBeNull()
  return scroller as HTMLElement
}

/** The mounted transcript rows, in document order. */
function mountedRows(container: HTMLElement): Element[] {
  return [...container.querySelectorAll('[data-sidechat-transcript-row]')]
}

/** The fork banner, or null when the transcript shows none. */
function bannerOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-sidechat-fork-point]')
}

/** Whether `earlier` precedes `later` in document order. */
function precedes(earlier: Element, later: Element): boolean {
  return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
}

let harness: SidechatHarness

beforeEach(() => {
  harness = installSidechatHarness()
  harness.wire.events = events()
})

afterEach(() => {
  harness.cleanup()
})

/** Mount the transcript and let the first pull settle. */
async function mountTranscript() {
  const rendered = harness.mount()
  await harness.flush(6)
  return rendered
}

describe('fork point banner (R2)', () => {
  it('defines the banner copy in the dictionaries', () => {
    expect(copy(BANNER_KEY), `the ${BANNER_KEY} key must exist in the locale dictionary`).not.toBe(BANNER_KEY)
    expect(copy(ANSWER_KEY), `the ${ANSWER_KEY} key must exist in the locale dictionary`).not.toBe(ANSWER_KEY)
  })

  it('renders a collapsed banner above the transcript with the parent question', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountTranscript()
    try {
      const container = rendered.container
      const banner = bannerOf(container)
      expect(banner, 'the fork point is shown').not.toBeNull()
      const details = banner as HTMLElement
      expect(details.tagName, 'the banner is a native disclosure').toBe('DETAILS')
      expect(details.hasAttribute('open'), 'it starts collapsed').toBe(false)
      expect(scrollerOf(container).contains(details), 'it lives in the transcript chrome region').toBe(true)

      const rows = mountedRows(container)
      expect(rows.length, 'the transcript itself still renders').toBeGreaterThan(0)
      expect(precedes(details, rows[0] as Element), 'it sits above the first row').toBe(true)

      const line = details.querySelector('summary')?.textContent ?? ''
      expect(line, 'the line says this is a fork of the main session').toContain(copy(BANNER_KEY))
      expect(line, 'and quotes the question that was being asked').toContain(PARENT_QUESTION)
      expect(line, 'and names the parent session when it is known').toContain(PARENT_TITLE)
      expect(container.textContent ?? '', 'the side thread itself still renders').toContain('SIDE-QUESTION')
    } finally {
      rendered.unmount()
    }
  })

  it('shows the parent answer tail behind the disclosure', async () => {
    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountTranscript()
    try {
      const details = bannerOf(rendered.container) as HTMLElement
      expect(details, 'the fork point is shown').not.toBeNull()
      const summary = details.querySelector('summary')
      const body = [...details.querySelectorAll<HTMLElement>('*')]
        .filter(element => element !== summary && summary?.contains(element) !== true)
      const bodyText = body.map(element => element.textContent ?? '').join('\n')
      expect(bodyText, 'the answer tail is in the expanded body').toContain(PARENT_ANSWER)
      expect(bodyText, 'under a localized heading').toContain(copy(ANSWER_KEY))
    } finally {
      rendered.unmount()
    }
  })

  it('shows the banner without a question when only the answer is known', async () => {
    reportFork({ cutSeq: 0, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountTranscript()
    try {
      const details = bannerOf(rendered.container) as HTMLElement
      expect(details, 'an answer-only fork still says where it came from').not.toBeNull()
      expect(details.textContent ?? '', 'and carries the answer').toContain(PARENT_ANSWER)
      expect(details.textContent ?? '', 'with no placeholder for the absent question').not.toContain('undefined')
    } finally {
      rendered.unmount()
    }
  })

  it('renders no banner when the route reports no fork point', async () => {
    const rendered = await mountTranscript()
    try {
      expect(bannerOf(rendered.container), 'an unseeded thread has nothing to show').toBeNull()
      expect(rendered.container.textContent ?? '', 'and the transcript is whole').toContain('SIDE-ANSWER')
    } finally {
      rendered.unmount()
    }
  })

  it('renders no banner when the fork point carries nothing to show', async () => {
    reportFork({ cutSeq: 0 })
    const rendered = await mountTranscript()
    try {
      expect(bannerOf(rendered.container), 'an empty seed renders no empty banner').toBeNull()
    } finally {
      rendered.unmount()
    }
  })

  it('keeps the banner out of the conversation rows', async () => {
    const plain = await mountTranscript()
    const baseline = mountedRows(plain.container).length
    plain.unmount()

    reportFork({ cutSeq: 0, user: { seq: 3, text: PARENT_QUESTION }, assistant: { seq: 4, text: PARENT_ANSWER } })
    const rendered = await mountTranscript()
    try {
      const banner = bannerOf(rendered.container) as HTMLElement
      expect(banner, 'the banner exists for this comparison').not.toBeNull()
      expect(banner.closest('[data-sidechat-transcript-row]'), 'the banner is not a transcript row').toBeNull()
      expect(
        banner.querySelector('[data-sidechat-transcript-row]'),
        'and contains none',
      ).toBeNull()
      expect(
        mountedRows(rendered.container).length,
        'it does not change how many rows mount',
      ).toBe(baseline)
    } finally {
      rendered.unmount()
    }
  })
})
