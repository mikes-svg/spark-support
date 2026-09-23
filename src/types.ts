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

// ─── Property notebooks ──────────────────────────────────────────────────────
// One notebook per property, owned by its creator and private until shared.
// `body` on a page is JSON.stringify(<TipTap doc>) — a string, so Firestore's
// 20-level nesting cap can't reject a deeply-nested rich-text document.

export interface OnboardingNotebook {
  id: string;                 // == the property id (one notebook per property)
  propertyId: string;
  ownerId: string;            // creator uid
  pageOrder: string[];        // page ids in display order
  sharedWithUserIds: string[]; // notebook-level view access
  editorIds: string[];        // notebook-level edit access
  createdAt?: FsTimestamp;
  updatedAt?: FsTimestamp;
}

export interface OnboardingNotebookPage {
  id: string;
  title: string;
  body: string;               // JSON.stringify(<TipTap doc>)
  sharedWithUserIds: string[]; // page-level view access (for users without notebook access)
  editorIds: string[];        // page-level edit access
  createdBy?: string;
  order?: number;             // fallback ordering; pageOrder on the notebook is authoritative
  createdAt?: FsTimestamp;
  updatedAt?: FsTimestamp;
}

/** How a notebook or page is shared with one person. */
export type NotebookShareLevel = 'none' | 'view' | 'edit';

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

// ─── Tasks (ClickUp replacement) ─────────────────────────────────────────────
// A separate collection from `tickets` on purpose: tickets have a fixed
// five-value status enum wired into StatusBadge, the analytics page, the 07:00
// digest, and three email triggers. Tasks carry per-list custom statuses, so
// every piece of logic here keys off `statusType` — NEVER a status label. That
// is what makes a status safe to rename or add without silently breaking
// carryover, digests, metrics, or overdue counts.

/**
 * The semantic kind of a status, independent of what it's called.
 * - `scheduled` — pre-live; hidden from lists/calendar/digests until goLiveDate
 *   (the same mechanic tickets already have; see `isScheduled` above).
 * - `todo` / `active` / `waiting` — live work.
 * - `done` / `closed` — finished; `closed` means "no longer relevant" rather
 *   than "completed", but both count as done for progress and metrics.
 */
export type TaskStatusType = 'scheduled' | 'todo' | 'active' | 'waiting' | 'done' | 'closed';

export type TaskPriority = 'Low' | 'Medium' | 'High' | 'Urgent';

/** One status inside a status set. `color` is a hex string for the pill. */
export interface TaskStatusDef {
  id: string;
  name: string;
  color: string;
  order: number;
  type: TaskStatusType;
}

/** A reusable named collection of statuses, attached to a list. */
export interface TaskStatusSet {
  id: string;
  name: string;
  statuses: TaskStatusDef[];
}

/** Top level of the hierarchy: Space → List. Two levels, not three. */
export interface TaskSpace {
  id: string;
  name: string;
  order: number;
  archived: boolean;
}

export interface TaskList {
  id: string;
  spaceId: string;
  name: string;
  order: number;
  archived: boolean;
  /** Which status set this list's tasks use. Null falls back to the seeded default. */
  defaultStatusSetId: string | null;
}

export interface TaskTag {
  id: string;
  name: string;
  color: string;
}

/**
 * A checklist item on a task. Stored as an array field on the task, not a
 * subcollection — subtasks are always read and written with their parent.
 */
export interface Subtask {
  id: string;
  title: string;
  done: boolean;
  doneAt?: FsTimestamp | null;
  doneBy?: string | null;
  assigneeIds?: string[];
  /** 'YYYY-MM-DD'; see src/lib/dates.ts. */
  dueDate?: string | null;
  order: number;
  /** Set by `carry-unfinished` recurrence, so the UI can mark it as carried over. */
  carriedFromTaskId?: string | null;
}

export interface Task {
  id: string;
  listId: string;
  /** Denormalized from the list so space-wide queries don't need a join. */
  spaceId: string;
  title: string;
  /** JSON.stringify(<TipTap doc>) — a STRING, like notebook pages, so Firestore's
   *  20-level nesting cap can't reject a deeply-nested rich-text description. */
  description?: string;
  /** Status is denormalized onto the task: the id points at the set, the name
   *  renders without a lookup, and the type is what every query filters on. */
  statusId: string;
  statusName: string;
  statusType: TaskStatusType;
  /** Who the work is blocked on — replaces ClickUp's person-named statuses
   *  (PENDING EDITA / PENDING CHLOE'), which broke whenever staff changed. */
  waitingOnUserId?: string | null;
  priority: TaskPriority | null;
  assigneeIds: string[];
  creatorId: string;
  watcherIds: string[];
  /** creator + assignees + watchers, deduped. Gates writes in firestore.rules. */
  participants: string[];
  /** Calendar days as 'YYYY-MM-DD' strings — never Date objects. */
  startDate: string | null;
  dueDate: string | null;
  /** Optional 'HH:mm' for timed calendar events; a bare dueDate is all-day. */
  dueTime?: string | null;
  /** A `scheduled` task goes live on this date. */
  goLiveDate?: string | null;
  tagIds: string[];
  subtasks: Subtask[];
  /** Manual sort position within its list (see the listId+order index). */
  order?: number;
  seriesId?: string | null;
  /** Deterministic per-occurrence key (e.g. '2026-10-15'); with seriesId it
   *  forms the doc id, so a retried generator run cannot duplicate. */
  occurrenceKey?: string | null;
  gcalEventId?: string | null;
  gcalSyncedAt?: FsTimestamp | null;
  completedAt?: FsTimestamp | null;
  createdAt?: FsTimestamp;
  updatedAt?: FsTimestamp;
}

/**
 * What `createTask` accepts: the three fields a task can't exist without, plus
 * any other task field. Everything omitted is defaulted by src/lib/tasks.ts.
 */
export type TaskInput = Pick<Task, 'listId' | 'spaceId' | 'title' | 'creatorId'> &
  Partial<Omit<Task, 'id' | 'listId' | 'spaceId' | 'title' | 'creatorId' | 'participants'>>;

/** Attachment metadata doc under `tasks/{taskId}/attachments`. Unlike tickets
 *  (which list through a callable), tasks record uploads in Firestore, so
 *  delete, uploader attribution, and size display need no function round-trip. */
export interface TaskAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  storagePath: string;
  url: string;
  uploadedBy: string;
  uploadedAt?: FsTimestamp;
}

export interface TaskComment {
  id: string;
  taskId: string;
  userId: string;
  body: string;
  mentionedIds: string[];
  createdAt?: FsTimestamp;
  editedAt?: FsTimestamp | null;
}

export type TaskEventType =
  | 'created'
  | 'status_changed'
  | 'priority_changed'
  | 'assignees_changed'
  | 'due_date_changed'
  | 'subtask_toggled'
  | 'commented'
  | 'activated'
  | 'occurrence_created'
  | 'missed_occurrence'
  | 'reassigned';

/** Audit-log entry. Append-only: rules forbid update and delete. */
export interface TaskEvent {
  id: string;
  taskId: string;
  type: TaskEventType;
  actorId: string;
  fromStatusId?: string | null;
  toStatusId?: string | null;
  fromStatusType?: TaskStatusType | null;
  toStatusType?: TaskStatusType | null;
  fromPriority?: TaskPriority | null;
  toPriority?: TaskPriority | null;
  fromAssigneeIds?: string[];
  toAssigneeIds?: string[];
  fromDueDate?: string | null;
  toDueDate?: string | null;
  subtaskId?: string | null;
  /** Free-text detail for summary events (mass reassign, missed occurrence). */
  note?: string | null;
  createdAt?: FsTimestamp;
}

// ─── Recurrence ──────────────────────────────────────────────────────────────
// Recurrence MATH lives server-side in functions/recurrence.js; these types only
// describe the stored definition. The client never recomputes occurrences — two
// copies of date math is how such features silently drift apart.

export type TaskRecurrenceFreq = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'yearly' | 'custom';

export interface TaskSeriesRecurrence {
  freq: TaskRecurrenceFreq;
  interval: number;
  /** 0=Sunday … 6=Saturday. Weekly / biweekly. */
  byWeekday?: number[];
  dayOfMonth?: number | 'last';
  monthlyMode?: 'day-of-month' | 'nth-weekday';
}

/** Mirrors ClickUp's "Include in new task" checkboxes. */
export interface TaskCopyOnRecur {
  description: boolean;
  subtasks: boolean;
  subtaskAssignees: boolean;
  remapSubtaskDates: boolean;
  assignees: boolean;
  watchers: boolean;
  comments: boolean;
  tags: boolean;
  /** false = each occurrence gets a fresh, unchecked subtask list. */
  keepCheckedItems: boolean;
  /** `reset` is ClickUp parity; `carry-unfinished` drags undone items forward
   *  and is bounded at 3 consecutive carries before the UI/digest flags it. */
  carryMode: 'reset' | 'carry-unfinished';
  attachments: boolean;
  activity: boolean;
}

/** What to do when the current occurrence is still open as the next falls due. */
export type TaskMissedPolicy = 'skip-to-next' | 'accumulate' | 'keep-one-open';

export interface TaskSeries {
  id: string;
  name: string;
  /** The task fields each occurrence is minted from, plus the subtask template. */
  payload: Partial<Omit<Task, 'id' | 'subtasks'>> & {
    subtaskTemplate?: { title: string; order: number }[];
  };
  recurrence: TaskSeriesRecurrence;
  /** DEFAULT 'on-completion': the next occurrence appears when someone finishes
   *  the current one, which is how the audited ClickUp series were configured. */
  trigger: 'on-completion' | 'on-schedule';
  /** ClickUp's "Update status to: TO DO". */
  resetStatusTo: string;
  skipWeekends: boolean;
  weekendShift: 'next' | 'previous';
  startOffsetDays: number;
  copyOnRecur: TaskCopyOnRecur;
  missedPolicy: TaskMissedPolicy;
  endDate?: string | null;
  occurrenceLimit?: number | null;
  active: boolean;
  timezone: string;
  creatorId: string;
  createdAt?: FsTimestamp;
  updatedAt?: FsTimestamp;
}

/** A saved set of tasks a user can instantiate at once, dated off a start day. */
export interface TaskTemplate {
  id: string;
  name: string;
  tasks: (Partial<Omit<Task, 'id'>> & { title: string; dueOffsetDays: number | null })[];
  createdBy?: string;
  createdAt?: FsTimestamp;
}

/**
 * The composable filter every task list view passes to `listTasks`. Every field
 * is optional and they AND together. Which parts run as Firestore constraints
 * and which are applied in memory is documented on `listTasks` itself.
 */
export interface TaskFilter {
  spaceId?: string | null;
  listId?: string | null;
  assigneeIds?: string[];
  statusTypes?: TaskStatusType[];
  tagIds?: string[];
  priorities?: TaskPriority[];
  seriesId?: string | null;
  /** Inclusive 'YYYY-MM-DD' bounds on dueDate. */
  dueFrom?: string | null;
  dueTo?: string | null;
  /** Default false — done/closed tasks are hidden unless asked for. */
  includeDone?: boolean;
  /** Default false — `scheduled` tasks stay hidden until they go live. */
  includeScheduled?: boolean;
  /** Case-insensitive substring match on the title, applied in memory. */
  search?: string;
  limit?: number;
}

// ─── Task predicates ─────────────────────────────────────────────────────────
// All four key off `statusType` ONLY. Never compare a status label here: labels
// are per-list, renameable, and were named after people in the old system.

/** Finished: completed or closed-as-irrelevant. Both stop counting as work. */
export function isTaskDone(task: { statusType?: string | null }): boolean {
  return task.statusType === 'done' || task.statusType === 'closed';
}

/** Live work — shows in lists, the calendar, and digests. Excludes both
 *  not-yet-live (`scheduled`) and finished tasks. */
export function isTaskLive(task: { statusType?: string | null }): boolean {
  return task.statusType === 'todo' || task.statusType === 'active' || task.statusType === 'waiting';
}

/** Blocked on someone else (pair with `waitingOnUserId` to say who). */
export function isTaskWaiting(task: { statusType?: string | null }): boolean {
  return task.statusType === 'waiting';
}

/**
 * Past due. `today` is a 'YYYY-MM-DD' string from `todayStr()` — passed in
 * rather than read here so this module stays dependency-free and so a whole
 * list renders against one consistent "today".
 *
 * Strictly before today, matching isOverdue() in src/lib/onboarding.ts: a task
 * due today is not yet late. Finished and not-yet-live tasks are never overdue.
 */
export function isTaskOverdue(
  task: { statusType?: string | null; dueDate?: string | null },
  today: string,
): boolean {
  if (!task.dueDate || !today) return false;
  if (isTaskDone(task) || task.statusType === 'scheduled') return false;
  return task.dueDate < today;
}
