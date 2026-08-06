const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const {C} = require("./paths");

/*
 * Which preference switch each notification type answers to.
 *
 * Mirrors NOTIFICATION_ROWS in the app's UserPreferences screen. A type missing
 * from this map is UNFILTERED and always sends — an unexpected buzz is a much
 * smaller failure than a typo here silently muting a whole category with
 * nothing on screen to explain it.
 */
const CHANNEL_BY_TYPE = {
  assignment: "events",
  removal: "events",
  update: "events",

  availability_nudge: "availability",
  // A shift you already have, not an invitation — so it answers to the same
  // switch as the rest of "my shifts".
  assignment_ack_nudge: "events",
  new_event_unassigned: "availability",
  new_events_batch: "availability",

  timesheet_approval: "timesheets",
  timesheet_approval_batch: "timesheets",
  timesheet_rejection: "timesheets",
  timesheet_rejection_batch: "timesheets",

  new_user_joined: "team",
  user_left: "team",
  availability_confirmed: "team",
  availability_confirmed_batch: "team",
  availability_confirmed_multi_event: "team",
  availability_declined: "team",
  availability_declined_batch: "team",
  availability_declined_multi_event: "team",
  availability_mixed_batch: "team",
  availability_mixed_multi_event: "team",
};

/**
 * Drops the users who have muted this kind of notification.
 *
 * Filtering HERE rather than at each call site is the point: this is the one
 * function every push in the repo passes through, including the batched ones
 * the scheduler drains hours after they were queued. A per-caller check would
 * have to be remembered seven times and would be missed the eighth.
 *
 * FAILS OPEN throughout. A missing `notifications` object, a missing membership,
 * or a failed read all mean "send it" — the field is absent on every membership
 * written before this existed, so defaulting to silence would mute the entire
 * user base the moment this deployed.
 */
async function filterByPreference(userIds, companyId, type) {
  const channel = CHANNEL_BY_TYPE[type];
  if (!channel || !companyId || userIds.length === 0) return userIds;

  try {
    const db = admin.firestore();

    /*
     * Chunked: a "new events" push goes to every worker in the company, and
     * subscribeMembers caps that at 500. One getAll of 500 refs is a single
     * slow round trip that the whole send waits on.
     */
    const docs = [];
    for (let i = 0; i < userIds.length; i += 100) {
      const refs = userIds.slice(i, i + 100).map((userId) =>
        db.collection(C.memberships).doc(`${companyId}_${userId}`)
      );
      docs.push(...(await db.getAll(...refs)));
    }

    return userIds.filter((userId, index) => {
      const prefs = docs[index].exists ? docs[index].data().notifications : null;
      if (!prefs) return true;
      if (prefs.enabled === false) return false;
      return prefs[channel] !== false;
    });
  } catch (error) {
    logger.error(`Error reading notification preferences for ${companyId}:`, error);
    return userIds;
  }
}

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
    const allowed = await filterByPreference(userIds, data.companyId, data.type);

    if (allowed.length < userIds.length) {
      logger.log(
        `${userIds.length - allowed.length}/${userIds.length} recipients muted "${data.type}"`
      );
    }
    if (allowed.length === 0) return;

    // Process each user in parallel
    const promises = allowed.map(async (userId) => {
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
  getCompanyMemberIds,
  // Exported for the type-coverage check in tools/, not for callers.
  CHANNEL_BY_TYPE
};
