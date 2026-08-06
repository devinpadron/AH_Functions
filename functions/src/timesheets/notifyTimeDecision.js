const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const {addToPendingNotifications} = require("../utils/notificationBatch");
const {C} = require("../utils/paths");
const moment = require("moment");

exports.notifyTimeDecision = onDocumentWritten({
  document: `${C.timeEntries}/{timesheetId}`,
}, async (event) => {
  try {
    // Get the timesheet ID from the path
    const timesheetId = event.params.timesheetId;

    // Get the data before and after the write
    const beforeData = event.data.before && event.data.before.data() ? event.data.before.data() : {};
    const afterData = event.data.after && event.data.after.data() ? event.data.after.data() : {};

    // If document was deleted, exit
    if (!event.data.after) {
      logger.log("Document was deleted, no notifications needed");
      return null;
    }

    // Check if status field has changed. `status` still carries approved /
    // rejected in v2; the new `review` object records WHO decided and how much
    // that attribution can be trusted, which this function does not use.
    if (beforeData.status === afterData.status) {
      logger.log("Status field has not changed, no notifications sent");
      return null;
    }

    const userId = afterData.userId;
    // companyId was a path wildcard in v1; in v2 it is a field on the document.
    const companyId = afterData.companyId;

    if (!companyId) {
      logger.warn(`Timesheet ${timesheetId} has no companyId, cannot send notification`);
      return null;
    }

    if (afterData.status === "approved" || afterData.status === "rejected") {
      const decision = afterData.status === "approved" ? "approval" : "rejection";
      logger.log(`Timesheet ${timesheetId} has been ${afterData.status}`);

      if (userId) {
        logger.log(`Adding ${decision} notification to batch for user ${userId}`);

        // v1: afterData.submittedAt (ISO string) -> v2: submission.submittedAt
        // (Firestore Timestamp).
        const submittedAt = afterData.submission && afterData.submission.submittedAt;
        const submittedAtDate = toDate(submittedAt);
        const formattedDate = submittedAtDate
          ? moment(submittedAtDate).format('MMM D, YYYY') // "May 16, 2025"
          : "Unknown date";

        // v1: duration (seconds) -> v2: workedSeconds
        const hours = ((afterData.workedSeconds || 0) / 3600).toFixed(2);

        // Add to pending notifications instead of sending immediately
        await addToPendingNotifications(userId, `timesheet_${decision}`, {
          timesheetId: timesheetId,
          userId: userId,
          companyId: companyId,
          rawdate: submittedAtDate ? submittedAtDate.toISOString() : "Unknown date",
          date: formattedDate,
          hours: hours || 0,
        });
      } else {
        logger.warn(`No user ID found for timesheet ${timesheetId}, cannot send notification`);
      }
    }

    logger.log(`Timesheet ${timesheetId} status changed from ${beforeData.status || 'new'} to ${afterData.status}`);

    return null;
  } catch (error) {
    logger.error("Error processing timesheet decision notification:", error);
    throw error;
  }
});

/** Firestore Timestamp, Date, or ISO string -> Date (or null). */
function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}
