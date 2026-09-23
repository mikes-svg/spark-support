# ClickUp → Support Portal — migration plan

Status: **draft for approval**. Written 2026-09-23 after auditing the live
ClickUp workspace (Spark Management, `9011174633`).

Goal: retire ClickUp entirely and run all internal task work out of Support
Portal, as new tabs in the **User** section of the sidebar.

---

## 1. What's actually in ClickUp today

Audited directly, not assumed.

| | Finding |
|---|---|
| Users | 12 (1 owner, 3 admins, 8 members) |
| Spaces | Human Resources, Operations, Standifer Capital |
| Lists | ~12, one folder (`Operations / Insurance`) |
| Task volume | ~150–200 open, of which ~30 are redundant recurrence copies |
| Custom fields | **One** — "Due Date" (date, workspace-level, 11/18/24). Redundant with the native due date. |
| Tags | **Effectively unused.** Tag Manager is paywalled on the current plan. |
| Priority | Barely used — one "High" seen across ~100 tasks |
| Subtasks | Light (1–3 per task where present) |
| Attachments | Present but sparse; **workspace is at its storage limit** |
| Time tracking | Fields exist, unused |

Statuses are **per-list**, not global:

| List | Statuses |
|---|---|
| Human Resources / List | FUTURE, TO DO |
| Operations / Marketing | PENDING EDITA, PENDING CHLOE', PENDING VENDOR, IN PROGRESS, TO DO |
| Operations / General | IN PROGRESS, TO DO |
| Standifer / Mike's To-do | TO DO |

### Three findings that changed the design

**1. Recurrence is completion-triggered, not schedule-triggered.**
A representative recurring task (`Weekly - Facebook Marketplace Listing Refresh`)
is configured:

```
Weekly
On status change: Complete
[x] Create new task      [x] Recur forever
[x] Update status to: TO DO
[ ] Sync recurrence to due date
```

So the next occurrence appears when someone *completes* the current one — not on
a calendar tick. The build must default to this, with schedule-based as an option.

**2. Pre-materialized occurrences are clogging the workspace.**
`Operations / General` holds **80 "TO DO" tasks, and ~30+ of them are the same
task** — "Check for Expired Concessions", one copy per week from 9/12/25 through
4/10/26, all assigned to the same person, **none ever completed**. A year of
missed occurrences accumulated silently.

Two design consequences: generate **one occurrence at a time**, and have an
explicit **missed-occurrence policy** so a neglected series can't quietly build a
30-item backlog.

**3. Two statuses are named after people** — `PENDING EDITA`, `PENDING CHLOE'`.
These break the moment someone changes role or leaves, which is precisely the
"mass reassign when a team member leaves" problem on the requirements list.

### ClickUp's copy-on-recur settings (to mirror)

Checked: Comments, Description, Dependencies, Assignees, Subtask Assignees,
Remap Subtask Dates, Custom Fields, Relationships, Checklists, Followers, Tags,
Subtasks.
Unchecked: Keep checked items, Activity, Attachments, Comment Attachments.

"Automatically Carryover Subtasks" = **Subtasks ✓ + Keep checked items ☐** —
i.e. each occurrence gets a *fresh, unchecked copy* of the subtask list.

---

## 2. Decisions taken

| Decision | Choice |
|---|---|
| Collection | New `tasks` collection, **not** an extension of `tickets` |
| Visibility | **Open** — any signed-in user reads all tasks; writes gated |
| Subtasks | Checklist items on the task (array field) |
| Google Calendar | **Full two-way OAuth sync** |
| Recurrence default | **Completion-triggered**, schedule-triggered optional |
| Custom fields | **Not built in v1** — there is only one, and it's redundant |
| Subtask carryover | **Per-series setting** — reset fresh, or carry unfinished forward |
| `FUTURE` status | **Reuses the existing `Scheduled` mechanic** from tickets |
| Sidebar naming | Onboarding's "My Tasks" → **"Onboarding Tasks"**; new tabs take the plain names |
| Tags | Deferred to a later phase — currently unused |

### Why a separate collection

`tickets` has a fixed five-value status enum wired into `StatusBadge`,
`AnalyticsPage`, the 07:00 digest, and three email triggers. Custom statuses
would break every one of them. Tasks share *components* with tickets (assignee
selector, mentions, modals, avatars) but not the data model.

---

## 3. Data model

```
taskSpaces/{id}         name, order, archived
taskLists/{id}          spaceId, name, order, archived, defaultStatusSetId
taskStatusSets/{id}     name, statuses: [ {id, name, color, order, type} ]
                        type: 'scheduled' | 'todo' | 'active' | 'waiting' | 'done' | 'closed'
taskTags/{id}           name, color                       (phase 7)

tasks/{id}              listId, spaceId (denormalized for queries)
                        title, description (TipTap JSON string)
                        statusId, statusName, statusType   (denormalized)
                        waitingOnUserId?                   (replaces PENDING <person>)
                        priority: 'Low'|'Medium'|'High'|'Urgent'|null
                        assigneeIds[], creatorId, watcherIds[], participants[]
                        startDate, dueDate  ('YYYY-MM-DD' — reuses src/lib/dates.ts)
                        dueTime?            (optional HH:mm, for timed calendar events)
                        goLiveDate?         (a 'scheduled' task goes live on this date)
                        tagIds[]
                        subtasks[]  { id, title, done, doneAt, doneBy,
                                      assigneeIds?, dueDate?, order }
                        seriesId?, occurrenceKey?
                        gcalEventId?, gcalSyncedAt?
                        completedAt, createdAt, updatedAt

tasks/{id}/attachments  name, contentType, size, storagePath, url,
                        uploadedBy, uploadedAt
taskComments/{id}       taskId, userId, body, mentionedIds[], createdAt, editedAt
taskEvents/{id}         taskId, type, actorId, from*/to*, createdAt
taskSeries/{id}         recurring definition (§4)
taskTemplates/{id}      name, tasks: [ {...task payload, dueOffsetDays} ]
```

**Design rule:** every piece of logic — carryover, digests, metrics, overdue
counts — keys off `statusType`, **never** the status label. That is what makes a
status safe to rename or add without silently breaking reporting.

### Hierarchy: Space → List (two levels, not three)

ClickUp allows Space → Folder → List; this workspace uses a folder exactly once
(`Operations / Insurance`). Flatten it at import — `Insurance / Marketing`
becomes the list `Insurance — Marketing`. Two levels covers real usage and
removes a whole layer of UI.

### Replacing person-named statuses

`PENDING EDITA` / `PENDING CHLOE'` become one generic **`Waiting On`** status
(`type: 'waiting'`) plus a `waitingOnUserId` field. Benefits: mass-reassign
updates it automatically, the status set stops changing when staff change, and
"what's blocked on me" becomes a query instead of a status name.

---

## 4. Recurrence engine

```js
taskSeries/{id} {
  payload: { ...task fields, subtaskTemplate: [{title, order}] },
  recurrence: {
    freq: 'daily'|'weekly'|'biweekly'|'monthly'|'yearly'|'custom',
    interval: 1,
    byWeekday: [1,3,5],          // weekly / biweekly
    dayOfMonth: 15 | 'last',     // monthly
    monthlyMode: 'day-of-month'|'nth-weekday',
  },
  trigger: 'on-completion' | 'on-schedule',   // DEFAULT: on-completion
  resetStatusTo: '<statusId>',                // ClickUp's "Update status to: TO DO"
  skipWeekends: true,
  weekendShift: 'next'|'previous',
  startOffsetDays: -3,
  copyOnRecur: {                              // mirrors ClickUp's "Include in new task"
    description: true, subtasks: true, subtaskAssignees: true,
    remapSubtaskDates: true, assignees: true, watchers: true,
    comments: false, tags: true,
    keepCheckedItems: false,                  // subtasks reset to unchecked
    carryMode: 'reset' | 'carry-unfinished',  // per-series; see below
    attachments: false, activity: false,
  },
  missedPolicy: 'skip-to-next' | 'accumulate' | 'keep-one-open',  // DEFAULT: skip-to-next
  endDate | occurrenceLimit, active, timezone: 'America/Chicago'
}
```

**`missedPolicy` is the fix for the "Check for Expired Concessions" pile-up.**
`skip-to-next` (default): if the current occurrence is still open when the next
is due, don't create a second one — roll the existing task's due date forward and
record a `missed_occurrence` event. The series surfaces a "3 missed in a row"
warning in the UI and the morning digest instead of silently minting copies.

`generateRecurringTasks` runs **daily 06:00 America/Chicago**, an hour before the
existing 07:00 digest so new tasks land in that morning's email.

Robustness, following the pattern already in `activateScheduledTickets`:
- **Deterministic doc IDs** — `${seriesId}_${occurrenceKey}` (e.g. `abc_2026-10-15`).
  A retried or double-fired run physically cannot duplicate.
- **One atomic `WriteBatch` per occurrence** (task + audit event + mail), with
  per-series failures isolated so one bad series can't abort the run.

### Subtask carryover — per series

Each series picks one:

- **`reset`** (ClickUp parity, the default) — every occurrence gets the full
  subtask template back, unchecked. Right for genuine checklists where all steps
  repeat every cycle.
- **`carry-unfinished`** — the new occurrence gets the template *plus* anything
  left undone last cycle, flagged `carriedFromTaskId` and rendered with a
  "carried over" marker. Right for work that must eventually get done rather than
  lapse.

`carry-unfinished` can accumulate on a neglected series, so it is bounded: past
3 consecutive carries the task is flagged in the UI and the morning digest rather
than growing silently. This is the same failure mode `missedPolicy` guards
against, applied one level down.

### Skip weekends has two distinct meanings

- **Daily** → generate Mon–Fri only; don't generate at all on weekends.
- **Weekly / monthly / yearly / custom** → generate normally, but shift a Sat/Sun
  due date to the adjacent weekday per `weekendShift`.

### Scheduled (pre-live) tasks — replacing `FUTURE`

HR's `FUTURE` status maps onto the pre-live mechanic tickets already have. A task
whose status is of type `scheduled` is hidden from active lists, "due now" views,
the calendar, and digests until its `goLiveDate`; on that date a Cloud Function
flips it to the list's default `todo` status, notifies assignees, and logs the
event.

This reuses `activateScheduledTickets` (`functions/index.js`) almost wholesale —
same 5-minute schedule, same atomic-batch-per-record structure, same restore of
assignees to participants. Phase 1 generalizes that function to cover both
collections rather than writing a second copy.

### One implementation only

Recurrence math lives server-side in `functions/recurrence.js`. The client never
recomputes it — the "next 5 occurrences" preview calls a `previewRecurrence`
callable. Two copies of date math is how these features silently drift apart.

---

## 5. Navigation

```
USER
  My Tickets
  Submit Request
  My Tasks          ← new   /tasks
  Team Tasks        ← new   /tasks/all
  Calendar          ← new   /tasks/calendar

ADMIN
  …existing…
  Workload          ← new   /admin/workload
  Task Settings     ← new   /admin/tasks      (spaces, lists, statuses, templates)
  Reassign Work     ← new   /admin/reassign   (superadmin)
```

**Naming:** Onboarding's existing "My Tasks" tab at `/onboarding` is renamed
**"Onboarding Tasks"**, freeing the plain names for the new higher-traffic tabs.
Label change only — the route, page, and permissions are untouched. Worth a note
to the onboarding users on the day it ships.

---

## 6. Attachments

Current storage rules cap at 10MB, images + PDF only. Videos and documents need:

```
match /taskAttachments/{taskId}/{filename} {
  allow read: if request.auth != null;
  allow write: if request.auth != null
    && request.resource.size < 200 * 1024 * 1024
    && request.resource.contentType.matches('image/.*|video/.*|application/pdf|application/vnd.*|text/.*');
}
```

Unlike tickets (which list attachments through a callable, because Storage
listing is denied), tasks write an **attachment metadata doc on upload** — giving
delete, uploader attribution, size display, and no function round-trip per page load.

⚠️ **Migration risk:** ClickUp's CSV export does **not** include attachment
files, and the workspace is already at its storage limit. Existing attachments
must be downloaded manually before the account is closed. Inventory them early.

---

## 7. Notifications

Firestore triggers mirroring the ticket ones: `onTaskCreated`, `onTaskUpdated`
(status change → assignees + watchers + creator, minus the actor; new assignee;
due-date change), `onTaskCommentCreated` (participants + @mentions).

**Consolidate the 07:00 email.** Three separate digests (tickets, onboarding,
tasks) would hit the same 12 people every morning. Merge into one "Your morning
brief" with three sections — one send, one code path. Small refactor of the two
existing digest functions.

Add `notificationPrefs` to profiles (`immediate` / `digest-only` /
`mentions-only`) so recurring-task volume doesn't train people to ignore portal mail.

---

## 8. Google Calendar — two-way OAuth sync

1. Google Cloud OAuth client + consent screen, **internal** to `sparkmanage.com`,
   scope `https://www.googleapis.com/auth/calendar.events`.
2. Each user authorizes once from a Settings tab; refresh tokens stored
   server-side only (never in the client bundle, never readable by rules).
3. Portal → Google: on task create/update, upsert an event on a dedicated
   "Spark Tasks" calendar. Store `gcalEventId` on the task.
4. Google → Portal: `events.watch` push channel → HTTPS webhook → map event back
   by `gcalEventId`, apply due-date/title changes. Channels expire and need
   renewal on a schedule.
5. Loop suppression via `gcalSyncedAt` + an origin marker, so a write we caused
   doesn't bounce back and re-trigger.

**Prerequisite — resolved.** Mike is the Google Workspace admin and will create
the OAuth client and consent screen. Needed before Phase 6 starts: client ID +
secret in functions config (never the client bundle), the consent screen set to
**Internal**, and `sparkmanage.com` verified. No external review, since an
internal app skips Google's verification queue.

---

## 9. Mass reassign

Superadmin page: pick the departing person → see everything assigned to them
(open tasks, series definitions, subtask assignees, `waitingOnUserId`, and
optionally their tickets and onboarding rows) → reassign all or a subset.

Server-side callable `reassignWork({ fromUserId, toUserIds, scope, statuses })`
using 400-write chunked batches (the limit `src/lib/onboarding.ts` already uses),
writing **one summary audit event** and **one summary email per new assignee** —
not 200 individual "assigned to you" emails, which is exactly what would happen
if this ran through the normal update trigger.

---

## 10. Workload & metrics

Per person: open / overdue / due this week / completed last 30 days, on-time
completion %, average cycle time (from `taskEvents`), and **recurring compliance %**
— how often the weekly thing actually gets done that week. The "Check for Expired
Concessions" case would have shown 0% for a year.

Rendered with hand-rolled SVG bars, matching `AnalyticsPage.tsx`, which already
does this with no chart library. No new dependency.

---

## 11. Permissions

```
tasks:        read if signed in
              create if signed in && creatorId == uid
              update if participant || isAdmin()
              delete if creatorId == uid || isSuperAdmin()
taskComments: mirrors the existing comments rules
taskEvents:   read if signed in; create if actorId == uid; update/delete never
taskSpaces / taskLists / taskStatusSets / taskTemplates: read all, write superadmin
taskSeries:   read all; write if creator or admin
```

---

## 12. Phases

| Phase | Scope | Est. |
|---|---|---|
| **0** | Split `functions/index.js` (665 lines) into `tickets.js` / `onboarding.js` / `tasks.js` / `recurrence.js`. Confirm Google OAuth policy. Inventory ClickUp attachments. | 1 d |
| **1** | Data model, rules, indexes, spaces/lists, status sets, task CRUD, My Tasks list, task detail (statuses, priority, start/due, multi-assignee, rich description, subtasks). Generalize `activateScheduledTickets` to cover scheduled tasks. Rename Onboarding's tab. | 5.5 d |
| **2** | Comments, activity history, attachments (video/docs) | 2.5 d |
| **3** | Recurrence engine — completion + schedule triggers, skip weekends, carryover, missed policy, templates | 5 d |
| **4** | Team Tasks view, Calendar view, filters / grouping / saved views | 4 d |
| **5** | Notification triggers + consolidated morning digest, Workload dashboard | 3 d |
| **6** | Google Calendar two-way OAuth sync | 7 d |
| **7** | Mass reassign, status/tag admin, tags | 2.5 d |
| **8** | ClickUp import, parallel run, cutover | 2 d |

**≈ 32.5 working days (6–7 weeks).** Phases 1–3 replace ClickUp's core; 4–5 make it
pleasant; 6 is the single most expensive item on the list and is independently
deferrable.

### Files

New: `src/lib/tasks.ts`, `src/lib/taskEvents.ts`, `src/pages/Tasks*.tsx` (5 pages),
`src/components/tasks/*`, `functions/tasks.js`, `functions/recurrence.js`,
`functions/gcal.js`.
Modified: `src/types.ts`, `src/components/Sidebar.tsx`, `src/App.tsx`,
`firestore.rules`, `firestore.indexes.json`, `storage.rules`, `functions/index.js`.

---

## 13. Migration

1. Export each list to CSV (ClickUp → Settings → Imports/Exports).
2. **Do not import the ~30 "Check for Expired Concessions" copies** — import one
   series definition instead. Same for any other pre-materialized recurrence.
3. Re-create recurring configs by hand (~10–15 series; they don't survive CSV).
4. Download attachments manually before closing the account.
5. Map statuses → status sets; map `PENDING <person>` → `Waiting On` + `waitingOnUserId`.
6. Import via a one-off Admin SDK script, not the client.
7. Run both systems for one week; ClickUp read-only after cutover.

---

## 14. Decisions log

Resolved 2026-09-23:

1. **Sidebar naming** — Onboarding's "My Tasks" becomes "Onboarding Tasks".
2. **Subtask carryover** — per-series setting, `reset` (default) or
   `carry-unfinished`, bounded at 3 consecutive carries.
3. **Google OAuth** — Mike is the Workspace admin and will approve an internal
   app. Phase 6 unblocked.
4. **`FUTURE` status** — reuses the existing `Scheduled` pre-live mechanic rather
   than becoming an ordinary status.

Still open:

5. Is the "Due Date" custom field safe to drop in favour of the native due date?
   Recommendation: **yes, drop it.** It is the only custom field in the
   workspace, it duplicates a field tasks already have, and carrying it forward
   would mean building a custom-fields system for one redundant column.
