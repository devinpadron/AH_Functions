const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const {addToPendingNotifications} = require("../utils/notificationBatch");
const moment = require("moment");

exports.notifyTimeDecision = onDocumentWritten({
  document: "Companies/{companyId}/TimeEntries/{timesheetId}",
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
    
    // Check if status field has changed
    if (beforeData.status === afterData.status) {
      logger.log("Status field has not changed, no notifications sent");
      return null;
    }

    const userId = afterData.userId;

    if (afterData.status === "approved") {
      logger.log(`Timesheet ${timesheetId} has been approved`);
      if (userId) {
        logger.log(`Adding approval notification to batch for user ${userId}`);
        const formattedDate = moment(afterData.submittedAt).format('MMM D, YYYY'); // "May 16, 2025"
        const hours = Math.floor((afterData.duration) / 3600); // Convert seconds to hours
        // Add to pending notifications instead of sending immediately
        await addToPendingNotifications(userId, "timesheet_approval", {
          timesheetId: timesheetId,
          rawdate: afterData.submittedAt || "Unknown date",
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