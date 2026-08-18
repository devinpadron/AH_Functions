const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const {getEventAudienceIds} = require("../utils/audience");
const {C} = require("../utils/paths");

// Notifies the workers who can actually SEE a new unassigned event.
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

    // Work out who this event is actually for
    try {
      /*
       * The event's AUDIENCE, not the whole company.
       *
       * This used to notify every active member, which predates worker groups:
       * a job targeted at one group buzzed the entire company, and a restricted
       * 1099 contractor was told about work they cannot see or accept. See
       * ../utils/audience for the visibility rules this mirrors.
       */
      const userIds = await getEventAudienceIds(companyId, eventData);

      if (userIds.length === 0) {
        logger.warn(`No one can see event ${eventId} in company ${companyId}`);
        return null;
      }

      // Create notification message
      const eventTitle = eventData.title || "Unnamed Event";
      const eventDate = eventData.dateKey || "TBD"; // v1: eventData.date

      /*
       * The batch is still keyed by company, but the recipients now hang off
       * each EVENT rather than off the batch.
       *
       * One list per batch cannot survive targeting: two events queued in the
       * same five-minute window routinely have different audiences, and a
       * single list would either union them — telling a bartender about the
       * server shift — or let whichever event was written last decide who hears
       * about the other. The drainer inverts these into one message per person.
       */
      const entry = {
        eventId: eventId,
        eventTitle: eventTitle,
        eventDate: eventDate,
        userIds: userIds
      };

      const batchRef = admin.firestore()
        .collection(C.pendingNewEventNotifications)
        .doc(companyId);

      await admin.firestore().runTransaction(async (transaction) => {
        const doc = await transaction.get(batchRef);

        if (!doc.exists) {
          // First event for this company
          transaction.set(batchRef, {
            companyId: companyId,
            events: [entry],
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
          });
        } else {
          // Add to existing batch and reset timer
          const batchData = doc.data();
          const events = batchData.events || [];

          events.push(entry);

          transaction.update(batchRef, {
            events,
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
