# Tasks (ClickUp migration) — pinned contract

Coordination file for the tasks swarm. **Do not edit files you don't own.**
Need a change to anything here? Append a request under "Change requests" and
return `BLOCKED` — don't edit the shared file yourself.

The foundation is landed and green: `npx tsc --noEmit`, `npm run lint`,
`npm run build`, and `npm test` all exit 0. Every route below resolves, every
type below exists, and every component below is importable today — as a typed
stub where the lane hasn't built it yet. Build against the stubs; don't wait.

Spec: `docs/CLICKUP_MIGRATION_PLAN.md` (referenced below as §n). Where this file
and the plan disagree, **this file wins** — it is what the code actually is.

---

## The rule that matters most

> Every piece of logic — carryover, digests, metrics, overdue counts, filters,
> styling — keys off **`statusType`**, never a status label.

Statuses are per-list and user-editable. The old system had statuses named
`PENDING EDITA` and `PENDING CHLOE'`; they broke the moment someone changed
role. `statusType` is `'scheduled' | 'todo' | 'active' | 'waiting' | 'done' |
'closed'`, and the four predicates in `src/types.ts` are the only sanctioned way
to ask a task how it's doing:

```ts
isTaskDone(task)                 // statusType is 'done' or 'closed'
isTaskLive(task)                 // 'todo' | 'active' | 'waiting'
isTaskWaiting(task)              // 'waiting'  (pair with waitingOnUserId)
isTaskOverdue(task, today)       // dueDate < today, and not done/scheduled
```

`today` is always a `'YYYY-MM-DD'` string from `todayStr()`, passed in so a whole
list renders against one consistent day.

---

## House rules (non-negotiable, inherited from the existing codebase)

- **Calendar days are `'YYYY-MM-DD'` strings**, via `src/lib/dates.ts`. Never
  `new Date(dateStr)` on one — it parses as UTC midnight and renders a day early
  in US timezones.
- **Clients never write to the `mail` collection.** Rules forbid it. All email is
  server-side, from Cloud Functions, with user text HTML-escaped.
- **Mutations are optimistic**: apply locally, roll back on failure, surface an
  `actionError` banner. See `TicketDetailPage.tsx` / `OnboardingPropertiesPage.tsx`.
- **No new npm dependencies.** Charts are hand-rolled SVG, like `AnalyticsPage.tsx`.
- **Mobile**: tap targets ≥ 44px; the sidebar is a drawer under `md`.
- Tokens: `brand-dark` (#064923), `brand-gold`, `brand-cream`, `font-serif`.
- Comments explain **why**, not what. Match the density of the file you're in.

---

## Firestore collections (LANDED — shapes in `src/types.ts`)

| Collection | Doc shape | Notes |
|---|---|---|
| `tasks` | `Task` | The one collection the whole feature hangs off. |
| `tasks/{id}/attachments` | `TaskAttachment` | Metadata written client-side on upload. |
| `taskComments` | `TaskComment` | Flat, not a subcollection (mirrors `comments`). |
| `taskEvents` | `TaskEvent` | Append-only audit log. |
| `taskSpaces` | `TaskSpace` | Level 1 of the hierarchy. |
| `taskLists` | `TaskList` | Level 2. There is no third level (§3). |
| `taskStatusSets` | `TaskStatusSet` | Holds `TaskStatusDef[]`. |
| `taskTags` | `TaskTag` | Phase 7; the collection exists now. |
| `taskSeries` | `TaskSeries` | Recurring definitions (§4). |
| `taskTemplates` | `TaskTemplate` | Named bundles of tasks. |

Storage: `taskAttachments/{taskId}/{filename}` — 200MB, `image/* | video/* |
application/pdf | application/vnd.* | text/*`.

### `Task` (the fields you will actually touch)

```ts
interface Task {
  id: string;
  listId: string; spaceId: string;          // spaceId denormalized for queries
  title: string;
  description?: string;                     // JSON.stringify(<TipTap doc>) — a STRING
  statusId: string; statusName: string; statusType: TaskStatusType;  // denormalized
  waitingOnUserId?: string | null;          // replaces PENDING <person>
  priority: 'Low'|'Medium'|'High'|'Urgent' | null;
  assigneeIds: string[]; creatorId: string; watcherIds: string[];
  participants: string[];                   // creator + assignees + watchers — gates writes
  startDate: string | null; dueDate: string | null;   // 'YYYY-MM-DD'
  dueTime?: string | null;                  // 'HH:mm', optional
  goLiveDate?: string | null;               // a 'scheduled' task goes live here
  tagIds: string[]; subtasks: Subtask[]; order?: number;
  seriesId?: string | null; occurrenceKey?: string | null;
  gcalEventId?: string | null; gcalSyncedAt?: FsTimestamp | null;
  completedAt?: FsTimestamp | null; createdAt?: FsTimestamp; updatedAt?: FsTimestamp;
}
```

Also exported and pinned: `TaskStatusType`, `TaskPriority`, `TaskStatusDef`,
`TaskStatusSet`, `TaskSpace`, `TaskList`, `TaskTag`, `Subtask`, `TaskInput`,
`TaskAttachment`, `TaskComment`, `TaskEventType`, `TaskEvent`,
`TaskRecurrenceFreq`, `TaskSeriesRecurrence`, `TaskCopyOnRecur`,
`TaskMissedPolicy`, `TaskSeries`, `TaskTemplate`, `TaskFilter`.

**Do not redefine any of these locally.** Import from `../types`.

---

## `src/lib/tasks.ts` (LANDED — consume, do not redefine)

```ts
TASKS = 'tasks'                TASK_LISTS = 'taskLists'        TASK_SPACES = 'taskSpaces'
TASK_STATUS_SETS = 'taskStatusSets'   TASK_SERIES = 'taskSeries'   TASK_TEMPLATES = 'taskTemplates'

createTask(input: TaskInput): Promise<Task>
updateTask(id: string, patch: Partial<Task>): Promise<void>
deleteTask(id: string): Promise<void>
getTask(id: string): Promise<Task | null>
listTasks(filter: TaskFilter): Promise<Task[]>
setStatus(id: string, statusId: string, actorId: string): Promise<void>
toggleSubtask(id: string, subtaskId: string, done: boolean, actorId: string): Promise<void>
canEditTask(uid, task: {participants?, creatorId?}, profile?: {role?}): boolean
participantsOf(task: {creatorId?, assigneeIds?, watcherIds?}): string[]
```

That is the **complete** export list. Behaviour you can rely on:

- `createTask` resolves the status off the list's status set when you don't pass
  one, derives `participants`, and commits the task **and** its `created` audit
  event in one atomic `WriteBatch`.
- `updateTask` re-derives `participants` whenever `assigneeIds`, `watcherIds`, or
  `creatorId` are in the patch, and drops `undefined` values. It writes **no**
  audit event — log one yourself when the change deserves history.
- `setStatus` resolves the label and type off the set (so the denormalized copy
  can't disagree), stamps/clears `completedAt`, and writes a `status_changed`
  event atomically. It no-ops when the status is unchanged.
- `toggleSubtask` rewrites the whole `subtasks` array; `doneAt` is an ISO
  **string**, because Firestore refuses sentinel values inside arrays.
- `deleteTask` removes the task doc **only**. Comments, events, and attachment
  metadata are not cascaded — that's a server-side job nobody has built yet.
- `listTasks` runs **one** filter field as the Firestore constraint (precedence:
  `seriesId` → `listId` → `assigneeIds` → `tagIds` → `spaceId` → `statusTypes`,
  each paired with the sort its composite index covers) and applies the rest in
  memory. `limit` is a display cap, not a read cap. Results come back soonest-due
  first, undated last, then by `order`.

## `src/lib/taskStatuses.ts` (LANDED)

```ts
STATUS_SETS_COLLECTION = 'taskStatusSets'
DEFAULT_STATUS_SET: Omit<TaskStatusSet, 'id'>   // To Do / In Progress / Waiting On / Complete / Closed
getOrSeedStatusSets(): Promise<TaskStatusSet[]>       // modelled on getOrSeedRequestTypes
statusDefOf(setOrList, statusId): TaskStatusDef | null
statusTypeOf(setOrList, statusId): TaskStatusType | null   // null for an unknown id
defaultStatusFor(setOrList): TaskStatusDef | null          // lowest-ordered 'todo'
```

`setOrList` accepts a whole `TaskStatusSet` or just a `TaskStatusDef[]`.

**Known gap, by design:** the default set ships **without** a `scheduled`-typed
status. `TaskStatusType` supports one; add it per set from Task Settings (lane 7)
before shipping pre-live tasks. Don't hard-code a sixth status into the default.

---

## Shared presentational components (LANDED — finished, read-only)

`src/components/tasks/shared/` — lanes 1 and 4 both consume these. They are pure:
no Firestore, no mutations.

```ts
TaskStatusPill   { name: string; type: TaskStatusType; color?: string | null; className?: string }
TaskPriorityPill { priority: TaskPriority | null | undefined; className?: string }   // null renders nothing
TaskTagPill      { tag: TaskTag; className?: string }
SubtaskProgress  { subtasks: Subtask[] | null | undefined; compact?: boolean; className?: string }
DueDateLabel     { dueDate: string|null|undefined; today: string; statusType: TaskStatusType;
                   dueTime?: string|null; showEmpty?: boolean; className?: string }
TaskRow          { task: Task; today: string;
                   people?: Record<string, Profile>; tags?: Record<string, TaskTag>;
                   contextLabel?: string; to?: string; onOpen?: (taskId: string) => void;
                   variant?: 'default' | 'compact'; className?: string }
```

`TaskRow` renders a `<Link>` to `/tasks/:id` unless `onOpen` is given, in which
case it renders a `<button>`.

---

## Component interfaces (STUBS — final prop types, empty bodies)

Each file below exists, exports the named component and its props interface, and
renders a small "coming soon" placeholder. Fill the body; **keep the props**.

```ts
// src/components/tasks/
TaskComments      { taskId: string; canComment?: boolean }
TaskActivity      { taskId: string; initialCount?: number }
TaskAttachments   { taskId: string; canEdit: boolean }
RecurrenceEditor  { value: <series settings> | null; onChange: (value) => void; disabled?: boolean }
TaskFilters       { value: TaskFilter; onChange: (v: TaskFilter) => void;
                    lists: TaskList[]; statusSets: TaskStatusSet[]; people: Profile[];
                    hide?: ('list'|'space'|'assignee'|'status'|'priority'|'due'|'tag'|'search')[] }
TaskEditor        { task: Task; canEdit: boolean; lists: TaskList[];
                    statusSet: TaskStatusSet | null; people: Profile[]; tags?: TaskTag[];
                    onChange: (patch: Partial<Task>) => void | Promise<void> }
TaskCreateModal   { open: boolean; onClose: () => void; lists: TaskList[];
                    statusSets: TaskStatusSet[]; people: Profile[];
                    defaultListId?: string | null; defaultDueDate?: string | null;
                    onCreated: (task: Task) => void }
SubtaskEditor     { subtasks: Subtask[]; canEdit: boolean; people?: Profile[];
                    onToggle: (subtaskId: string, done: boolean) => void | Promise<void>;
                    onChange: (subtasks: Subtask[]) => void | Promise<void> }
CalendarGrid      { month: string /* 'YYYY-MM' */; tasks: Task[]; today: string;
                    people?: Record<string, Profile>;
                    onSelectDate?: (date: string) => void; onOpenTask?: (taskId: string) => void }
WorkloadChart     { rows: WorkloadRow[]; metric?: 'open'|'overdue'|'dueThisWeek'|'completed30d' }
WorkloadRow       { userId; name; open; overdue; dueThisWeek; completed30d;
                    recurringCompliance: number | null }
```

`RecurrenceEditor` is controlled and must **not** compute occurrences — the
preview calls `previewRecurrence`. Recurrence math exists once, server-side.

---

## Routes (LANDED in `src/App.tsx` — no lane edits this file)

| Path | Page component | File | Guard |
|---|---|---|---|
| `/tasks` | `TasksPage` | `src/pages/TasksPage.tsx` | signed in |
| `/tasks/all` | `TeamTasksPage` | `src/pages/TeamTasksPage.tsx` | signed in |
| `/tasks/calendar` | `TaskCalendarPage` | `src/pages/TaskCalendarPage.tsx` | signed in |
| `/tasks/templates` | `TaskTemplatesPage` | `src/pages/TaskTemplatesPage.tsx` | signed in |
| `/tasks/:id` | `TaskDetailPage` | `src/pages/TaskDetailPage.tsx` | signed in |
| `/admin/workload` | `WorkloadPage` | `src/pages/WorkloadPage.tsx` | admin |
| `/admin/tasks` | `TaskSettingsPage` | `src/pages/admin/TaskSettingsPage.tsx` | superadmin |
| `/admin/reassign` | `ReassignPage` | `src/pages/admin/ReassignPage.tsx` | superadmin |
| `/settings/calendar` | `CalendarSyncSettingsPage` | `src/pages/CalendarSyncSettingsPage.tsx` | signed in |

Every page is a **named** export, lazy-imported by name. Renaming an export
breaks the route, and no lane owns `App.tsx`. `src/App.routes.test.ts` walks all
nine imports on every `npm test`, so a rename fails in CI rather than in the
sidebar — if that test goes red, fix the export name, not the test.

Sidebar (LANDED): `My Tasks`, `Team Tasks`, `Calendar` in **User**; `Workload`
(admin), `Task Settings`, `Reassign Work` (superadmin) in **Admin**. Onboarding's
old "My Tasks" entry is now **"Onboarding Tasks"** — label only, route unchanged.

**Open gap — the app header title.** `getPageTitle()` in
`src/components/Layout.tsx` maps pathname → the title in the top bar, and has no
entry for any `/tasks`, `/admin/workload`, `/admin/tasks`, `/admin/reassign`, or
`/settings/calendar` path, so those pages show the fallback **"Portal"**. Layout
is shared and outside every lane's fence; it needs nine one-line additions whose
labels must match the sidebar exactly. Raise it as a change request — don't
work around it by rendering a second `<h1>` inside your page, which would leave
the screen with two primary headings.

---

## Cloud Functions

`functions/index.js` is **re-exports only** (Phase 0 split, landed). Implementations:

| Module | Holds |
|---|---|
| `shared.js` | `admin.initializeApp()`, `db`, `REGION`, `APP_URL`, `escapeHtml`, `emailsForAssignees`, `sendMail`, `getAssigneeIds`, `todayInTimeZone`, `daysBetweenDateStrings` |
| `profile.js` | `ensureProfile`, `getTicketAttachments` |
| `tickets.js` | `sendTicketReminders`, `activateScheduledTickets`, `onTicketCreated`, `onTicketUpdated`, `onCommentCreated` |
| `onboarding.js` | `sendOnboardingReminders` |

**Adding a function means adding a module and re-exporting it from `index.js`.**
Firebase deploys by export name: renaming one deletes the deployed function and
creates a new one, losing its schedule and pending retries. Never rename.

### Callables and scheduled functions the lanes will add

| Name | Kind | Signature / schedule | Lane |
|---|---|---|---|
| `previewRecurrence` | callable | `({ recurrence, trigger, skipWeekends, weekendShift, from?: 'YYYY-MM-DD', count?: number }) → { occurrences: string[] }` | 3 |
| `generateRecurringTasks` | scheduled | daily **06:00 America/Chicago** (one hour before the 07:00 digest) | 3 |
| `activateScheduledTasks` | — | **generalize the existing `activateScheduledTickets`** to cover both collections rather than writing a second copy (§4) | 1 |
| `onTaskCreated` | trigger | `tasks/{taskId}` created | 5 |
| `onTaskUpdated` | trigger | `tasks/{taskId}` updated — status change, new assignee, due-date change | 5 |
| `onTaskCommentCreated` | trigger | `taskComments/{commentId}` created — participants + @mentions | 5 |
| `sendMorningBrief` | scheduled | daily **07:00** — the consolidated tickets + onboarding + tasks digest (§7). Replaces `sendTicketReminders` and `sendOnboardingReminders`; **coordinate before deleting either** | 5 |
| `reassignWork` | callable | `({ fromUserId, toUserIds: string[], scope, statuses }) → { updated: number }`, 400-write chunked batches, **one** summary audit event and **one** summary email per new assignee | 7 |
| `gcalConnect` / `gcalDisconnect` | callable | OAuth handshake; refresh tokens server-side only, never in the client bundle | 6 |
| `gcalWebhook` | https | `events.watch` push channel receiver; loop suppression via `gcalSyncedAt` | 6 |

Robustness pattern for anything that mints occurrences: **deterministic doc ids**
(`${seriesId}_${occurrenceKey}`) and **one atomic `WriteBatch` per record**, with
per-item failures isolated — copied from `activateScheduledTickets`.

---

## Security rules and indexes (LANDED)

```
tasks              read: signed in
                   create: creatorId == uid
                   update: participant || isAdmin()
                   delete: creator || isSuperAdmin()
tasks/{id}/attachments  read signed in; create if uploadedBy == uid; update never;
                        delete if uploader or admin
taskComments       read signed in; create if userId == uid; author-only update with
                   userId/taskId/createdAt pinned; delete author or superadmin
taskEvents         read signed in; create if actorId == uid; update/delete NEVER
taskSpaces / taskLists / taskStatusSets / taskTemplates / taskTags
                   read signed in; write superadmin
taskSeries         read signed in; write creator or admin
```

Task read access is **open to every signed-in user** by decision (§2) — the
opposite of tickets, which are private to their participants. That asymmetry is
deliberate. Don't "harmonize" it.

Composite indexes deployed: `tasks` assigneeIds+dueDate · listId+order ·
statusType+dueDate · seriesId+occurrenceKey · spaceId+dueDate · tagIds+dueDate;
`taskComments` taskId+createdAt; `taskEvents` taskId+createdAt.

**A query that needs an index not on that list is a change request**, not a
reason to write the query and hope.

---

## Lane ownership

Lane numbers match the phase numbers in §12 of the plan.

| Lane | Phase | Owns (create/edit only these) |
|---|---|---|
| **Foundation** | 0–1 | everything under "Shared" below |
| **1 — Tasks core** | 1 | `src/pages/TasksPage.tsx`, `src/pages/TaskDetailPage.tsx`, `src/components/tasks/TaskEditor.tsx`, `TaskCreateModal.tsx`, `SubtaskEditor.tsx` |
| **2 — Comments & files** | 2 | `src/components/tasks/TaskComments.tsx`, `TaskActivity.tsx`, `TaskAttachments.tsx`, `src/lib/taskEvents.ts` (new) |
| **3 — Recurrence** | 3 | `src/components/tasks/RecurrenceEditor.tsx`, `src/pages/TaskTemplatesPage.tsx`, `functions/recurrence.js`, `functions/tasks.js` (new) |
| **4 — Views** | 4 | `src/pages/TeamTasksPage.tsx`, `src/pages/TaskCalendarPage.tsx`, `src/components/tasks/CalendarGrid.tsx`, `TaskFilters.tsx` |
| **5 — Notifications & workload** | 5 | `src/pages/WorkloadPage.tsx`, `src/components/tasks/WorkloadChart.tsx`, `functions/digest.js` (new) |
| **6 — Google Calendar** | 6 | `src/pages/CalendarSyncSettingsPage.tsx`, `functions/gcal.js` (new) |
| **7 — Admin** | 7 | `src/pages/admin/TaskSettingsPage.tsx`, `src/pages/admin/ReassignPage.tsx` |

**Shared (foundation-owned, everyone else read-only):** `src/types.ts`,
`src/lib/tasks.ts`, `src/lib/taskStatuses.ts`, `src/components/tasks/shared/*`,
`src/App.tsx`, `src/components/Sidebar.tsx`, `src/components/Layout.tsx`,
`firestore.rules`, `firestore.indexes.json`, `storage.rules`, `package.json`,
`vitest.config.ts`, `functions/index.js`, `functions/shared.js`,
`functions/tickets.js`, `functions/onboarding.js`, `functions/profile.js`,
and this file.

Lanes 3, 5, and 6 add **new** files under `functions/` and must re-export them
from `functions/index.js` — which is shared. That one edit is a change request;
batch it with everything else your lane needs from `index.js`.

## Existing patterns to reuse

- `useAuth()` → `{ user }`; `user.id` is the uid, `user.role` the role.
- `Modal` / `ConfirmModal` / `PageSpinner` / `Avatar` / `AssigneeSelector` /
  `MentionTextarea` in `src/components/`.
- `src/pages/TicketDetailPage.tsx` — detail layout, comments, inline edit.
- `src/pages/DashboardPage.tsx` — list with composable filters.
- `src/pages/AnalyticsPage.tsx` — hand-rolled SVG charts. There is no chart library.
- `src/lib/onboarding.ts` — chunked batch writes (`BATCH_LIMIT` 400).
- `src/lib/ticketEvents.ts` — audit helpers that never throw.

---

## Change requests
_(append here, then return BLOCKED)_

- **Lane 2 (non-blocking FYI, not returning BLOCKED — Phase 2 shipped without it).**
  `TaskEventType` in `src/types.ts` doesn't include `attachment_added` or
  `carried_over`, and uses `subtask_toggled` rather than `subtask_completed`.
  `src/lib/taskEvents.ts` and `TaskAttachments.tsx` were built against the
  pinned union as-is (no event is logged for an attachment upload; the
  metadata doc under `tasks/{id}/attachments` is the durable record). If a
  later lane (5 — digest/metrics, or 3 — recurrence for `carried_over`) wants
  an audit trail for uploads or carryovers, add the variant(s) to
  `TaskEventType` and I'm happy to wire the call site.
### Lane 3 (Recurrence) — 2026-09-23

Phase 3 is written and its DONE-CHECK is green (`tsc`, `lint`, `build`, `test`,
`node --check` all exit 0). Four shared files need a change before it is wired up
and before its tests actually run in CI. Lane 3 has edited none of them.

**CR-3.1 — `functions/index.js`: the re-exports are missing.** The lane brief said
foundation had already added them; `index.js` currently requires only `profile`,
`tickets`, and `onboarding`. Nothing Phase 3 wrote is deployed until these land.
Module names differ from the `functions/tasks.js` placeholder in the table above —
the work split into a recurrence module and a pre-live module, which is why there
are two. Please add verbatim (names are load-bearing: Firebase deploys by export
name, and renaming one deletes the deployed function):

```js
const tasksRecurring = require('./tasksRecurring');
const scheduledTasks = require('./scheduledTasks');

// ─── tasksRecurring.js ───────────────────────────────────────────────────────
exports.generateRecurringTasks = tasksRecurring.generateRecurringTasks;
exports.onTaskCompletedRecurrence = tasksRecurring.onTaskCompletedRecurrence;
exports.previewRecurrence = tasksRecurring.previewRecurrence;

// ─── scheduledTasks.js ───────────────────────────────────────────────────────
exports.activateScheduledTasks = scheduledTasks.activateScheduledTasks;
```

`onTaskCompletedRecurrence` is a second `onDocumentUpdated` trigger on
`tasks/{taskId}`, alongside lane 5's `onTaskUpdated`. If lane 5 would rather have
one trigger on that path, drop this export and have `onTaskUpdated` call
`tasksRecurring.advanceSeriesOnCompletion(taskId, before, after)` instead — it is
exported for exactly that, and it is a no-op for any task without a `seriesId`.

**CR-3.2 — `vitest.config.ts`: `npm test` does not run the recurrence suite.**
`include` is `['src/**/*.test.ts', 'src/**/*.test.tsx']`, so
`functions/__tests__/recurrence.test.js` is never collected. The 46 fixture tests
in it are the only thing in this repo that can catch a date-maths bug — a
recurrence that fires a day early looks completely normal everywhere else. They
pass today (verified against a scratch config; `46 passed`), but CI is not running
them. Please add one glob:

```ts
include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'functions/__tests__/**/*.test.js'],
```

The suite is already `environment: 'node'`-safe and imports nothing but
`functions/recurrence.js`, which is pure — no `firebase-admin`, no `db`.

**CR-3.3 — `src/types.ts`: four server-written fields have no home in the types.**
The generator writes them; the UI and the morning digest need to read them typed.

```ts
// on Task
carryStreak?: number;      // consecutive cycles that carried unfinished subtasks
carryFlagged?: boolean;    // carryStreak > 3 — render the "carrying since…" marker

// on TaskSeries
lastOccurrenceKey?: string | null;  // authoritative pointer; advances even on a
                                    // missed cycle, which mints no task
occurrencesCreated?: number;        // counts against occurrenceLimit
missedStreak?: number;              // the "3 missed in a row" warning in §4
anchorDate?: string | null;         // optional explicit sequence anchor; falls
                                    // back to payload.dueDate
```

Nothing is blocked on this today (Firestore is schemaless and the server writes
them regardless), but lanes 1, 4, and 5 cannot read them without a cast until
they exist.

**CR-3.4 — `functions/tickets.js`: put `activateScheduledTickets` on the shared
engine.** Plan §4 says to generalize the existing activator rather than write a
second copy. Lane 3 factored the batch-per-record runner out as
`scheduledTasks.activateScheduled({ label, loadDue, buildBatch })` and built
`activateScheduledTasks` on it, but could not touch `tickets.js` to finish the
job — so there are currently two loops, not one. Ticket behaviour is unchanged
either way; this is the second half of "one implementation only".

Note for whoever picks this up: the Lane table assigns `activateScheduledTasks` to
lane 1 and `functions/tasks.js` to lane 3. Lane 3's brief assigned the pre-live
activator to lane 3 under `functions/scheduledTasks.js`, and that is what was
built. Lane 1 should **not** write a second one.

**Not blocking, for the record:** the deployed index list has no
`statusType + goLiveDate` composite, so `loadDueScheduledTasks` filters the
go-live date in memory over the `statusType == 'scheduled'` equality. Pre-live
tasks are a small, self-draining set, so no index is requested.

### Lane 5 (Notifications & workload) — functions/index.js wiring, 2026-09-23

`functions/taskNotifications.js` and `functions/digest.js` are landed, green
(`node --check` on both, plus `npx tsc --noEmit` / `npm run lint` / `npm run
build` / `npm test` all exit 0 for the repo as a whole). They are not wired
into `functions/index.js`, which this lane doesn't own, so nothing in them is
actually deployed yet. Needed, in one batch:

1. Add re-exports for the three triggers in `taskNotifications.js`:
   `onTaskCreated`, `onTaskUpdated`, `onTaskCommentCreated`.
2. Add a re-export for `sendMorningBrief` from `digest.js`.
3. Retire `sendTicketReminders` (`tickets.js`) and `sendOnboardingReminders`
   (`onboarding.js`) as separate scheduled 07:00 exports — `sendMorningBrief`
   now covers both, plus a tasks section. Leaving all three exported would (a)
   send three emails a morning again, the exact problem §7 asks this lane to
   fix, and (b) fail the phase-5 DONE-CHECK's assertion that exactly one
   scheduled 07:00 digest function is exported across `functions/`.

Why this lane didn't do it: `functions/index.js`, `tickets.js`, and
`onboarding.js` are all listed foundation-owned above, and neither
`sendTicketReminders` nor `sendOnboardingReminders` exports its digest body
separately from its `onSchedule(...)` registration — there's nothing to
re-export without editing one of those three files, which this lane's fence
(and the phase-5 task's own collision guard) forbids. `digest.js` reproduces
their query/grouping/sort/copy itself instead (see the header comment in that
file) so the merged email's behavior doesn't depend on this wiring landing
first; only the "exactly one 07:00 schedule" assertion is blocked on it.

Also worth folding into the same index.js pass, from the "Open gap" noted
above: `getPageTitle()` in `src/components/Layout.tsx` has no entry for
`/admin/workload` (or the other eight new task routes), so it falls back to
"Portal". The sidebar's label is "Workload" — use that.

Once this lands, phase 5's DONE-CHECK is green end to end; nothing else is
outstanding from this lane.
