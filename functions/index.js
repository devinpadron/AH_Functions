/**
 * Main Firebase Functions entry point
 * Import and re-export all functions from their respective modules
 */

const admin = require("firebase-admin");

// Initialize Firebase Admin SDK - This should be done ONCE in the main file
admin.initializeApp();

// ---------------------------------------------------------------------------
// Every function triggers on the v2 flat schema:
//   events/, timeEntries/, memberships/, eventResponses/, companyPreferences/
//
// The v1 pair of each of these — triggering on the nested
// `Companies/{companyId}/...` schema — has been deleted. They ran alongside
// v2 during the transition because a given write touches exactly one schema,
// so nobody was double-notified; nothing writes v1 documents any more.
//
// NOTE ON DEPLOYING: the v2 functions were deployed under `*V2` names. Those
// names no longer exist in this source, so `firebase deploy --only functions`
// will DELETE the five deployed `*V2` functions and re-point the seven
// plain-named ones at v2 triggers. That is the intended cutover, but it is a
// destructive deploy — read the CLI's delete list before confirming it.
// ---------------------------------------------------------------------------
const { notifyAssignedWorkers } = require("./src/events/notifyAssignedWorkers");
const { notifyEventChanged } = require("./src/events/notifyEventChanged");
const { notifyNewEventWithoutAssignees } = require("./src/availability/notifyNewEventWithoutAssignees");
const { notifyUserStatusChange } = require("./src/availability/notifyUserStatusChange");
const { processNotificationBatches } = require("./src/timesheets/processNotificationBatches");
const { notifyTimeDecision } = require("./src/timesheets/notifyTimeDecision");
const { notifyUserPassage } = require("./src/company/notifyUserPassage");

// Export all functions
module.exports = {
    notifyAssignedWorkers,
    notifyEventChanged,
    notifyNewEventWithoutAssignees,
    notifyUserStatusChange,
    processNotificationBatches,
    notifyTimeDecision,
    notifyUserPassage
};
