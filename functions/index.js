/**
 * Main Firebase Functions entry point
 * Import and re-export all functions from their respective modules
 */

const admin = require("firebase-admin");

// Initialize Firebase Admin SDK - This should be done ONCE in the main file
admin.initializeApp();

// Import and re-export event functions
const { notifyAssignedWorkers } = require("./src/events/notifyAssignedWorkers");
const { notifyEventChanged } = require("./src/events/notifyEventChanged");
const { processNotificationBatches } = require("./src/timesheets/processNotificationBatches");
const { notifyTimeDecision } = require("./src/timesheets/notifyTimeDecision");
const { notifyUserPassage } = require("./src/company/notifyUserPassage");

// Export all functions
module.exports = {
    notifyAssignedWorkers,
    notifyEventChanged,
    processNotificationBatches,
    notifyTimeDecision,
    notifyUserPassage
};




