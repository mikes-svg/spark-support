import { isAdminRole, getAssigneeIds } from '../types';
import type { Profile, Ticket } from '../types';

/**
 * The rule that keeps tickets accountable: a ticket with any assignees must
 * always have at least one Manager or Administrator among them.
 *
 * Users can now be assigned tickets and work them, which is the point — but
 * without this, anyone could hand a ticket to a User and take themselves off
 * it, leaving work with nobody answerable for it. The guard applies to
 * Managers too, not just Users; "I reassigned it and left" is the failure mode
 * either way.
 *
 * Enforced in two places, deliberately:
 *  - here, so the UI can disable the control and say why; and
 *  - in firestore.rules, so it holds for anything that isn't this UI.
 * The rules copy reads `meta/adminIds` (kept current by the syncAdminIds
 * function) because rules cannot look up a role per assignee.
 */

export const LAST_MANAGER_MESSAGE =
  'Every ticket needs at least one Manager or Administrator assigned. Add another before removing this one.';

/** True for the roles that can be a ticket's accountable owner. */
export function isManagerRole(role?: string | null): boolean {
  return isAdminRole(role);
}

/** The subset of `ids` whose profiles are Managers or Administrators. */
export function managerIdsAmong(ids: string[], profiles: Record<string, Profile>): string[] {
  return ids.filter((id) => isManagerRole(profiles[id]?.role));
}

/**
 * Would the ticket still satisfy the invariant with this assignee list?
 *
 * An empty list passes: an unassigned ticket is a normal state, and the triage
 * queue depends on it. The rule only bites once somebody is assigned.
 */
export function assigneesAreValid(ids: string[], profiles: Record<string, Profile>): boolean {
  if (ids.length === 0) return true;
  return managerIdsAmong(ids, profiles).length > 0;
}

/**
 * Ids that must not be removable from the current selection — i.e. the sole
 * remaining Manager. Returns an empty array when removal is unconstrained, so
 * callers can spread it straight into a `lockedIds` prop.
 */
export function lockedAssigneeIds(ids: string[], profiles: Record<string, Profile>): string[] {
  if (ids.length === 0) return [];
  const managers = managerIdsAmong(ids, profiles);
  return managers.length === 1 ? managers : [];
}

/** Convenience for a loaded ticket. */
export function lockedAssigneeIdsForTicket(
  ticket: Pick<Ticket, 'assigneeIds' | 'assigneeId'>,
  profiles: Record<string, Profile>,
): string[] {
  return lockedAssigneeIds(getAssigneeIds(ticket), profiles);
}
