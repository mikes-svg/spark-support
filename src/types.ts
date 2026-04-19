export type Role = 'superadmin' | 'admin' | 'user';

/** True for admin or superadmin — i.e. anyone who can access admin pages. */
export function isAdminRole(role?: string | null): boolean {
  return role === 'admin' || role === 'superadmin';
}

/** True only for superadmin — the only role that can delete tickets. */
export function isSuperadminRole(role?: string | null): boolean {
  return role === 'superadmin';
}
export type TicketStatus = 'Open' | 'In Progress' | 'On Hold' | 'Resolved';
export type TicketPriority = 'Low' | 'Medium' | 'High' | 'Urgent';

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
