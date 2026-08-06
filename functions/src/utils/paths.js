/*
 * Firestore collection names.
 *
 * Mirrors src/constants/paths.ts in the AntHill app: lowerCamel plural. The old
 * schema was PascalCase (`Companies`, `Events`), and because collection IDs are
 * case-sensitive those were disjoint collections — which is what let the v1 and
 * v2 functions run side by side through the transition. The v1 functions are
 * gone; nothing in this repo reads a PascalCase collection any more.
 */

const C = {
  users: "users",
  companies: "companies",
  companyPreferences: "companyPreferences",
  memberships: "memberships",
  events: "events",
  eventResponses: "eventResponses",
  timeEntries: "timeEntries",

  /*
   * Batch staging collections.
   *
   * The "V2" suffix is vestigial — it kept this queue apart from the v1
   * `PendingNotifications` while both drainers ran, because the v1 one resolved
   * tokens via `Users/{uid}.fcmToken` and would have silently dropped v2 users'
   * notifications out of a shared queue.
   *
   * KEPT rather than renamed. The drainer runs every five minutes, so renaming
   * these strands whatever is queued at that moment — up to five minutes of
   * real notifications — in order to tidy up a name nobody ever sees.
   */
  pendingNotifications: "PendingNotificationsV2",
  pendingAvailabilityNotifications: "PendingAvailabilityNotificationsV2",
  pendingNewEventNotifications: "PendingNewEventNotificationsV2"
};

/** Deterministic composite ids — must match the app's membershipId/eventResponseId. */
const membershipId = (companyId, userId) => `${companyId}_${userId}`;
const eventResponseId = (eventId, userId) => `${eventId}_${userId}`;

module.exports = {C, membershipId, eventResponseId};
