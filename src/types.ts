export type Role = 'superadmin' | 'admin' | 'user';

/** True for admin or superadmin — i.e. anyone who can access admin pages. */
export function isAdminRole(role?: string | null): boolean {
  return role === 'admin' || role === 'superadmin';
}

/** True only for superadmin — the only role that can delete tickets. */
export function isSuperadminRole(role?: string | null): boolean {
  return role === 'superadmin';
}

/**
 * Human-facing label for a role. The stored values stay 'superadmin' | 'admin'
 * | 'user'; only the display name changes: superadmin → "Administrator",
 * admin → "Manager".
 */
export function roleLabel(role?: string | null): string {
  if (role === 'superadmin') return 'Administrator';
  if (role === 'admin') return 'Manager';
  return 'User';
}
// 'Scheduled' is a pre-live state: the ticket exists but has a future go-live
// date and behaves as if it hasn't been submitted yet. A Cloud Function flips
// it to 'Open' (sending assignee emails, resetting createdAt) on the go-live
// date. It is intentionally NOT offered in the manual status dropdowns.
export type TicketStatus = 'Open' | 'In Progress' | 'On Hold' | 'Resolved' | 'Scheduled';
export type TicketPriority = 'Low' | 'Medium' | 'High' | 'Urgent';

/** True if a ticket is scheduled for a future go-live and not yet live. */
export function isScheduled(ticket: { status?: string | null }): boolean {
  return ticket.status === 'Scheduled';
}

/** Backward-compat: read assignees as an array, supporting old `assigneeId` string field. */
export function getAssigneeIds(ticket: { assigneeIds?: string[] | null; assigneeId?: string | null }): string[] {
  if (Array.isArray(ticket.assigneeIds)) return ticket.assigneeIds.filter(Boolean);
  if (ticket.assigneeId) return [ticket.assigneeId];
  return [];
}

/** Backward-compat: read default assignees as an array, supporting old `defaultAssigneeId` string field. */
export function getDefaultAssigneeIds(rt: { defaultAssigneeIds?: string[] | null; defaultAssigneeId?: string | null }): string[] {
  if (Array.isArray(rt.defaultAssigneeIds)) return rt.defaultAssigneeIds.filter(Boolean);
  if (rt.defaultAssigneeId) return [rt.defaultAssigneeId];
  return [];
}
