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

/**
 * Adds availability status change notification to batch, grouped by admin only
 * Resets timer each time a new status change occurs
 * Groups all events together to prevent spam when one user confirms/declines multiple events
 */
async function addToAvailabilityBatch(adminId, eventId, statusType, data) {
  try {
    // Create a batch key for just the admin (not per event)
    const batchRef = admin.firestore().collection('PendingAvailabilityNotifications').doc(adminId);
    
    // Add this notification to the pending batch using a transaction
    await admin.firestore().runTransaction(async (transaction) => {
      const doc = await transaction.get(batchRef);
      
      if (!doc.exists) {
        // First notification for this admin
        transaction.set(batchRef, {
          adminId,
          companyId: data.companyId,
          events: [{
            eventId,
            eventTitle: data.eventTitle,
            confirmed: statusType === "confirmed" ? [data] : [],
            declined: statusType === "declined" ? [data] : []
          }],
          lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        // Add to existing batch and reset timer
        const batchData = doc.data();
        const events = batchData.events || [];
        
        // Find if this event already exists in the batch
        const eventIndex = events.findIndex(e => e.eventId === eventId);
        
        if (eventIndex >= 0) {
          // Event exists, add to its confirmed/declined arrays
          if (statusType === "confirmed") {
            events[eventIndex].confirmed.push(data);
          } else {
            events[eventIndex].declined.push(data);
          }
        } else {
          // New event, add it to the batch
          events.push({
            eventId,
            eventTitle: data.eventTitle,
            confirmed: statusType === "confirmed" ? [data] : [],
            declined: statusType === "declined" ? [data] : []
          });
        }
        
        transaction.update(batchRef, { 
          events,
          lastUpdated: admin.firestore.FieldValue.serverTimestamp() // This resets the timer
        });
      }
    });
    
    logger.log(`Added availability notification to batch for admin ${adminId}`);
    return true;
  } catch (error) {
    logger.error(`Error adding to availability batch for admin ${adminId}:`, error);
    return false;
  }
}

module.exports = {
  addToPendingNotifications,
  addToAvailabilityBatch
};