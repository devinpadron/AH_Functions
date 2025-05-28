const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

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

module.exports = {
  sendNotificationToUsers
};