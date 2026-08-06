const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const {sendNotificationToUsers, getCompanyMemberIds} = require("../utils/notifications");
const {C} = require("../utils/paths");

/*
 * Notify company admins when someone joins or leaves.
 *
 * v1 keyed off document existence: Companies/{c}/Users/{uid} being created
 * meant "joined", being deleted meant "left". v2 soft-deletes instead —
 * `status` moves between "active" and "removed" and the document stays — so
 * leaving is a FIELD TRANSITION here, not a delete. A port that only watched
 * creation and deletion would never fire on a departure again.
 */
exports.notifyUserPassage = onDocumentWritten({
  document: `${C.memberships}/{membershipId}`,
}, async (event) => {
  try {
    const beforeData = event.data.before && event.data.before.data();
    const afterData = event.data.after && event.data.after.data();

    const membership = afterData || beforeData;
    if (!membership) {
      logger.log("No membership data, nothing to do");
      return null;
    }

    // companyId and userId were path wildcards in v1; in v2 they are fields.
    // (The document id is `{companyId}_{userId}`, but splitting it would break
    // on any company id containing an underscore.)
    const companyId = membership.companyId;
    const userId = membership.userId;

    if (!companyId || !userId) {
      logger.warn(`Membership ${event.params.membershipId} missing companyId/userId, skipping`);
      return null;
    }

    const wasActive = Boolean(beforeData) && beforeData.status === "active";
    const isActive = Boolean(afterData) && afterData.status === "active";

    if (wasActive === isActive) {
      logger.log("No membership status transition, no notifications needed");
      return null;
    }

    if (isActive) {
      logger.info(`New user joined company: ${companyId}`, {
        userId: userId,
        companyId: companyId
      });

      const userName = await resolveUserName(membership, userId, "A new user");
      const companyName = await resolveCompanyName(companyId);
      const adminIds = await getAdminIds(companyId, userId);

      if (adminIds.length > 0) {
        await sendNotificationToUsers(
          adminIds,
          "New User Joined",
          `${userName} has joined ${companyName}`,
          {
            companyId: companyId,
            screenName: "EmployeeList",
            newUserId: userId,
            type: "new_user_joined"
          }
        );

        logger.info(`Sent notifications to ${adminIds.length} company admins about new user`, {
          companyId,
          userId,
          adminCount: adminIds.length
        });
      }
    } else {
      logger.info(`User left company: ${companyId}`, {
        userId: userId,
        companyId: companyId
      });

      const userName = await resolveUserName(membership, userId, "A user");
      const companyName = await resolveCompanyName(companyId);
      const adminIds = await getAdminIds(companyId, userId);

      if (adminIds.length > 0) {
        await sendNotificationToUsers(
          adminIds,
          "User Left",
          `${userName} has left ${companyName}`,
          {
            companyId: companyId,
            screenName: "EmployeeList",
            leftUserId: userId,
            type: "user_left"
          }
        );

        logger.info(`Sent notifications to ${adminIds.length} company admins about user leaving`, {
          companyId,
          userId,
          adminCount: adminIds.length
        });
      }
    }

    return null;
  } catch (error) {
    logger.error("Error in notifyUserPassage function:", error);
    return null;
  }
});

/*
 * The membership carries denormalized name/email, so the common case needs no
 * second read. Falls back to users/{uid} for records written before those
 * fields were populated.
 */
async function resolveUserName(membership, userId, fallback) {
  const denormalized = `${membership.firstName || ""} ${membership.lastName || ""}`.trim();
  if (denormalized) return denormalized;
  if (membership.email) return membership.email;

  try {
    const userDoc = await admin.firestore().collection(C.users).doc(userId).get();
    if (userDoc.exists) {
      const userData = userDoc.data();
      const name = `${userData.firstName || ""} ${userData.lastName || ""}`.trim();
      return name || userData.email || fallback;
    }
  } catch (error) {
    logger.error(`Error fetching user details for ${userId}:`, error);
  }

  return fallback;
}

async function resolveCompanyName(companyId) {
  try {
    const companyDoc = await admin.firestore().collection(C.companies).doc(companyId).get();
    return companyDoc.exists ? (companyDoc.data().name || "your company") : "your company";
  } catch (error) {
    logger.error(`Error fetching company ${companyId}:`, error);
    return "your company";
  }
}

/*
 * Admins to notify, excluding the person the notification is about — an owner
 * joining their own company should not be told they joined.
 */
async function getAdminIds(companyId, subjectUserId) {
  try {
    const adminIds = await getCompanyMemberIds(companyId, ['manager', 'owner']);
    return adminIds.filter(id => id !== subjectUserId);
  } catch (error) {
    logger.error(`Error fetching admins for company ${companyId}:`, error);
    return [];
  }
}
