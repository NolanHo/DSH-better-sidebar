/**
 * Side-chat composer keymap: which gesture submits a message, and the IME
 * guard that outranks it.
 *
 * The submission contract has two modes, picked by the user in the side card
 * settings page and carried into the view as `submitKey`:
 *
 * - `'enter'` (the default): a plain `Enter` submits and the gesture is
 *   CONSUMED (no newline). `Shift+Enter` never submits and keeps the
 *   textarea's native line break.
 * - `'mod-enter'`: exactly `Cmd+Enter` or `Ctrl+Enter` submits; a bare
 *   `Enter` and `Shift+Enter` insert a newline and are NOT consumed.
 *
 * The IME guard follows the host's own composer keymap
 * (`packages/client/ui-conversation/src/client/input/editor/keymap.ts`): a
 * keydown that belongs to a composition must never submit, and the guard wins
 * over a submit chord. Three signals make that decision:
 *
 * - `KeyboardEvent.isComposing` — most engines;
 * - the legacy `keyCode === 229`, which some engines report with
 *   `isComposing === false` while an IME owns the keyboard;
 * - a {@link COMPOSITION_END_GRACE_MS} window after `compositionend`: Safari
 *   delivers the composition-closing keydown AFTER compositionend, so the
 *   state flag is already false by the time the Enter arrives (the host's
 *   "old textarea's proven window", same 10 ms).
 *
 * The decisions are pure functions taking the clock as a parameter, so the
 * behavior is pinned without a DOM:
 * {@link isComposingKeydown} / {@link isSubmitGesture}. The vocabulary (the
 * modes and their parser) lives with the other preference vocabulary in
 * `prefs-shared.ts`, because the stored value is a preference.
 */
import type { SidechatSubmitKey } from '../prefs-shared.ts'

/** How long after `compositionend` a keydown still belongs to the IME. */
export const COMPOSITION_END_GRACE_MS = 10

/** The key-event fields the decisions read (the view feeds the native event's
 *  `isComposing` / `keyCode` beside React's modifier flags). */
export interface ComposerKeyEvent {
  /** The key name (`'Enter'`). */
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  /** The engine's composition flag (absent on events that do not carry it). */
  isComposing?: boolean
  /** The legacy IME key code (229 while an engine hides its composition). */
  keyCode?: number
}

/**
 * Whether this keydown belongs to an IME composition and must therefore be
 * left entirely to the input method.
 * @param event - the keydown's fields.
 * @param composing - whether a composition is LIVE right now (tracked from
 *   `compositionstart` / `compositionend`; some engines only signal it there).
 * @param composingUntil - the deadline of the composition-end grace window
 *   (`Date.now()` basis, 0 when no composition ever ended).
 * @param now - the current time (injectable for deterministic tests).
 * @returns true while a composition owns the keyboard.
 */
export function isComposingKeydown(
  event: ComposerKeyEvent,
  composing: boolean,
  composingUntil: number,
  now: number = Date.now(),
): boolean {
  if (event.isComposing === true) return true
  // keyCode 229 is the legacy signal engines emit without isComposing.
  // oxlint-disable-next-line typescript/no-deprecated
  if (event.keyCode === 229) return true
  if (composing) return true
  return now < composingUntil
}

/**
 * Whether this keydown should submit the draft under the configured mode.
 * The IME guard is checked FIRST: a composition key is never a submit
 * gesture, not even as a `Cmd/Ctrl+Enter` chord.
 * @param event - the keydown's fields.
 * @param submitKey - the configured submission mode.
 * @param composing - whether a composition is LIVE right now.
 * @param composingUntil - the composition-end grace deadline (see above).
 * @param now - the current time (injectable for deterministic tests).
 * @returns true when the gesture submits (the caller consumes it).
 */
export function isSubmitGesture(
  event: ComposerKeyEvent,
  submitKey: SidechatSubmitKey,
  composing: boolean,
  composingUntil: number,
  now: number = Date.now(),
): boolean {
  if (event.key !== 'Enter') return false
  if (isComposingKeydown(event, composing, composingUntil, now)) return false
  // Shift+Enter NEVER submits: it is the newline gesture in both modes.
  if (event.shiftKey) return false
  if (submitKey === 'mod-enter') return event.metaKey || event.ctrlKey
  return true
}
