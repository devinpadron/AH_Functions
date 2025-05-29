const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

// Batch window in milliseconds (5 minutes)
const BATCH_WINDOW = 5 * 60 * 1000;

/**
 * Adds a pending notification to be potentially batched
 */
async function addToPendingNotifications(userId, type, data) {
  try {
    // Create a reference to track pending notifications
    const batchRef = admin.firestore().collection('PendingNotifications').doc(userId);
    
    // Add this notification to the pending batch using a transaction
    await admin.firestore().runTransaction(async (transaction) => {
      const doc = await transaction.get(batchRef);
      
      if (!doc.exists) {
        // First notification for this user
        transaction.set(batchRef, {
          userId,
          notifications: [{
            type,
            data,
          }],
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        // Add to existing notifications
        const userData = doc.data();
        const notifications = userData.notifications || [];
        
        notifications.push({
          type,
          data,
        });
        
        transaction.update(batchRef, { 
          notifications,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });
    
    logger.log(`Added notification to batch for user ${userId}`);
    return true;
  } catch (error) {
    logger.error(`Error adding to notification batch for user ${userId}:`, error);
    return false;
  }
}

module.exports = {
  addToPendingNotifications
};