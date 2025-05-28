/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

// Initialize Firebase Admin SDK
admin.initializeApp();

// Function to notify users when they are assigned to an event
exports.notifyAssignedWorkers = onDocumentWritten({
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
    
    // Get assigned workers from before and after
    const beforeWorkers = Array.isArray(beforeData.assignedWorkers) ? beforeData.assignedWorkers : [];
    const afterWorkers = Array.isArray(afterData.assignedWorkers) ? afterData.assignedWorkers : [];
    
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
              eventName: afterData.title || "Unnamed Event",
              companyId: event.params.companyId,
              type: "assignment"
          }
      );
    }
    
    // Process removed workers
    if (removedWorkers.length > 0) {
      logger.log(`${removedWorkers.length} workers were removed from event: ${eventId}`);
      
      // You could send notifications here if needed
      await sendNotificationToUsers(removedWorkers,
          "Event Assignment Removed",
          `You have been removed from event: ${afterData.title || "Unnamed Event"}`,
          {
              eventId: eventId,
              eventName: afterData.title || "Unnamed Event",
              companyId: event.params.companyId,
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


/**
 * General notification helper function to send notifications to users
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
        const userDoc = await admin.firestore().collection('Users').doc(userId).get();
        
        if (!userDoc.exists) {
          logger.warn(`User document for ID ${userId} not found`);
          return;
        }
        
        const userData = userDoc.data();
        const fcmTokens = userData.fcmToken;
        
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
                
                // Remove the invalid token from the array
                const updatedTokens = fcmTokens.filter(t => t !== token);
                
                // Update the user document
                await admin.firestore().collection('Users').doc(userId).update({
                  fcmToken: updatedTokens
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




