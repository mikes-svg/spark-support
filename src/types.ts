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

/** A Firestore Timestamp (has toDate()) or an ISO date string, as read off a document. */
export type FsTimestamp = { toDate: () => Date } | string;

/**
 * A ticket document, as read by the various views. Fields that only some views
 * populate/read are optional so one shape fits the dashboard, admin, detail,
 * and analytics pages.
 */
export interface Ticket {
  id: string;
  type: string;
  title: string;
  description?: string;
  status: TicketStatus;
  priority: TicketPriority;
  assigneeIds?: string[];
  assigneeId?: string | null;
  submitterId: string;
  participants?: string[];
  createdAt: FsTimestamp;
  updatedAt?: FsTimestamp;
  scheduledFor?: FsTimestamp | null;
}

/**
 * A profile/user document as read for display (a directory entry). `email` and
 * `role` are optional because not every read path needs or fetches them. The
 * Team/Settings forms keep their own stricter shape, and AuthContext keeps its
 * own all-required Profile for the signed-in user.
 */
export interface Profile {
  id: string;
  name: string;
  photoURL: string;
  email?: string;
  role?: Role;
  onboardingAccess?: boolean;
}

/**
 * True if the user can SEE the Property Onboarding section (read-only is enough).
 * Access is per-person: Administrators always have it, everyone else — Managers
 * and Users alike — needs the onboardingAccess flag toggled on from the Team
 * page. Toggling it off removes access for anyone below Administrator.
 */
export function hasOnboardingAccess(profile?: { role?: string | null; onboardingAccess?: boolean } | null): boolean {
  if (!profile) return false;
  return isSuperadminRole(profile.role) || profile.onboardingAccess === true;
}

/**
 * True if the user can EDIT onboarding checklists (statuses, notes, dates, rows).
 * Administrators always can. A granted User can edit; a granted Manager is
 * view-only — so a Manager needs the flag to see onboarding, but never edits it.
 */
export function canEditOnboarding(profile?: { role?: string | null; onboardingAccess?: boolean } | null): boolean {
  if (!profile) return false;
  return isSuperadminRole(profile.role) || (profile.onboardingAccess === true && !isAdminRole(profile.role));
}

// ─── Property onboarding ─────────────────────────────────────────────────────

export type OnboardingStatus = 'Not Started' | 'In Progress' | 'Complete' | 'N/A';

export const ONBOARDING_STATUSES: OnboardingStatus[] = ['Not Started', 'In Progress', 'Complete', 'N/A'];

/** A row of the reusable checklist template that seeds every new property. */
export interface OnboardingTemplateItem {
  id: string;
  section: string;
  order: number;
  code: string;
  /** 1 renders as a sub-item of the row above (mirrors the sheet's indented rows). */
  indent: 0 | 1;
  title: string;
  responsibleIds: string[];
  /** Offset in days from the property's closing date; negative = before closing. */
  daysFromClosing: number | null;
}

/** A property being onboarded — one "tab" in the UI. */
export interface OnboardingProperty {
  id: string;
  name: string;
  /** All property dates are 'YYYY-MM-DD' strings; see src/lib/dates.ts. */
  closingDate: string | null;
  psaExecutionDate: string | null;
  titleCommitmentDate: string | null;
  titleNoticeDate: string | null;
  ddCompletionDate: string | null;
  extension: string;
  archived: boolean;
  createdAt?: FsTimestamp;
  createdBy?: string;
}

/** A record of a due date being pushed back, with the reason the owner gave. */
export interface OnboardingDelay {
  at: string;
  byId: string;
  fromDate: string | null;
  toDate: string | null;
  reason: string;
}

/** One checklist row on one property, instantiated from a template item. */
export interface OnboardingTask {
  id: string;
  propertyId: string;
  section: string;
  order: number;
  code: string;
  indent: 0 | 1;
  title: string;
  responsibleIds: string[];
  daysFromClosing: number | null;
  dueDate: string | null;
  status: OnboardingStatus;
  notes: string;
  delays?: OnboardingDelay[];
}

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
