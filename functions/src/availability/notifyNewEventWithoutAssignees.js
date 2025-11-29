const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

// Function to notify all company users when a new event is created without assigned workers
exports.notifyNewEventWithoutAssignees = onDocumentCreated({
  document: "Companies/{companyId}/Events/{eventId}",
}, async (event) => {
  try {
    // Get the event ID and company ID from the path
    const eventId = event.params.eventId;
    const companyId = event.params.companyId;
    
    // Get the event data
    const eventData = event.data.data();
    
    if (!eventData) {
      logger.log("No event data found");
      return null;
    }
    
    // Check if the event has assignedWorkers
    const assignedWorkers = Array.isArray(eventData.assignedWorkers) ? eventData.assignedWorkers : [];
    
    // Only proceed if there are NO assigned workers
    if (assignedWorkers.length > 0) {
      logger.log(`Event ${eventId} has ${assignedWorkers.length} assigned workers, skipping notification`);
      return null;
    }
    
    // Check if enableAvailability setting is enabled for the company
    try {
      const settingsDoc = await admin.firestore()
        .collection('Companies')
        .doc(companyId)
        .collection('Settings')
        .doc('preferences')
        .get();
      
      if (settingsDoc.exists) {
        const settings = settingsDoc.data();
        const enableAvailability = settings.enableAvailability;
        
        if (enableAvailability === false) {
          logger.log(`enableAvailability is disabled for company ${companyId}, skipping notification`);
          return null;
        }
      } else {
        // Settings document doesn't exist, skip notification
        logger.log(`Settings document doesn't exist for company ${companyId}, skipping notification`);
        return null;
      }
    } catch (error) {
      logger.error(`Error checking company settings for ${companyId}:`, error);
      // Skip notification if we can't read settings
      return null;
    }
    
    logger.log(`New event ${eventId} created without assigned workers, adding to notification batch`);
    
    // Get all users in the company
    try {
      const companyUsersSnapshot = await admin.firestore()
        .collection('Companies')
        .doc(companyId)
        .collection('Users')
        .get();
      
      if (companyUsersSnapshot.empty) {
        logger.warn(`No users found in company ${companyId}`);
        return null;
      }
      
      // Get all user IDs from the company
      const userIds = companyUsersSnapshot.docs.map(doc => doc.id);
      
      // Create notification message
      const eventTitle = eventData.title || "Unnamed Event";
      const eventDate = eventData.date || "TBD";
      
      // Add to batch for each user
      const batchRef = admin.firestore().collection('PendingNewEventNotifications').doc(companyId);
      
      await admin.firestore().runTransaction(async (transaction) => {
        const doc = await transaction.get(batchRef);
        
        if (!doc.exists) {
          // First event for this company
          transaction.set(batchRef, {
            companyId: companyId,
            userIds: userIds,
            events: [{
              eventId: eventId,
              eventTitle: eventTitle,
              eventDate: eventDate
            }],
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
          });
        } else {
          // Add to existing batch and reset timer
          const batchData = doc.data();
          const events = batchData.events || [];
          
          events.push({
            eventId: eventId,
            eventTitle: eventTitle,
            eventDate: eventDate
          });
          
          transaction.update(batchRef, { 
            events,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
          });
        }
      });
      
      logger.log(`Added event ${eventId} to new event notification batch for company ${companyId}`);
    } catch (error) {
      logger.error(`Error adding to new event batch:`, error);
    }
    
    return null;
  } catch (error) {
    logger.error("Error in notifyNewEventWithoutAssignees function:", error);
    return null;
  }
});
