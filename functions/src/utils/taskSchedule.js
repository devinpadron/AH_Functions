/*
 * When an event task's next reminder is due.
 *
 * A VERBATIM PORT of `computeNextReminderMs`, `anchorMs` and `repeatGapSeconds`
 * from src/utils/eventTaskUtils.ts in the AntHill app, with the types removed
 * and nothing else changed.
 *
 * The app runs its copy whenever an event is saved or a task is reopened; this
 * one runs after every send. Both write the same field, `nextReminderAt`, so if
 * they disagree a reminder is either sent twice or never. Change one and the
 * other must follow — there is no shared package to enforce it.
 *
 * Plain arithmetic on epoch milliseconds: no Firestore, no clock of its own.
 */

/** The instant a rule or due time is measured from. */
const anchorMs = (anchor, anchors) =>
  anchor === "eventEnd" ? anchors.endMs : anchors.startMs;

/** Zero when the schedule is off or unconfigured — i.e. "does not repeat". */
function repeatGapSeconds(repeat) {
  if (!repeat || !repeat.enabled) return 0;
  return Math.max(0, (repeat.hours || 0) * 3600 + (repeat.minutes || 0) * 60);
}

/**
 * When the next reminder should go out, or null for never.
 *
 * Per rule:
 *   - not yet fired (nothing sent since its first time): its first time, or
 *     NOW if that has already passed.
 *   - fired and repeating: one gap after the last send.
 *   - fired and not repeating: spent.
 *
 * The earliest candidate across rules wins. `lastRemindedMs` is one value for
 * the whole task, not per rule, so two rules that fall due together produce
 * one push, not two.
 *
 * @param {Object} input
 * @param {Object[]} input.rules - the task's `reminders`
 * @param {number} input.startMs - `eventStartAt`
 * @param {number} input.endMs - `eventEndAt`
 * @param {number|null} input.lastRemindedMs
 * @param {number} input.nowMs
 * @param {number} input.expiresMs - `expiresAt`
 * @param {boolean} input.hasPending
 * @returns {number|null}
 */
function computeNextReminderMs(input) {
  if (!input.hasPending) return null;

  let best = null;

  for (const rule of input.rules || []) {
    const first = anchorMs(rule.anchor, input) + rule.offsetSeconds * 1000;
    const gap = repeatGapSeconds(rule.repeat) * 1000;

    let candidate;
    if (input.lastRemindedMs === null || input.lastRemindedMs < first) {
      candidate = Math.max(first, input.nowMs);
    } else if (gap > 0) {
      candidate = Math.max(input.lastRemindedMs + gap, input.nowMs);
    } else {
      continue;
    }

    if (candidate > input.expiresMs) continue;
    if (best === null || candidate < best) best = candidate;
  }

  return best;
}

module.exports = {anchorMs, repeatGapSeconds, computeNextReminderMs};
