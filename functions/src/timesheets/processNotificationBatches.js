const {onSchedule} = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const {sendNotificationToUsers} = require("../utils/notifications");

// Function that runs every 5 minutes to process notification batches
exports.processNotificationBatches = onSchedule({
  schedule: "every 5 minutes",
  timeZone: "America/New_York" // Adjust to your preferred timezone
}, async (event) => {
  try {
    // Get all pending notification batches older than our batch window
    const cutoffTime = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    
    const batchSnapshot = await admin.firestore()
      .collection('PendingNotifications')
      .where('lastUpdated', '<', cutoffTime)
      .get();
    
    if (batchSnapshot.empty) {
      logger.log('No notification batches to process');
      return null;
    }
    
    logger.log(`Processing ${batchSnapshot.size} notification batches`);
    
    const batchPromises = batchSnapshot.docs.map(async (doc) => {
      const batchData = doc.data();
      const userId = batchData.userId;
      const notifications = batchData.notifications || [];
      
      if (notifications.length === 0) {
        // Clean up empty batch
        await doc.ref.delete();
        return;
      }
      
      // Group notifications by type
      const groupedNotifications = {};
      notifications.forEach(notification => {
        if (!groupedNotifications[notification.type]) {
          groupedNotifications[notification.type] = [];
        }
        groupedNotifications[notification.type].push(notification.data);
      });
      
      // Process each notification type
      for (const [type, items] of Object.entries(groupedNotifications)) {
        if (type === "timesheet_approval") {
          if (items.length === 1) {
            // Single approval
            const item = items[0];
            await sendNotificationToUsers([userId],
              "Timesheet Approved",
              `Your timesheet on ${item.date} (${item.hours} hours) has been approved`,
              {
                timesheetId: item.timesheetId,
                type: "timesheet_approval"
              }
            );
          } else {
            // Multiple approvals
            await sendNotificationToUsers([userId],
              "Multiple Timesheets Approved",
              `${items.length} of your timesheets have been approved`,
              {
                count: items.length.toString(),
                timesheetIds: items.map(item => item.timesheetId).join(','),
                type: "timesheet_approval_batch"
              }
            );
          }
        }
        // Handle other notification types as needed
      }
      
      // Delete the batch after processing
      await doc.ref.delete();
      logger.log(`Processed and sent notifications for user ${userId}`);
    });
    
    await Promise.all(batchPromises);
    logger.log('All notification batches processed successfully');
    
    return null;
  } catch (error) {
    logger.error('Error processing notification batches:', error);
    throw error;
  }
});