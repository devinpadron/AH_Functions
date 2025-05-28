const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const {sendNotificationToUsers} = require("../utils/notifications");

exports.notifyEventChanged = onDocumentWritten({
  document: "Companies/{companyId}/Events/{eventId}",
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
    
    // Check if any significant fields have changed
    const changedFields = [];
    if (beforeData.title !== afterData.title) {
      changedFields.push("title");
    }
    if (beforeData.date !== afterData.date) {
      changedFields.push("date");
    }
    if (beforeData.locations !== afterData.locations) {
      changedFields.push("locations");
    }
    if (beforeData.startTime !== afterData.startTime) {
      changedFields.push("startTime");
    }
    if (beforeData.endTime !== afterData.endTime) {
      changedFields.push("endTime");
    }
    if (beforeData.notes !== afterData.notes) {
      changedFields.push("notes");
    }
    if (!areArraysEqual(beforeData.assignedWorkers, afterData.assignedWorkers)) {
    changedFields.push("assignedWorkers");
    }
    
    // If no significant changes, exit
    if (changedFields.length === 0) {
    logger.log("No significant changes detected, no notifications sent");
    return null;
    }

    logger.log(`Event ${eventId} changed fields: ${changedFields.join(", ")}`);

    // Get workers who were assigned both before and after the change
    const beforeWorkers = Array.isArray(beforeData.assignedWorkers) ? beforeData.assignedWorkers : [];
    const afterWorkers = Array.isArray(afterData.assignedWorkers) ? afterData.assignedWorkers : [];

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
            eventName: afterData.title || "Unnamed Event",
            companyId: event.params.companyId,
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
}
);

function areArraysEqual(array1, array2) {
  // Handle null/undefined cases
  if (!array1 && !array2) return true;
  if (!array1 || !array2) return false;
  
  // Convert to arrays if needed
  const a = Array.isArray(array1) ? array1 : [];
  const b = Array.isArray(array2) ? array2 : [];
  
  // Quick length check
  if (a.length !== b.length) return false;
  
  // Check if all items in a are in b
  return a.every(item => b.includes(item)) && b.every(item => a.includes(item));
}