const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const {sendNotificationToUsers} = require("../utils/notifications");
const {C} = require("../utils/paths");

// Function to notify users when they are assigned to an event
exports.notifyAssignedWorkers = onDocumentWritten({
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

    // Get assigned workers from before and after (v1: assignedWorkers)
    const beforeWorkers = Array.isArray(beforeData.assignedUserIds) ? beforeData.assignedUserIds : [];
    const afterWorkers = Array.isArray(afterData.assignedUserIds) ? afterData.assignedUserIds : [];

    // Find newly added worker IDs
    const newlyAssignedWorkers = afterWorkers.filter(workerId =>
      !beforeWorkers.includes(workerId)
    );

    // Find removed worker IDs
    const removedWorkers = beforeWorkers.filter(workerId =>
      !afterWorkers.includes(workerId)
    );

    logger.log(`Event ${eventId} changes - Added: ${newlyAssignedWorkers.length}, Removed: ${removedWorkers.length}`);

    // Process newly assigned workers
    if (newlyAssignedWorkers.length > 0) {
      logger.log(`Sending notifications to ${newlyAssignedWorkers.length} newly assigned workers for event: ${eventId}`);

      // Send notifications to all newly assigned workers
      await sendNotificationToUsers(newlyAssignedWorkers,
          "New Event Assignment",
          `You have been assigned to a new event: ${afterData.title || "Unnamed Event"}`,
          {
              eventId: eventId,
              screenName: "Details",
              companyId: companyId,
              type: "assignment"
          }
      );
    }

    // Process removed workers
    if (removedWorkers.length > 0) {
      logger.log(`${removedWorkers.length} workers were removed from event: ${eventId}`);

      await sendNotificationToUsers(removedWorkers,
          "Event Assignment Removed",
          `You have been removed from event: ${afterData.title || "Unnamed Event"}`,
          {
              eventId: eventId,
              screenName: "Details",
              companyId: companyId,
              type: "removal"
          }
      );
    }

    return null;
  } catch (error) {
    logger.error("Error in notifyAssignedWorkers function:", error);
    return null;
  }
});
