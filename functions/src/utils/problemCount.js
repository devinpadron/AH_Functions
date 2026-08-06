const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const {C} = require("./paths");

/**
 * Recomputes events/{eventId}.problemCount from the response documents.
 *
 * RECOMPUTED, not incremented. An increment is one lost write away from a
 * calendar that permanently claims a job is short when it is not, and nothing
 * would ever correct it. Counting is one extra query on an action that happens
 * a handful of times a week, which is a cheap price for a number that cannot
 * drift.
 *
 * Only flags from people still ON the crew count. Someone unassigned after
 * flagging is no longer a shortfall — the manager already dealt with it.
 */
async function syncProblemCount(companyId, eventId) {
  try {
    const db = admin.firestore();
    const eventRef = db.collection(C.events).doc(eventId);

    const [eventDoc, responses] = await Promise.all([
      eventRef.get(),
      db.collection(C.eventResponses)
        .where("companyId", "==", companyId)
        .where("eventId", "==", eventId)
        .limit(300)
        .get(),
    ]);

    if (!eventDoc.exists) return;
    const assigned = new Set(eventDoc.data().assignedUserIds || []);

    const problemCount = responses.docs.filter((doc) => {
      const data = doc.data();
      return data.problemFlaggedAt && assigned.has(data.userId);
    }).length;

    if ((eventDoc.data().problemCount || 0) === problemCount) return;

    await eventRef.update({problemCount});
    logger.log(`Event ${eventId} problemCount is now ${problemCount}`);
  } catch (error) {
    // A failed tally must not swallow the notification that goes with it.
    logger.error(`Error syncing problemCount for event ${eventId}:`, error);
  }
}

module.exports = {syncProblemCount};
