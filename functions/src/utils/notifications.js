const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const {C} = require("./paths");

/**
 * v2 notification helper.
 *
 * Same contract as src/utils/notifications.js, against the v2 schema:
 *   Users/{uid}.fcmToken (array)  ->  users/{uid}.fcmTokens (array)
 *
 * The FCM message shape is deliberately IDENTICAL to v1 — the app parses
 * data.type / screenName / companyId / eventId / timesheetId / userId and is
 * shipped separately, so the payload cannot change with the schema.
 *
 * @param {string[]} userIds - Array of user IDs to notify
 * @param {string} title - Notification title
 * @param {string} body - Notification body
 * @param {Object} data - Optional data payload for the notification
 * @returns {Promise<void>}
 */
async function sendNotificationToUsers(userIds, title, body, data = {}) {
  try {
    // Process each user in parallel
    const promises = userIds.map(async (userId) => {
      try {
        // Get the user's FCM tokens from their user document
        const userDoc = await admin.firestore().collection(C.users).doc(userId).get();

        if (!userDoc.exists) {
          logger.warn(`User document for ID ${userId} not found`);
          return;
        }

        const userData = userDoc.data();
        const fcmTokens = userData.fcmTokens;

        if (!fcmTokens || (Array.isArray(fcmTokens) && fcmTokens.length === 0)) {
          logger.warn(`No FCM tokens found for user ${userId}`);
          return;
        }

        // Create base notification message
        const baseMessage = {
          notification: {
            title: title,
            body: body
          },
          data: {
            ...data,
            timestamp: Date.now().toString()
          }
        };

        // Handle sending to all tokens
        if (Array.isArray(fcmTokens)) {
          // Send to each token
          const tokenPromises = fcmTokens.map(async (token) => {
            try {
              const message = {
                ...baseMessage,
                token: token
              };
              await admin.messaging().send(message);
              logger.log(`Notification sent to token for user ${userId}`);
            } catch (tokenError) {
              logger.error(`Error sending to specific token for user ${userId}:`, tokenError);

              // Check if the token is invalid or unregistered
              if (
                tokenError.code === 'messaging/invalid-registration-token' ||
                tokenError.code === 'messaging/registration-token-not-registered'
              ) {
                logger.log(`Removing invalid token for user ${userId}`);

                // Remove the invalid token atomically. v1 wrote back a filtered
                // copy of the array it had read, which clobbered any token
                // registered by another device since that read.
                await admin.firestore().collection(C.users).doc(userId).update({
                  fcmTokens: admin.firestore.FieldValue.arrayRemove(token)
                });

                logger.log(`Invalid token removed for user ${userId}`);
              }
            }
          });

          await Promise.all(tokenPromises);
        }
      } catch (error) {
        logger.error(`Error sending notification to user ${userId}:`, error);
      }
    });

    await Promise.all(promises);
  } catch (error) {
    logger.error("Error sending notifications:", error);
  }
}

/**
 * Active members of a company, optionally filtered by role.
 *
 * Replaces v1's `Companies/{companyId}/Users` subcollection listing. Two
 * differences that matter:
 *   - the membership doc id is `{companyId}_{userId}`, so the user id comes
 *     from the `userId` FIELD, not from doc.id;
 *   - v2 soft-deletes members (`status: "removed"`) where v1 deleted the
 *     document, so an unfiltered query would notify people who have left.
 *
 * @param {string} companyId
 * @param {string[]|null} roles - e.g. ["manager", "owner"], or null for all
 * @returns {Promise<string[]>} user ids
 */
async function getCompanyMemberIds(companyId, roles = null) {
  let query = admin.firestore()
    .collection(C.memberships)
    .where('companyId', '==', companyId)
    .where('status', '==', 'active');

  if (roles) {
    query = query.where('role', 'in', roles);
  }

  const snapshot = await query.get();
  return snapshot.docs.map(doc => doc.data().userId).filter(Boolean);
}

module.exports = {
  sendNotificationToUsers,
  getCompanyMemberIds
};
