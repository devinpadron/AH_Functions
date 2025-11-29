const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const {addToAvailabilityBatch} = require("../utils/notificationBatch");
const admin = require("firebase-admin");

// Function to notify company admins/owners when a user confirms or declines availability for an event
exports.notifyUserStatusChange = onDocumentWritten({
  document: "Companies/{companyId}/Events/{eventId}",
}, async (event) => {
  try {
    // Get the event ID and company ID from the path
    const eventId = event.params.eventId;
    const companyId = event.params.companyId;
    
    // Get the data before and after the write
    const beforeData = event.data.before && event.data.before.data() ? event.data.before.data() : {};
    const afterData = event.data.after && event.data.after.data() ? event.data.after.data() : {};
    
    // If document was deleted, exit
    if (!event.data.after) {
      logger.log("Document was deleted, no notifications needed");
      return null;
    }
    
    // Get workerStatus objects
    const beforeWorkerStatus = beforeData.workerStatus || {};
    const afterWorkerStatus = afterData.workerStatus || {};
    
    // Find users who just confirmed or declined
    const statusChanges = [];
    
    for (const userId in afterWorkerStatus) {
      const beforeStatus = beforeWorkerStatus[userId];
      const afterStatus = afterWorkerStatus[userId];
      
      // Check if this is a new status or if the status changed
      if (!beforeStatus && (afterStatus === "confirmed" || afterStatus === "declined")) {
        statusChanges.push({
          userId: userId,
          status: afterStatus
        });
      } else if (beforeStatus !== afterStatus && (afterStatus === "confirmed" || afterStatus === "declined")) {
        statusChanges.push({
          userId: userId,
          status: afterStatus
        });
      }
    }
    
    // If no status changes, exit
    if (statusChanges.length === 0) {
      logger.log("No availability status changes detected");
      return null;
    }
    
    logger.log(`Detected ${statusChanges.length} availability status changes for event ${eventId}`);
    
    // Get company admins/owners
    try {
      const adminSnapshot = await admin.firestore()
        .collection('Companies')
        .doc(companyId)
        .collection('Users')
        .where('role', 'in', ['manager', 'owner'])
        .get();
      
      if (adminSnapshot.empty) {
        logger.warn(`No admins/owners found in company ${companyId}`);
        return null;
      }
      
      const adminIds = adminSnapshot.docs.map(doc => doc.id);
      
      // Filter out admins who have muted status change notifications
      const filteredAdminIds = [];
      for (const adminId of adminIds) {
        try {
          const preferencesDoc = await admin.firestore()
            .collection('Users')
            .doc(adminId)
            .collection('Preferences')
            .doc('muteStatusChange')
            .get();
          
          if (preferencesDoc.exists && preferencesDoc.data().muteStatusChange === true) {
            logger.log(`Admin ${adminId} has muted status change notifications, skipping`);
            continue;
          }
          
          filteredAdminIds.push(adminId);
        } catch (error) {
          logger.error(`Error checking preferences for admin ${adminId}:`, error);
          // If we can't read preferences, include the admin in notifications
          filteredAdminIds.push(adminId);
        }
      }
      
      if (filteredAdminIds.length === 0) {
        logger.log("All admins have muted status change notifications");
        return null;
      }
      
      // Get event title
      const eventTitle = afterData.title || "Unnamed Event";
      
      // Add notifications to batch for each status change
      for (const change of statusChanges) {
        try {
          // Get user details
          const userDoc = await admin.firestore().collection('Users').doc(change.userId).get();
          let userName = "A user";
          
          if (userDoc.exists) {
            const userData = userDoc.data();
            userName = `${userData.firstName || ""} ${userData.lastName || ""}`.trim() || userData.email || "A user";
          }
          
          // Add to batch notifications for each admin
          const batchPromises = filteredAdminIds.map(adminId => 
            addToAvailabilityBatch(
              adminId,
              eventId,
              change.status,
              {
                eventTitle: eventTitle,
                companyId: companyId,
                userId: change.userId,
                userName: userName
              }
            )
          );
          
          await Promise.all(batchPromises);
          
          logger.log(`Added ${change.status} notification to availability batch for ${filteredAdminIds.length} admins for user ${change.userId} on event ${eventId}`);
        } catch (error) {
          logger.error(`Error processing status change for user ${change.userId}:`, error);
        }
      }
    } catch (error) {
      logger.error(`Error fetching admins or sending notifications:`, error);
    }
    
    return null;
  } catch (error) {
    logger.error("Error in notifyUserConfirms function:", error);
    return null;
  }
});
