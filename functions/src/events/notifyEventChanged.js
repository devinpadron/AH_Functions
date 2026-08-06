const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const {sendNotificationToUsers} = require("../utils/notifications");
const {C} = require("../utils/paths");

/*
 * Fields watched for changes.
 *
 * `report` is the name that goes into the `changedFields` payload string. The
 * v1 NAMES are kept deliberately: `changedFields` is part of the FCM payload
 * the app receives, and the app ships separately from this repo.
 */
const WATCHED_FIELDS = [
  {v2: "title",           report: "title"},
  {v2: "dateKey",         report: "date"},
  {v2: "locations",       report: "locations"},
  {v2: "startAt",         report: "startTime"},
  {v2: "endAt",           report: "endTime"},
  {v2: "adminNotes",      report: "notes"},
  {v2: "assignedUserIds", report: "assignedWorkers"},
];

exports.notifyEventChanged = onDocumentWritten({
  document: `${C.events}/{eventId}`,
}, async (event) => {
  try {
    // Get the event ID from the path
    const eventId = event.params.eventId;

    // Get the data before and after the write
    const beforeData = event.data.before && event.data.before.data() ? event.data.before.data() : {};
    const afterData = event.data.after && event.data.after.data() ? event.data.after.data() : {};

    // If document was deleted, exit
    if (!event.data.after) {
      logger.log("Document was deleted, no notifications needed");
      return null;
    }

    // companyId was a path wildcard in v1; in v2 it is a field on the document.
    const companyId = afterData.companyId;
    if (!companyId) {
      logger.warn(`Event ${eventId} has no companyId, cannot send notifications`);
      return null;
    }

    // Check if any significant fields have changed
    const changedFields = WATCHED_FIELDS
      .filter(({v2}) => !valuesEqual(beforeData[v2], afterData[v2]))
      .map(({report}) => report);

    // If no significant changes, exit
    if (changedFields.length === 0) {
      logger.log("No significant changes detected, no notifications sent");
      return null;
    }

    logger.log(`Event ${eventId} changed fields: ${changedFields.join(", ")}`);

    // Get workers who were assigned both before and after the change
    const beforeWorkers = Array.isArray(beforeData.assignedUserIds) ? beforeData.assignedUserIds : [];
    const afterWorkers = Array.isArray(afterData.assignedUserIds) ? afterData.assignedUserIds : [];

    // Find the intersection - workers who were assigned both before and after
    const persistentWorkers = afterWorkers.filter(workerId =>
      beforeWorkers.includes(workerId)
    );

    if (persistentWorkers.length > 0) {
      logger.log(`Sending notifications to ${persistentWorkers.length} workers who remained assigned for event: ${eventId}`);

      // Send notifications to workers who were assigned both before and after
      await sendNotificationToUsers(persistentWorkers,
          "Event Updated",
          `The event "${beforeData.title || "Unnamed Event"}" has been updated. Check the details.`,
          {
              eventId: eventId,
              screenName: "Details",
              companyId: companyId,
              type: "update",
              changedFields: changedFields.join(",")
          }
      );
    } else {
      logger.log("No persistent workers found for this event change");
    }
  } catch (error) {
    logger.error("Error processing event change notification:", error);
    throw error; // Re-throw to ensure the function fails if there's an error
  }
  return null; // Return null to indicate successful completion
});

/*
 * Structural equality for the field values that appear on an event.
 *
 * v1 compared `locations` with `!==`, which compares object identity. Firestore
 * hands back a freshly built object on every read, so that test was true on
 * every single write and "locations" was reported as changed every time — it is
 * in every notifyEventChanged log line in production. It only escaped notice
 * because the events that triggered it happened to have no persistent workers.
 *
 * Timestamps (startAt / endAt) have the same problem and gain an isEqual().
 */
function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;

  // Firestore Timestamp / GeoPoint / DocumentReference
  if (typeof a.isEqual === "function") return a.isEqual(b);

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, i) => valuesEqual(item, b[i]));
  }

  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(key =>
      Object.prototype.hasOwnProperty.call(b, key) && valuesEqual(a[key], b[key])
    );
  }

  return false;
}
