const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const {sendNotificationToUsers, getCompanyMemberIds} = require("../utils/notifications");
const {ADMIN_ROLES} = require("../utils/audience");
const {computeNextReminderMs, computeNextManagerAlertMs} = require("../utils/taskSchedule");
const {C} = require("../utils/paths");

/*
 * Chases event tasks: things a manager asked someone on an event to do and
 * confirm — "final call with the client", "return the van keys".
 *
 * TWO PUSHES, to two different audiences:
 *
 *   task_reminder  to each worker who still owes a task, when one of the
 *                  task's reminder rules falls due.
 *   task_overdue   to managers, about a task nobody has done: a WARNING
 *                  `dueWarningSeconds` before it is due, an ALERT
 *                  `overdueAlertSeconds` after, and repeats of the alert every
 *                  `overdueAlertRepeatSeconds`. All three ride one clock,
 *                  `overdueAlertAt`, and one push type — the wording is chosen
 *                  here from whether the due time has passed. WHICH managers
 *                  is `overdueAlertUserIds` (empty means all of them).
 *
 * The clients do the scheduling. Every `eventTasks` document carries a
 * materialized `nextReminderAt` and `overdueAlertAt`, written by the app when
 * an event is saved, so this function never works out what is due — it asks
 * Firestore for the documents whose time has come. That is two bounded
 * single-field queries per run, however many companies and events exist.
 *
 * What this function owns is what happens AFTER a send: `lastRemindedAt`, and
 * moving `nextReminderAt` on to the rule's next occurrence. See taskSchedule.js
 * for why that arithmetic has to match the app's exactly.
 *
 * ONE reminder per worker per run, covering every task of theirs that fell
 * due — the same rule nudgePendingResponses follows. Three tasks due in the
 * same hour is one buzz that opens the soonest.
 */

/** Most task documents one run will act on, per query. */
const SCAN_LIMIT = 500;

/** Firestore caps a batch at 500 writes. */
const BATCH_SIZE = 400;

/*
 * No pushes between these local hours.
 *
 * Reminder rules are relative to the event, so "2 hours after it ends" on a
 * wedding that finishes at midnight is a push at 2 a.m. unless something stops
 * it. A document that falls due in the quiet window is LEFT ALONE — its
 * `nextReminderAt` stays in the past — so the first run after QUIET_UNTIL_HOUR
 * picks it up. Nothing is dropped, only delayed.
 */
const QUIET_FROM_HOUR = 21;
const QUIET_UNTIL_HOUR = 7;

/** Used when a company has no `timeZone`. Matches the app's fallback. */
const FALLBACK_TIME_ZONE = "America/New_York";

exports.remindEventTasks = onSchedule({
  schedule: "every 60 minutes",
  timeZone: "America/New_York",
}, async () => {
  try {
    const db = admin.firestore();
    const now = Date.now();
    const nowStamp = admin.firestore.Timestamp.fromMillis(now);

    /*
     * `<=` on a nullable field never matches null, so a settled or spent task
     * — whose field the client nulled — is simply not in the result.
     */
    const [due, alerts] = await Promise.all([
      db.collection(C.eventTasks)
        .where("nextReminderAt", "<=", nowStamp)
        .limit(SCAN_LIMIT)
        .get(),
      db.collection(C.eventTasks)
        .where("overdueAlertAt", "<=", nowStamp)
        .limit(SCAN_LIMIT)
        .get(),
    ]);

    if (due.empty && alerts.empty) {
      logger.log("No event tasks due");
      return;
    }

    for (const [name, snapshot] of [["reminder", due], ["overdue alert", alerts]]) {
      if (snapshot.size === SCAN_LIMIT) {
        // Ordered by the timestamp ascending, so the cap defers the most
        // recently due; the next run takes them.
        logger.warn(`Event task ${name} scan hit the ${SCAN_LIMIT} cap`);
      }
    }

    // companyId -> {reminders: [doc], alerts: [doc]}
    const byCompany = new Map();
    const bucket = (companyId) => {
      if (!byCompany.has(companyId)) {
        byCompany.set(companyId, {reminders: [], alerts: []});
      }
      return byCompany.get(companyId);
    };

    for (const doc of due.docs) {
      const companyId = doc.data().companyId;
      if (companyId) bucket(companyId).reminders.push(doc);
    }
    for (const doc of alerts.docs) {
      const companyId = doc.data().companyId;
      if (companyId) bucket(companyId).alerts.push(doc);
    }

    for (const [companyId, work] of byCompany) {
      try {
        await processCompany(companyId, work, now);
      } catch (error) {
        // One misconfigured company must not stop the rest of the run.
        logger.error(`Error chasing event tasks for company ${companyId}:`, error);
      }
    }
  } catch (error) {
    logger.error("Error in remindEventTasks function:", error);
  }
});

async function processCompany(companyId, work, now) {
  const db = admin.firestore();
  const nowStamp = admin.firestore.Timestamp.fromMillis(now);

  const [prefsDoc, companyDoc] = await Promise.all([
    db.collection(C.companyPreferences).doc(companyId).get(),
    db.collection(C.companies).doc(companyId).get(),
  ]);

  const writes = [];   // [ref, patch]

  /*
   * The feature switched off — or never switched on.
   *
   * `enableEventTasks` is the company saying "do not ask". Both timestamps are
   * cleared so these documents stop matching the query every hour; nothing
   * else on the task is touched, and the app re-derives the schedule the next
   * time the event is saved, so switching the feature back on loses nothing.
   *
   * Fails CLOSED on a missing preferences document, like the other scheduled
   * functions: a company that has never opened settings gets no pushes.
   */
  const enabled = prefsDoc.exists && prefsDoc.data().enableEventTasks === true;
  if (!enabled) {
    for (const doc of work.reminders) writes.push([doc.ref, {nextReminderAt: null}]);
    for (const doc of work.alerts) writes.push([doc.ref, {overdueAlertAt: null}]);
    await commit(writes);
    logger.log(`Event tasks are off for company ${companyId}; cleared ${writes.length} schedules`);
    return;
  }

  const timeZone = (companyDoc.exists && companyDoc.data().timeZone) || FALLBACK_TIME_ZONE;
  const quiet = isQuietHour(timeZone);

  // userId -> [task]
  const byUser = new Map();

  for (const doc of work.reminders) {
    const task = doc.data();
    const pending = (task.pendingUserIds || []).filter(Boolean);
    const expiresMs = task.expiresAt ? task.expiresAt.toMillis() : null;

    /*
     * Nobody left to remind, or past the cut-off: clear the field and send
     * nothing. This is the ONE place a settled task's schedule is guaranteed
     * to be cleared — two workers finishing an "everyone" task offline each
     * see the other still pending, so neither client nulls it.
     *
     * Done even in quiet hours, since it sends nothing.
     */
    if (pending.length === 0 || (expiresMs !== null && now > expiresMs)) {
      writes.push([doc.ref, {nextReminderAt: null}]);
      continue;
    }

    if (quiet) continue;

    const startMs = task.eventStartAt ? task.eventStartAt.toMillis() : now;
    const endMs = task.eventEndAt ? task.eventEndAt.toMillis() : startMs;

    const nextMs = computeNextReminderMs({
      rules: task.reminders || [],
      startMs,
      endMs,
      lastRemindedMs: now,   // the send that is about to happen
      nowMs: now,
      // No expiry recorded: the app always writes one, but a week past the
      // event is its rule and a safer default than "never".
      expiresMs: expiresMs !== null ? expiresMs : endMs + 7 * 24 * 3600 * 1000,
      hasPending: true,
    });

    writes.push([doc.ref, {
      lastRemindedAt: nowStamp,
      nextReminderAt: nextMs === null ? null : admin.firestore.Timestamp.fromMillis(nextMs),
    }]);

    for (const userId of pending) {
      if (!byUser.has(userId)) byUser.set(userId, []);
      byUser.get(userId).push({...task, id: doc.id});
    }
  }

  const overdue = [];

  for (const doc of work.alerts) {
    const task = doc.data();
    const pending = (task.pendingUserIds || []).filter(Boolean);
    const expired = task.expiresAt && now > task.expiresAt.toMillis();

    if (pending.length === 0 || expired) {
      writes.push([doc.ref, {overdueAlertAt: null}]);
      continue;
    }

    if (quiet) continue;

    /*
     * Moved on or cleared whatever happens next, for the reason the reminder
     * clock is: a failed send must not leave the document due again in an hour.
     *
     * The app runs this same function, with `overdueAlertedAt` where this
     * passes `now`, when the event is next saved or the task reopened.
     */
    const taskDueMs = task.dueAt ? task.dueAt.toMillis() : now;
    const taskEndMs = task.eventEndAt ? task.eventEndAt.toMillis() : taskDueMs;
    const nextAlertMs = computeNextManagerAlertMs({
      dueMs: taskDueMs,
      warningSeconds: task.dueWarningSeconds,
      alertSeconds: task.overdueAlertSeconds,
      repeatSeconds: task.overdueAlertRepeatSeconds,
      alertedMs: now,   // the send that is about to happen
      nowMs: now,
      expiresMs: task.expiresAt ? task.expiresAt.toMillis() : taskEndMs + 7 * 24 * 3600 * 1000,
      hasPending: true,
    });

    writes.push([doc.ref, {
      overdueAlertAt: nextAlertMs === null ? null : admin.firestore.Timestamp.fromMillis(nextAlertMs),
      overdueAlertedAt: nowStamp,
    }]);
    overdue.push({...task, id: doc.id});
  }

  /*
   * The clocks are stamped BEFORE the sends, deliberately — the same choice
   * nudgePendingResponses makes, for the same reason.
   *
   * If the write lands and a send fails, that worker misses one reminder and
   * the next rule or repeat still fires. If the sends went first and the write
   * failed, every one of these tasks would still be due an hour later, and the
   * hour after that. One missed reminder is a smaller failure than a loop.
   */
  await commit(writes);

  if (quiet) {
    logger.log(`Quiet hours in ${timeZone}; company ${companyId} deferred`);
    return;
  }

  if (byUser.size > 0) {
    // A worker who has left keeps their place in `pendingUserIds` until the
    // event is next saved. Being chased by a company you left is worse than
    // silence.
    const activeIds = new Set(await getCompanyMemberIds(companyId));
    let reminded = 0;

    for (const [userId, tasks] of byUser) {
      if (!activeIds.has(userId)) continue;

      tasks.sort((a, b) => dueMs(a) - dueMs(b));
      const soonest = tasks[0];
      const count = tasks.length;

      await sendNotificationToUsers(
        [userId],
        count === 1 ? "Task to do" : "Tasks to do",
        count === 1
          ? `${quote(soonest.title)} for ${soonest.eventTitle || "your event"} — ${dueLabel(soonest, now, timeZone)}.`
          : `You have ${count} tasks to do, starting with ${quote(soonest.title)} for ${soonest.eventTitle || "your event"}.`,
        {
          companyId: companyId,
          screenName: "Details",
          type: "task_reminder",
          pendingCount: String(count),
          // The event the soonest task is on. The task is ticked from the
          // event screen, so that is the one useful place to land.
          eventId: soonest.eventId,
        }
      );
      reminded++;
    }

    if (reminded > 0) {
      logger.log(`Sent ${reminded} task reminders in company ${companyId}`);
    }
  }

  if (overdue.length > 0) {
    const managerIds = await getCompanyMemberIds(companyId, ADMIN_ROLES);
    const byManager = overdueByManager(overdue, managerIds);

    /*
     * One push per manager per KIND for the whole run, not one per task: a
     * morning where five tasks slipped overnight should not be five buzzes.
     *
     * "Due soon" and "overdue" are kept apart because they ask for different
     * things — one can still be rescued — and a single push could only word
     * one of them. Which a task is, is simply whether its due time has passed:
     * a warning held back by quiet hours until after the deadline is, by then,
     * an overdue alert and says so.
     */
    for (const [managerId, tasks] of byManager) {
      tasks.sort((a, b) => dueMs(a) - dueMs(b));
      const late = tasks.filter((task) => !task.dueAt || dueMs(task) <= now);
      const soon = tasks.filter((task) => task.dueAt && dueMs(task) > now);

      if (late.length > 0) {
        const first = late[0];
        const count = late.length;
        await sendNotificationToUsers(
          [managerId],
          count === 1 ? "Task overdue" : "Tasks overdue",
          count === 1
            ? `${quote(first.title)} for ${first.eventTitle || "an event"} is still not done.`
            : `${count} event tasks are past due, starting with ${quote(first.title)} for ${first.eventTitle || "an event"}.`,
          {
            companyId: companyId,
            screenName: "Details",
            type: "task_overdue",
            pendingCount: String(count),
            eventId: first.eventId,
          }
        );
      }

      if (soon.length > 0) {
        const first = soon[0];
        const count = soon.length;
        await sendNotificationToUsers(
          [managerId],
          count === 1 ? "Task due soon" : "Tasks due soon",
          count === 1
            ? `${quote(first.title)} for ${first.eventTitle || "an event"} is not done yet — ${dueLabel(first, now, timeZone)}.`
            : `${count} event tasks are due soon and not done, starting with ${quote(first.title)} for ${first.eventTitle || "an event"}.`,
          {
            companyId: companyId,
            screenName: "Details",
            // Deliberately the same type as the overdue alert: the payload
            // contract is frozen, and one mute switch covering "tasks nobody
            // has done" is what a manager would expect anyway.
            type: "task_overdue",
            pendingCount: String(count),
            eventId: first.eventId,
          }
        );
      }
    }

    logger.log(`Alerted ${byManager.size} managers to ${overdue.length} overdue tasks in company ${companyId}`);
  }
}

/**
 * Who hears about which overdue task: managerId -> [task].
 *
 * A task's `overdueAlertUserIds` names its recipients. They are only ever
 * honoured as a NARROWING of the company's active managers and owners —
 * someone named who has since left, or been made a worker, gets nothing, so
 * the field can never address a push to a person the rules would not let read
 * the task's event.
 *
 * Falls back to every manager when the list is empty or absent (the default,
 * and every task written before the field existed) AND when nobody named is
 * still a manager. An alert the company asked for reaching the wrong manager
 * is a smaller failure than it reaching nobody.
 */
function overdueByManager(tasks, managerIds) {
  const managers = new Set(managerIds);
  const byManager = new Map();

  for (const task of tasks) {
    const named = (task.overdueAlertUserIds || []).filter((id) => managers.has(id));
    const recipients = named.length > 0 ? named : managerIds;

    for (const managerId of recipients) {
      if (!byManager.has(managerId)) byManager.set(managerId, []);
      byManager.get(managerId).push(task);
    }
  }

  return byManager;
}

/** Applies [ref, patch] pairs in batches. */
async function commit(writes) {
  const db = admin.firestore();
  for (let i = 0; i < writes.length; i += BATCH_SIZE) {
    const batch = db.batch();
    for (const [ref, patch] of writes.slice(i, i + BATCH_SIZE)) {
      batch.update(ref, patch);
    }
    await batch.commit();
  }
}

const dueMs = (task) => (task.dueAt ? task.dueAt.toMillis() : 0);

const quote = (title) => `"${title || "A task"}"`;

/** The hour (0–23) it is now in a company's zone. */
function hourInZone(timeZone) {
  try {
    return Number(new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date()));
  } catch (error) {
    // An unrecognized zone string. Not quiet: a reminder at an awkward hour
    // is a smaller failure than a company that is never reminded at all.
    return null;
  }
}

function isQuietHour(timeZone) {
  const hour = hourInZone(timeZone);
  if (hour === null) return false;
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

/** "due Fri 3:00 PM" or "was due Fri 3:00 PM", in the company's own time. */
function dueLabel(task, now, timeZone) {
  if (!task.dueAt) return "still to do";
  const due = task.dueAt.toDate();
  let when;
  try {
    when = due.toLocaleString("en-US", {
      timeZone,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch (error) {
    when = due.toISOString().slice(0, 10);
  }
  return due.getTime() < now ? `was due ${when}` : `due ${when}`;
}

// Exported for tests, not for callers.
exports._internal = {processCompany, isQuietHour, dueLabel, overdueByManager};
