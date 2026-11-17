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

/**
 * When managers should next hear about a task, or null for never.
 *
 * A VERBATIM PORT of `computeNextManagerAlertMs` from the same file in the app,
 * types removed. Same warning as above: both sides write `overdueAlertAt`.
 *
 * ONE clock carries up to three kinds of send, in order:
 *
 *   the warning   `warningSeconds` BEFORE the due time: "this is due soon and
 *                 nobody has done it". Skipped once the due time has passed.
 *   the alert     `alertSeconds` AFTER the due time.
 *   its repeats   one `repeatSeconds` gap after the last send, until done.
 *
 * `alertedMs` is the most recent send of ANY of them: nothing sent means start
 * at the top; a send earlier than the first overdue alert means that alert is
 * still owed; anything later means only repeats are left.
 */
function computeNextManagerAlertMs(input) {
  if (!input.hasPending) return null;

  const warningSeconds = Math.max(0, input.warningSeconds || 0);
  const repeatSeconds = Math.max(0, input.repeatSeconds || 0);
  const alertOn =
    input.alertSeconds !== null && input.alertSeconds !== undefined;
  const firstAlertMs = alertOn
    ? input.dueMs + Math.max(0, input.alertSeconds || 0) * 1000
    : null;

  let nextMs;
  if (input.alertedMs === null) {
    nextMs =
      warningSeconds > 0 && input.nowMs < input.dueMs
        ? input.dueMs - warningSeconds * 1000
        : firstAlertMs;
  } else if (firstAlertMs !== null && input.alertedMs < firstAlertMs) {
    nextMs = firstAlertMs;
  } else {
    nextMs =
      alertOn && repeatSeconds > 0
        ? input.alertedMs + repeatSeconds * 1000
        : null;
  }

  // Anything that could only fire after expiry is not scheduled at all.
  return nextMs !== null && nextMs <= input.expiresMs ? nextMs : null;
}

module.exports = {
  anchorMs,
  repeatGapSeconds,
  computeNextReminderMs,
  computeNextManagerAlertMs,
};
