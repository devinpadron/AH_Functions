const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const {addToAvailabilityBatch} = require("../utils/notificationBatch");
const {getCompanyMemberIds} = require("../utils/notifications");
const {C} = require("../utils/paths");

/*
 * Notify company admins/owners when a user confirms or declines availability.
 *
 * This is the one function whose TRIGGER COLLECTION changes, not just its path.
 * v1 watched the event document and diffed its `workerStatus` map; v2 stores
 * one `eventResponses/{eventId}_{userId}` document per worker, so the trigger
 * moves to that collection and the map diff collapses into a single-field
 * comparison. One invocation per responding worker instead of one per event
 * write carrying N changes — the downstream batching already groups by admin,
 * so the notification the user actually receives is unchanged.
 */
exports.notifyUserStatusChange = onDocumentWritten({
  document: `${C.eventResponses}/{responseId}`,
}, async (event) => {
  try {
    // If document was deleted, exit
    if (!event.data.after) {
      logger.log("Document was deleted, no notifications needed");
      return null;
    }

    const beforeData = event.data.before && event.data.before.data() ? event.data.before.data() : {};
    const afterData = event.data.after && event.data.after.data() ? event.data.after.data() : {};

    const beforeStatus = beforeData.status;
    const afterStatus = afterData.status;

    // Only confirmed/declined are worth notifying about; "pending" is the
    // resting state that every response document is created in.
    if (beforeStatus === afterStatus) {
      logger.log("No availability status changes detected");
      return null;
    }
    if (afterStatus !== "confirmed" && afterStatus !== "declined") {
      logger.log("No availability status changes detected");
      return null;
    }

    // eventId / userId / companyId are all fields on the response document.
    const eventId = afterData.eventId;
    const userId = afterData.userId;
    const companyId = afterData.companyId;

    if (!eventId || !userId || !companyId) {
      logger.warn(`Response ${event.params.responseId} missing eventId/userId/companyId, skipping`);
      return null;
    }

    logger.log(`Detected 1 availability status changes for event ${eventId}`);

    try {
      // Get company admins/owners (v1: Companies/{companyId}/Users, role in ...)
      const adminIds = await getCompanyMemberIds(companyId, ['manager', 'owner']);

      if (adminIds.length === 0) {
        logger.warn(`No admins/owners found in company ${companyId}`);
        return null;
      }

      /*
       * There used to be a per-admin "mute status changes" filter here.
       *
       * It read `users/{adminId}/Preferences/muteStatusChange` — a V1
       * subcollection, and one that NO code in the AntHill app has ever
       * written, in either schema. So it was a guaranteed miss: one Firestore
       * read per admin, on every single response change, to learn nothing.
       *
       * Removed rather than path-mapped. If muting is wanted, it belongs as a
       * field on `userSettings/{userId}` — a document the app already reads and
       * writes — which costs one read for the whole company instead of one per
       * admin, and would actually be settable from the UI.
       */
      const filteredAdminIds = adminIds;

      // Get event title. In v1 this was already in hand because the trigger
      // fired on the event document itself.
      let eventTitle = "Unnamed Event";
      try {
        const eventDoc = await admin.firestore().collection(C.events).doc(eventId).get();
        if (eventDoc.exists) {
          eventTitle = eventDoc.data().title || "Unnamed Event";
        }
      } catch (error) {
        logger.error(`Error fetching event ${eventId}:`, error);
      }

      // Get user details
      let userName = "A user";
      try {
        const userDoc = await admin.firestore().collection(C.users).doc(userId).get();

        if (userDoc.exists) {
          const userData = userDoc.data();
          userName = `${userData.firstName || ""} ${userData.lastName || ""}`.trim() || userData.email || "A user";
        }
      } catch (error) {
        logger.error(`Error fetching user ${userId}:`, error);
      }

      // Add to batch notifications for each admin
      const batchPromises = filteredAdminIds.map(adminId =>
        addToAvailabilityBatch(
          adminId,
          eventId,
          afterStatus,
          {
            eventTitle: eventTitle,
            companyId: companyId,
            userId: userId,
            userName: userName
          }
        )
      );

      await Promise.all(batchPromises);

      logger.log(`Added ${afterStatus} notification to availability batch for ${filteredAdminIds.length} admins for user ${userId} on event ${eventId}`);
    } catch (error) {
      logger.error(`Error fetching admins or sending notifications:`, error);
    }

    return null;
  } catch (error) {
    logger.error("Error in notifyUserStatusChange function:", error);
    return null;
  }
});
