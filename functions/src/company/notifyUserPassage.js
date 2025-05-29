const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const {sendNotificationToUsers} = require("../utils/notifications");
const admin = require("firebase-admin");

exports.notifyUserPassage = onDocumentWritten({
  document: "Companies/{companyId}/Users/{userId}",
}, async (event) => {
  try {
    // Get the company ID and user ID from the path
    const companyId = event.params.companyId;
    const userId = event.params.userId;
    
    // Get the data before and after the write
    const beforeData = event.data.before && event.data.before.data();
    const afterData = event.data.after && event.data.after.data();
    
    // Check if this is a new document (before doesn't exist, after does)
    if (!beforeData && afterData) {
      logger.info(`New user joined company: ${companyId}`, {
        userId: userId,
        companyId: companyId
      });
      
      // Get user details to include in the notification
      let userName = "A new user";
      try {
        const userDoc = await admin.firestore().collection('Users').doc(userId).get();
        if (userDoc.exists) {
          const userData = userDoc.data();
          userName = userData.firstName + " " + userData.lastName || userData.email || "A new user";
        }
      } catch (error) {
        logger.error(`Error fetching user details for ${userId}:`, error);
      }
      
      // Find company admins to notify
      try {
        const adminSnapshot = await admin.firestore()
          .collection('Companies')
          .doc(companyId)
          .collection('Users')
          .where('role', 'in', ['manager', 'owner'])
          .get();
        
        if (!adminSnapshot.empty) {
          const adminIds = adminSnapshot.docs.map(doc => doc.id);
          
          // Get company name
          const companyDoc = await admin.firestore().collection('Companies').doc(companyId).get();
          const companyName = companyDoc.exists ? (companyDoc.data().name || "your company") : "your company";
          
          // Send notification to admins
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
      } catch (error) {
        logger.error(`Error notifying admins about new user ${userId}:`, error);
      }
    }

    if(!afterData && beforeData) {
        logger.info(`User left company: ${companyId}`, {
            userId: userId,
            companyId: companyId
        });
        
        // Get user details to include in the notification
        let userName = "A user";
        try {
            const userDoc = await admin.firestore().collection('Users').doc(userId).get();
            if (userDoc.exists) {
            const userData = userDoc.data();
            userName = userData.firstName + " " + userData.lastName || userData.email || "A user";
            }
        } catch (error) {
            logger.error(`Error fetching user details for ${userId}:`, error);
        }
        
        // Find company admins to notify
        try {
            const adminSnapshot = await admin.firestore()
            .collection('Companies')
            .doc(companyId)
            .collection('Users')
            .where('role', 'in', ['manager', 'owner'])
            .get();
            
            if (!adminSnapshot.empty) {
            const adminIds = adminSnapshot.docs.map(doc => doc.id);
            
            // Get company name
            const companyDoc = await admin.firestore().collection('Companies').doc(companyId).get();
            const companyName = companyDoc.exists ? (companyDoc.data().name || "your company") : "your company";
            
            // Send notification to admins
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
        } catch (error) {
            logger.error(`Error notifying admins about user leaving ${userId}:`, error);
        }
    }
    
    return null;
  } catch (error) {
    logger.error("Error in notifyUserJoined function:", error);
    return null;
  }
});