const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const {getCompanyMemberIds} = require("../utils/notifications");
const {C} = require("../utils/paths");

// Function to notify all company users when a new event is created without assigned workers
exports.notifyNewEventWithoutAssignees = onDocumentCreated({
  document: `${C.events}/{eventId}`,
}, async (event) => {
  try {
    // Get the event ID from the path
    const eventId = event.params.eventId;

    // Get the event data
    const eventData = event.data && event.data.data();

    if (!eventData) {
      logger.log("No event data found");
      return null;
    }

    // companyId was a path wildcard in v1; in v2 it is a field on the document.
    const companyId = eventData.companyId;
    if (!companyId) {
      logger.warn(`Event ${eventId} has no companyId, skipping notification`);
      return null;
    }

    // Check if the event has assigned workers (v1: assignedWorkers)
    const assignedWorkers = Array.isArray(eventData.assignedUserIds) ? eventData.assignedUserIds : [];

    // Only proceed if there are NO assigned workers
    if (assignedWorkers.length > 0) {
      logger.log(`Event ${eventId} has ${assignedWorkers.length} assigned workers, skipping notification`);
      return null;
    }

    /*
     * Check if enableAvailability setting is enabled for the company.
     *
     * v1: Companies/{companyId}/Settings/preferences
     * v2: companyPreferences/{companyId}
     *
     * Fails CLOSED, exactly as v1 did: a missing preferences document means no
     * notification. Worth knowing during cutover — if companyPreferences has
     * not been populated for a company, this feature goes quiet rather than
     * erroring.
     */
    try {
      const preferencesDoc = await admin.firestore()
        .collection(C.companyPreferences)
        .doc(companyId)
        .get();

      if (preferencesDoc.exists) {
        const preferences = preferencesDoc.data();
        const enableAvailability = preferences.enableAvailability;

        if (enableAvailability === false) {
          logger.log(`enableAvailability is disabled for company ${companyId}, skipping notification`);
          return null;
        }
      } else {
        // Preferences document doesn't exist, skip notification
        logger.log(`Preferences document doesn't exist for company ${companyId}, skipping notification`);
        return null;
      }
    } catch (error) {
      logger.error(`Error checking company preferences for ${companyId}:`, error);
      // Skip notification if we can't read preferences
      return null;
    }

    logger.log(`New event ${eventId} created without assigned workers, adding to notification batch`);

    // Get all users in the company
    try {
      // v1 listed Companies/{companyId}/Users, which had no status concept
      // because leaving deleted the document. v2 soft-deletes, so this filters
      // to active members — otherwise removed staff would be notified.
      const userIds = await getCompanyMemberIds(companyId);

      if (userIds.length === 0) {
        logger.warn(`No active users found in company ${companyId}`);
        return null;
      }

      // Create notification message
      const eventTitle = eventData.title || "Unnamed Event";
      const eventDate = eventData.dateKey || "TBD"; // v1: eventData.date

      // Add to batch for each user
      const batchRef = admin.firestore()
        .collection(C.pendingNewEventNotifications)
        .doc(companyId);

      await admin.firestore().runTransaction(async (transaction) => {
        const doc = await transaction.get(batchRef);

        if (!doc.exists) {
          // First event for this company
          transaction.set(batchRef, {
            companyId: companyId,
            userIds: userIds,
            events: [{
              eventId: eventId,
              eventTitle: eventTitle,
              eventDate: eventDate
            }],
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
          });
        } else {
          // Add to existing batch and reset timer
          const batchData = doc.data();
          const events = batchData.events || [];

          events.push({
            eventId: eventId,
            eventTitle: eventTitle,
            eventDate: eventDate
          });

          transaction.update(batchRef, {
            events,
            // Refresh the recipient list too: the batch window is open for
            // minutes, and v1 pinned whoever was a member when the FIRST event
            // landed.
            userIds: userIds,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      });

      logger.log(`Added event ${eventId} to new event notification batch for company ${companyId}`);
    } catch (error) {
      logger.error(`Error adding to new event batch:`, error);
    }

    return null;
  } catch (error) {
    logger.error("Error in notifyNewEventWithoutAssignees function:", error);
    return null;
  }
});
