const {onSchedule} = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const {sendNotificationToUsers, getCompanyMemberIds} = require("../utils/notifications");
const {C} = require("../utils/paths");

/*
 * Nudges workers who owe an answer on an upcoming event.
 *
 * TWO DIFFERENT QUESTIONS, and which one someone is asked depends entirely on
 * whether they are on the crew yet:
 *
 *   NOT assigned, response still "pending"
 *       -> "can you work this?"  Confirm or decline. These are the events the
 *          availability screen lists, and answering is how a worker volunteers.
 *
 *   ASSIGNED, but has not acknowledged
 *       -> "you ARE working this — confirm you have seen it." There is no
 *          declining here and no way to object in the app: the shift is
 *          already theirs, and anyone who cannot work it takes it up with
 *          their manager directly.
 *
 * This function used to ask everyone the first question, so a worker already
 * scheduled on a shift was invited to decline availability for it — a reply
 * that no longer means anything once the crew is set.
 *
 * ONE notification per question per worker, covering every event of that kind.
 * A worker invited to six shifts gets one buzz, not six; someone with both
 * kinds outstanding gets two, because they are two different actions and
 * cannot be answered together.
 *
 * The company sets the cadence: `availabilityReminder.hours/minutes` is how
 * long to wait before nudging the same worker again. This function runs hourly
 * and does nothing for a worker whose last nudge is more recent than that, so
 * the schedule below is the RESOLUTION, not the frequency — a company asking
 * for every 6 hours gets every 6 hours, not every hour.
 */

/** The two questions, each with its own clock so neither suppresses the other. */
const AVAILABILITY = "availability";
const ACKNOWLEDGEMENT = "acknowledgement";

/** Most response documents one run will look at. */
const SCAN_LIMIT = 5000;

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

    /*
     * Every upcoming response, not just the pending ones.
     *
     * An assigned worker who confirmed their availability weeks ago has
     * `status: "confirmed"` and `acknowledgedAt: null` — they still owe the
     * second answer, and a status filter would never see them. dateKey alone
     * is a single-field index, which Firestore maintains automatically.
     */
    const responses = await admin.firestore()
      .collection(C.eventResponses)
      .where("dateKey", ">=", floor)
      .limit(SCAN_LIMIT)
      .get();

    if (responses.empty) {
      logger.log("No responses on upcoming events");
      return;
    }

    /*
     * Ordered by dateKey ascending, so hitting the cap drops the FURTHEST out
     * events — the ones least urgent to chase. Said out loud rather than left
     * to be inferred from a nudge that quietly stopped arriving.
     */
    if (responses.size === SCAN_LIMIT) {
      logger.warn(
        `Scan hit the ${SCAN_LIMIT} cap; events beyond the earliest ${SCAN_LIMIT} responses were not considered`
      );
    }

    // Assignment lives on the EVENT, so the events these responses point at
    // have to be read before anyone can be classified.
    const events = await loadEvents(
      [...new Set(responses.docs.map((doc) => doc.data().eventId).filter(Boolean))]
    );

    // companyId -> userId -> { availability: [{dateKey, eventId}], acknowledgement: [...] }
    const byCompany = new Map();
    let owed = 0;

    for (const doc of responses.docs) {
      const data = doc.data();
      const {companyId, userId, dateKey, eventId} = data;
      if (!companyId || !userId || !dateKey || !eventId) continue;

      const event = events.get(eventId);
      if (!event) continue;   // deleted out from under the response

      const assigned = (event.assignedUserIds || []).includes(userId);

      let question = null;
      if (assigned) {
        if (!data.acknowledgedAt) question = ACKNOWLEDGEMENT;
      } else if (data.status === "pending") {
        question = AVAILABILITY;
      }
      if (!question) continue;

      if (!byCompany.has(companyId)) byCompany.set(companyId, new Map());
      const byUser = byCompany.get(companyId);
      if (!byUser.has(userId)) {
        byUser.set(userId, {[AVAILABILITY]: [], [ACKNOWLEDGEMENT]: []});
      }
      byUser.get(userId)[question].push({dateKey, eventId});
      owed += 1;
    }

    logger.log(`${owed} unanswered of ${responses.size} upcoming, across ${byCompany.size} companies`);

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

  /*
   * One schedule per question, configured independently.
   *
   * A company can chase unanswered invitations daily and unconfirmed shifts
   * hourly, or either alone. Sharing one interval would have forced the more
   * urgent of the two down to the cadence of the less urgent.
   */
  const intervals = {
    [AVAILABILITY]: intervalFor(prefs.availabilityReminder),
    [ACKNOWLEDGEMENT]: intervalFor(prefs.acknowledgementReminder),
  };

  // The availability question only exists where the feature does.
  if (prefs.enableAvailability === false) intervals[AVAILABILITY] = 0;

  /*
   * AUTO-SILENCED when the company does not require acknowledgement.
   *
   * Nobody is being asked, so there is nothing to chase — and a reminder still
   * firing behind a switched-off requirement is how a setting starts lying
   * about what it does. Enforced here rather than trusting the settings screen
   * to have cleared the schedule.
   */
  if (prefs.requireAssignmentAcknowledgement === false) {
    intervals[ACKNOWLEDGEMENT] = 0;
  }

  if (!intervals[AVAILABILITY] && !intervals[ACKNOWLEDGEMENT]) return;

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

  for (const [userId, questions] of byUser) {
    if (!activeIds.has(userId)) continue;

    /*
     * One clock per question, on one document.
     *
     * A shared clock would let whichever nudge fired first suppress the other
     * for a whole interval — so a worker chased about availability would never
     * be asked to confirm the shift they were then given.
     */
    const stateRef = db.collection(C.availabilityNudges).doc(`${companyId}_${userId}`);
    const state = await stateRef.get();
    const stamps = state.exists ? state.data() : {};

    for (const question of [ACKNOWLEDGEMENT, AVAILABILITY]) {
      const upcoming = questions[question]
        .filter((item) => item.dateKey >= today)
        .sort((a, b) => a.dateKey.localeCompare(b.dateKey));
      if (upcoming.length === 0) continue;

      const intervalMs = intervals[question];
      if (!intervalMs) continue;

      const field = `lastNudgedAt_${question}`;
      const last = stamps[field] ? stamps[field].toMillis() : 0;
      if (now - last < intervalMs) continue;

      const count = upcoming.length;
      const soonest = upcoming[0];
      const when = humanDate(soonest.dateKey);

      /*
       * The clock is stamped BEFORE the send, deliberately.
       *
       * If the write lands and the send fails, this worker stays quiet until
       * the next interval. If the send landed first and the write failed, they
       * would be nudged again in an hour, and again the hour after that.
       * Silence for one interval is a smaller failure than a notification
       * loop — the whole point of this function is to not be annoying.
       */
      await stateRef.set({
        companyId,
        userId,
        [field]: admin.firestore.FieldValue.serverTimestamp(),
        [`pendingCount_${question}`]: count,
      }, {merge: true});

      const message = question === ACKNOWLEDGEMENT
        ? {
            title: "Confirm your shifts",
            body: count === 1
              ? `You are scheduled on ${when}. Confirm you have seen it.`
              : `You are scheduled on ${count} shifts, starting ${when}. Confirm you have seen them.`,
            type: "assignment_ack_nudge",
            screenName: "Details",
          }
        : {
            title: "Availability needed",
            body: count === 1
              ? `You have 1 event awaiting your reply, on ${when}.`
              : `You have ${count} events awaiting your reply, starting ${when}.`,
            type: "availability_nudge",
            screenName: "Availability",
          };

      await sendNotificationToUsers([userId], message.title, message.body, {
        companyId: companyId,
        screenName: message.screenName,
        type: message.type,
        pendingCount: String(count),
        soonestDateKey: soonest.dateKey,
        /*
         * The soonest shift, so an acknowledgement push opens the event with
         * the confirm button on it. There is no screen listing several
         * unconfirmed shifts — the Calendar tab badge covers the rest — so
         * landing on the next one is the most useful single destination.
         */
        eventId: soonest.eventId,
      });

      nudged++;
    }
  }

  if (nudged > 0) {
    logger.log(`Sent ${nudged} nudges in company ${companyId}`);
  }
}

/**
 * A reminder schedule as milliseconds, or 0 when it is not configured.
 *
 * Zero is deliberately NOT "remind every pass" — at the scheduler's hourly
 * cadence that would be once an hour forever, which is what an admin who left
 * the fields blank least wants.
 */
function intervalFor(schedule) {
  if (!schedule || schedule.enabled !== true) return 0;
  const ms = ((schedule.hours || 0) * 60 + (schedule.minutes || 0)) * 60 * 1000;
  return ms > 0 ? ms : 0;
}

/**
 * The events these responses belong to, keyed by id.
 *
 * Chunked at 100: one getAll of every upcoming event in every company is a
 * single slow round trip the whole run waits on.
 */
async function loadEvents(eventIds) {
  const db = admin.firestore();
  const byId = new Map();

  for (let i = 0; i < eventIds.length; i += 100) {
    const refs = eventIds.slice(i, i + 100).map((id) => db.collection(C.events).doc(id));
    const docs = await db.getAll(...refs);
    for (const doc of docs) {
      if (doc.exists) byId.set(doc.id, doc.data());
    }
  }

  return byId;
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
