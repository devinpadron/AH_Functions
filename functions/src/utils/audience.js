const admin = require("firebase-admin");
const {C} = require("./paths");

/*
 * Who may see an unassigned event.
 *
 * The rules live in the app's WORKER_GROUPS_DESIGN.md, and this file is the
 * server-side restatement of them. They MUST agree: a push is a claim that
 * something is waiting on the availability screen, so notifying someone the
 * screen will not show is worse than not notifying them at all — they open the
 * app to an empty list.
 *
 *                        untargeted event      targeted event
 *   open worker          sees it               only if invited
 *   restricted worker    does not see it       only if invited
 *   manager / owner      sees it               sees it
 *
 * An event's audience is the UNION of `audienceGroupIds` and `audienceUserIds`
 * — groups cover the standing case ("all bartenders"), named users cover the
 * one-off a group cannot express. Someone reachable both ways is returned once.
 */

/** Roles that see every unassigned event, targeted or not. */
const ADMIN_ROLES = ["manager", "owner"];

/**
 * Active members of a company, as full membership documents.
 *
 * Membership ids are `{companyId}_{userId}`, so the user id comes from the
 * `userId` FIELD rather than doc.id. `status` filters out soft-deleted members;
 * v1 deleted the document, v2 keeps it, and an unfiltered query notifies people
 * who have left.
 *
 * @param {string} companyId
 * @param {string[]|null} roles - e.g. ["manager", "owner"], or null for all
 * @returns {Promise<Object[]>} membership documents
 */
async function getCompanyMembers(companyId, roles = null) {
  let query = admin.firestore()
    .collection(C.memberships)
    .where('companyId', '==', companyId)
    .where('status', '==', 'active');

  if (roles) {
    query = query.where('role', 'in', roles);
  }

  const snapshot = await query.get();
  return snapshot.docs.map((doc) => doc.data());
}

/**
 * The members who may see this event, and so may be told it exists.
 *
 * Resolved in memory from the one membership query this function already had to
 * make. The alternative — an `array-contains-any` query per audience group — is
 * more queries, needs its own index, and silently truncates past 30 groups, all
 * to filter a list that is capped at a few hundred members anyway.
 *
 * @param {string} companyId
 * @param {Object} eventData - the event document
 * @returns {Promise<string[]>} user ids
 */
async function getEventAudienceIds(companyId, eventData) {
  const groupIds = (eventData.audienceGroupIds || []).filter(Boolean);
  const namedIds = (eventData.audienceUserIds || []).filter(Boolean);

  /*
   * Targeting is derived from the two lists rather than read from the event's
   * `isTargeted` flag.
   *
   * The flag is denormalized by the app so Firestore can query on it — it is a
   * cache, and this is the thing it caches. Deriving means a stale or missing
   * flag can never widen the audience to the whole company, which is the
   * failure that matters here; the lists themselves are what a manager picked.
   */
  const isTargeted = groupIds.length > 0 || namedIds.length > 0;

  const members = await getCompanyMembers(companyId);
  const audience = new Set();

  for (const member of members) {
    const userId = member.userId;
    if (!userId) continue;

    // Managers and owners see every unassigned event in their company —
    // matching getAvailabilityEvents' `isManager` branch in the app.
    if (ADMIN_ROLES.includes(member.role)) {
      audience.add(userId);
      continue;
    }

    if (isTargeted) {
      const inGroup = (member.groupIds || []).some((id) => groupIds.includes(id));
      if (inGroup || namedIds.includes(userId)) audience.add(userId);
      continue;
    }

    /*
     * Untargeted, so everyone EXCEPT restricted workers.
     *
     * Compared against "restricted" rather than for "open" deliberately. The
     * field is written explicitly on every membership, but if one is ever
     * missing it, absent must mean open — that is the documented default and
     * v1's behaviour, and treating absent as restricted would silence a real
     * worker with nothing on screen to explain it.
     */
    if (member.visibility !== "restricted") audience.add(userId);
  }

  return [...audience];
}

module.exports = {
  getCompanyMembers,
  getEventAudienceIds,
  ADMIN_ROLES
};
