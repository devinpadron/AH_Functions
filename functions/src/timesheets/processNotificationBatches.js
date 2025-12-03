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

    if (!batchSnapshot.empty) {
      logger.log(`Processing ${batchSnapshot.size} user notification batches`);
    }
    
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
                userId: userId,
                companyId: item.companyId,
                screenName: "TimeEntryDetails",
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
                timesheetId: items.map(i => i.timesheetId).join(","),
                userId: userId,
                companyId: items[0].companyId,
                screenName: "TimeEntryDetails",
                type: "timesheet_approval_batch"
              }
            );
          }
        }
      if (type === "timesheet_rejection") {
        if (items.length === 1) {
            // Single rejection
            const item = items[0];
            await sendNotificationToUsers([userId],
              "Timesheet Rejected",
              `Your timesheet on ${item.date} (${item.hours} hours) has been rejected`,
              {
                timesheetId: item.timesheetId,
                userId: userId,
                companyId: item.companyId,
                screenName: "TimeEntryDetails",
                type: "timesheet_rejection"
              }
            );
          } else {
            // Multiple approvals
            await sendNotificationToUsers([userId],
              "Multiple Timesheets Rejected",
              `${items.length} of your timesheets have been rejected`,
              {
                count: items.length.toString(),
                timesheetId: items.map(i => i.timesheetId).join(","),
                userId: userId,
                companyId: items[0].companyId,
                screenName: "TimeEntryDetails",
                type: "timesheet_rejection_batch"
              }
            );
          }
      }
    }
      
      // Delete the batch after processing
      await doc.ref.delete();
      logger.log(`Processed and sent notifications for user ${userId}`);
    });
    
    if (!batchSnapshot.empty) {
      await Promise.all(batchPromises);
      logger.log('User notification batches processed successfully');
    } else {
      logger.log('No user notification batches ready');
    }
    
    // Process availability notification batches
    const availabilityBatchSnapshot = await admin.firestore()
      .collection('PendingAvailabilityNotifications')
      .where('lastUpdated', '<', cutoffTime)
      .get();

    if (!availabilityBatchSnapshot.empty) {
      logger.log(`Processing ${availabilityBatchSnapshot.size} availability notification batches`);
      
      const availabilityPromises = availabilityBatchSnapshot.docs.map(async (doc) => {
        const batchData = doc.data();
        const adminId = batchData.adminId;
        const companyId = batchData.companyId;
        const events = batchData.events || [];
        
        if (events.length === 0) {
          await doc.ref.delete();
          return;
        }
        
        // Count total confirmations and declines across all events
        let totalConfirmed = 0;
        let totalDeclined = 0;
        let allUsers = new Set();
        
        events.forEach(event => {
          totalConfirmed += (event.confirmed || []).length;
          totalDeclined += (event.declined || []).length;
          (event.confirmed || []).forEach(u => allUsers.add(u.userName));
          (event.declined || []).forEach(u => allUsers.add(u.userName));
        });
        
        // Build notification based on what we have
        let title = "";
        let body = "";
        let type = "";
        
        if (events.length === 1) {
          // Single event
          const event = events[0];
          const confirmed = event.confirmed || [];
          const declined = event.declined || [];
          
          if (confirmed.length > 0 && declined.length === 0) {
            if (confirmed.length === 1) {
              title = "User Confirmed Availability";
              body = `${confirmed[0].userName} has confirmed their availability for "${event.eventTitle}"`;
              type = "availability_confirmed";
            } else {
              title = "Multiple Users Confirmed";
              body = `${confirmed.length} users have confirmed their availability for "${event.eventTitle}"`;
              type = "availability_confirmed_batch";
            }
          } else if (declined.length > 0 && confirmed.length === 0) {
            if (declined.length === 1) {
              title = "User Declined Availability";
              body = `${declined[0].userName} has declined availability for "${event.eventTitle}"`;
              type = "availability_declined";
            } else {
              title = "Multiple Users Declined";
              body = `${declined.length} users have declined their availability for "${event.eventTitle}"`;
              type = "availability_declined_batch";
            }
          } else {
            title = "Availability Updates";
            body = `${confirmed.length} confirmed and ${declined.length} declined availability for "${event.eventTitle}"`;
            type = "availability_mixed_batch";
          }
        } else {
          // Multiple events
          if (totalConfirmed > 0 && totalDeclined === 0) {
            title = "Users Confirmed Availability";
            body = `${totalConfirmed} confirmation${totalConfirmed > 1 ? 's' : ''} across ${events.length} events`;
            type = "availability_confirmed_multi_event";
          } else if (totalDeclined > 0 && totalConfirmed === 0) {
            title = "Users Declined Availability";
            body = `${totalDeclined} decline${totalDeclined > 1 ? 's' : ''} across ${events.length} events`;
            type = "availability_declined_multi_event";
          } else {
            title = "Availability Updates";
            body = `${totalConfirmed} confirmed and ${totalDeclined} declined across ${events.length} events`;
            type = "availability_mixed_multi_event";
          }
        }
        
        // Send the notification
        await sendNotificationToUsers(
          [adminId],
          title,
          body,
          {
            companyId: companyId,
            screenName: "EventList",
            eventCount: events.length.toString(),
            confirmedCount: totalConfirmed.toString(),
            declinedCount: totalDeclined.toString(),
            type: type
          }
        );
        
        // Delete the batch after processing
        await doc.ref.delete();
        logger.log(`Processed availability batch for admin ${adminId}: ${events.length} events, ${totalConfirmed} confirmed, ${totalDeclined} declined`);
      });
      
      await Promise.all(availabilityPromises);
      logger.log('Availability notification batches processed successfully');
    }
    else {
      logger.log('No availability notification batches ready');
    }
    
    // Process new event notification batches
    const newEventBatchSnapshot = await admin.firestore()
      .collection('PendingNewEventNotifications')
      .where('lastUpdated', '<', cutoffTime)
      .get();

    if (!newEventBatchSnapshot.empty) {
      logger.log(`Processing ${newEventBatchSnapshot.size} new event notification batches`);
      
      const newEventPromises = newEventBatchSnapshot.docs.map(async (doc) => {
        const batchData = doc.data();
        const companyId = batchData.companyId;
        const userIds = batchData.userIds || [];
        const events = batchData.events || [];
        
        if (events.length === 0 || userIds.length === 0) {
          await doc.ref.delete();
          return;
        }
        
        // Get company name
        const companyDoc = await admin.firestore().collection('Companies').doc(companyId).get();
        const companyName = companyDoc.exists ? (companyDoc.data().name || "your company") : "your company";
        
        // Build notification based on number of events
        let title = "";
        let body = "";
        let type = "";
        
        if (events.length === 1) {
          // Single event
          const event = events[0];
          title = "New Event Available";
          body = `A new event "${event.eventTitle}" is available for ${companyName}. Please confirm your availability for ${event.eventDate}.`;
          type = "new_event_unassigned";
        } else {
          // Multiple events
          title = "New Events Available";
          body = `${events.length} new events are available for ${companyName}. Please confirm your availability.`;
          type = "new_events_batch";
        }
        
        // Send the notification to all users
        await sendNotificationToUsers(
          userIds,
          title,
          body,
          {
            companyId: companyId,
            screenName: "EventList",
            eventCount: events.length.toString(),
            type: type
          }
        );
        
        // Delete the batch after processing
        await doc.ref.delete();
        logger.log(`Processed new event batch for company ${companyId}, sent to ${userIds.length} users about ${events.length} events`);
      });
      
      await Promise.all(newEventPromises);
      logger.log('New event notification batches processed successfully');
    }
    else {
      logger.log('No new event notification batches ready');
    }
    
    return null;
  } catch (error) {
    logger.error('Error processing notification batches:', error);
    throw error;
  }
});