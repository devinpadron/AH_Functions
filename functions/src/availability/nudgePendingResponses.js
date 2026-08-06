const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const {sendNotificationToUsers, getCompanyMemberIds} = require("../utils/notifications");
const {C} = require("../utils/paths");

/*
 * Nudges workers who still have "pending" on upcoming events.
 *
 * ONE notification per worker, covering every event they owe an answer on —
 * not one per event. A worker invited to six shifts in a week would otherwise
 * get six identical buzzes, learn to ignore them, and answer none.
 *
 * The company sets the cadence: `availabilityReminder.hours/minutes` is how
 * long to wait before nudging the same worker again. This function runs hourly
 * and does nothing for a worker whose last nudge is more recent than that, so
 * the schedule below is the RESOLUTION, not the frequency — a company asking
 * for every 6 hours gets every 6 hours, not every hour.
 */

exports.nudgePendingResponses = onSchedule({
  schedule: "every 60 minutes",
  timeZone: "America/New_York",
}, async () => {
  try {
    /*
     * One query for the whole run, rather than one per company.
     *
     * The floor is yesterday in UTC, which is at or before "today" in every
     * timezone on earth. Each company then trims to its OWN today below — a
     * UTC floor alone would drop tonight's events for a US company after
     * 19:00 local, which is exactly when a reminder matters most.
     */
    const floor = dayKeyUTC(-1);

    const pending = await admin.firestore()
      .collection(C.eventResponses)
      .where("status", "==", "pending")
      .where("dateKey", ">=", floor)
      .limit(5000)
      .get();

    if (pending.empty) {
      logger.log("No pending responses on upcoming events");
      return;
    }

    // companyId -> userId -> [dateKey]
    const byCompany = new Map();
    for (const doc of pending.docs) {
      const {companyId, userId, dateKey} = doc.data();
      if (!companyId || !userId || !dateKey) continue;

      if (!byCompany.has(companyId)) byCompany.set(companyId, new Map());
      const byUser = byCompany.get(companyId);
      if (!byUser.has(userId)) byUser.set(userId, []);
      byUser.get(userId).push(dateKey);
    }

    logger.log(`${pending.size} pending responses across ${byCompany.size} companies`);

    for (const [companyId, byUser] of byCompany) {
      try {
        await nudgeCompany(companyId, byUser);
      } catch (error) {
        // One misconfigured company must not stop the rest of the run.
        logger.error(`Error nudging company ${companyId}:`, error);
      }
    }
  } catch (error) {
    logger.error("Error in nudgePendingResponses function:", error);
  }
});

async function nudgeCompany(companyId, byUser) {
  const db = admin.firestore();

  const [prefsDoc, companyDoc] = await Promise.all([
    db.collection(C.companyPreferences).doc(companyId).get(),
    db.collection(C.companies).doc(companyId).get(),
  ]);

  /*
   * Fails CLOSED on a missing preferences document, matching
   * notifyNewEventWithoutAssignees: a company that has never opened settings
   * gets no unsolicited pushes.
   */
  if (!prefsDoc.exists) {
    logger.log(`No preferences for company ${companyId}, skipping`);
    return;
  }

  const prefs = prefsDoc.data();
  if (prefs.enableAvailability === false) return;

  const reminder = prefs.availabilityReminder || {};
  if (reminder.enabled !== true) return;

  const intervalMs = ((reminder.hours || 0) * 60 + (reminder.minutes || 0)) * 60 * 1000;
  if (intervalMs <= 0) {
    // Zero would mean "nudge every time this runs", which is once an hour,
    // forever. Treated as unconfigured rather than as consent to spam.
    logger.log(`Company ${companyId} has a zero reminder interval, skipping`);
    return;
  }

  /*
   * Trim to the company's own today.
   *
   * `dateKey` is the event's LOCAL day, so comparing it to anything but the
   * company's local today is an off-by-one waiting to happen.
   */
  const today = dayKeyInZone(companyDoc.exists ? companyDoc.data().timeZone : null);

  // Only active members. A removed worker keeps their response documents, and
  // being chased for shifts at a company you have left is worse than silence.
  const activeIds = new Set(await getCompanyMemberIds(companyId));

  const now = Date.now();
  let nudged = 0;

  for (const [userId, dateKeys] of byUser) {
    if (!activeIds.has(userId)) continue;

    const upcoming = dateKeys.filter((key) => key >= today);
    if (upcoming.length === 0) continue;

    const stateRef = db.collection(C.availabilityNudges).doc(`${companyId}_${userId}`);
    const state = await stateRef.get();
    const lastNudgedAt = state.exists && state.data().lastNudgedAt
      ? state.data().lastNudgedAt.toMillis()
      : 0;

    if (now - lastNudgedAt < intervalMs) continue;

    upcoming.sort();
    const count = upcoming.length;

    /*
     * The clock is stamped BEFORE the send, deliberately.
     *
     * If the write lands and the send fails, this worker stays quiet until the
     * next interval. If the send landed first and the write failed, they would
     * be nudged again in an hour, and again the hour after that. Silence for
     * one interval is a smaller failure than a notification loop — the whole
     * point of this function is to not be annoying.
     */
    await stateRef.set({
      companyId,
      userId,
      pendingCount: count,
      lastNudgedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, {merge: true});

    await sendNotificationToUsers([userId],
      "Availability needed",
      count === 1
        ? `You have 1 event awaiting your reply, on ${humanDate(upcoming[0])}.`
        : `You have ${count} events awaiting your reply, starting ${humanDate(upcoming[0])}.`,
      {
        companyId: companyId,
        screenName: "Availability",
        type: "availability_nudge",
        pendingCount: String(count),
        soonestDateKey: upcoming[0],
      }
    );

    nudged++;
  }

  if (nudged > 0) {
    logger.log(`Nudged ${nudged} workers in company ${companyId}`);
  }
}

/** "YYYY-MM-DD" for today in UTC, offset by whole days. */
function dayKeyUTC(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * "YYYY-MM-DD" for today in an IANA zone.
 *
 * `en-CA` formats as YYYY-MM-DD, which is the same shape `dateKey` is written
 * in — so the two can be compared as strings without parsing either.
 */
function dayKeyInZone(timeZone) {
  if (!timeZone) return dayKeyUTC(0);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch (error) {
    // An unrecognised zone must not take the whole company's nudges down.
    logger.warn(`Unknown timeZone "${timeZone}", falling back to UTC`);
    return dayKeyUTC(0);
  }
}

/** "2026-03-12" -> "Mar 12". Parsed as UTC so the label cannot shift a day. */
function humanDate(dateKey) {
  const parsed = new Date(`${dateKey}T00:00:00Z`);
  if (isNaN(parsed.getTime())) return dateKey;
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
