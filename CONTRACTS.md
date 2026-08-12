# Property Onboarding — pinned contract

Coordination file for the onboarding swarm. **Do not edit files you don't own.**
If you need a change to anything on this page, append a request under
"Change requests" at the bottom and return `BLOCKED` — do not edit the shared
file yourself.

The foundation is already landed and typechecks clean (`npx tsc --noEmit` exits 0).

## Firestore collections

| Collection | Docs | Who writes |
|---|---|---|
| `onboardingTemplate` | one per template row | superadmin only |
| `onboardingProperties` | one per property | superadmin only |
| `onboardingTasks` | one per checklist row per property (flat, not a subcollection) | anyone with onboarding access |
| `profiles` | gains `onboardingAccess?: boolean` | superadmin only (existing rule) |

Collection-name constants are exported from `src/lib/onboarding.ts` as
`TEMPLATE`, `PROPERTIES`, `TASKS`.

## Document shapes — `src/types.ts` (LANDED, do not redefine)

```ts
export type OnboardingStatus = 'Not Started' | 'In Progress' | 'Complete' | 'N/A';
export const ONBOARDING_STATUSES: OnboardingStatus[];

export interface OnboardingTemplateItem {
  id: string; section: string; order: number; code: string;
  indent: 0 | 1; title: string; responsibleIds: string[];
  daysFromClosing: number | null;
}

export interface OnboardingProperty {
  id: string; name: string;
  closingDate: string | null;        // 'YYYY-MM-DD'
  psaExecutionDate: string | null;
  titleCommitmentDate: string | null;
  titleNoticeDate: string | null;
  ddCompletionDate: string | null;
  extension: string; archived: boolean;
  createdAt?: FsTimestamp; createdBy?: string;
}

export interface OnboardingDelay {
  at: string; byId: string;
  fromDate: string | null; toDate: string | null; reason: string;
}

export interface OnboardingTask {
  id: string; propertyId: string; section: string; order: number;
  code: string; indent: 0 | 1; title: string; responsibleIds: string[];
  daysFromClosing: number | null;
  dueDate: string | null;            // 'YYYY-MM-DD'
  status: OnboardingStatus; notes: string;
  delays?: OnboardingDelay[];
}

export interface Profile { /* … */ onboardingAccess?: boolean }

/** Superadmin OR the granted flag. */
export function hasOnboardingAccess(
  profile?: { role?: string | null; onboardingAccess?: boolean } | null
): boolean;
```

**All dates are `'YYYY-MM-DD'` strings, never Firestore Timestamps.** They sort
and range-query correctly as strings and avoid timezone drift.

## Helpers already available

`src/lib/dates.ts`
```ts
parseDateOnly(s): Date | null      toDateOnly(d: Date): string
todayStr(): string                 addDaysStr(s, n): string | null
diffDaysStr(from, to): number|null formatDateOnly(s): string
```

`src/lib/onboarding.ts`
```ts
export const PROPERTIES, TASKS, TEMPLATE: string          // collection names
computeDueDate(closingDate, daysFromClosing): string | null
deriveDaysFromClosing(closingDate, dueDate): number | null
orderBetween(before: number|null, after: number|null): number
groupBySection<T extends {section,order}>(rows): {section, rows}[]
isTaskDone(task: {status}): boolean
isOverdue(task: {status, dueDate?}, today: string): boolean
fetchOnboardingPeople(): Promise<Profile[]>               // people w/ access, name-sorted
fetchProperties(): Promise<OnboardingProperty[]>
fetchTasksForProperty(id): Promise<OnboardingTask[]>
createPropertyFromTemplate(input, template, createdBy)
applyClosingDate(propertyId, closingDate, tasks): Promise<OnboardingTask[]>
deletePropertyWithTasks(propertyId, tasks): Promise<void>
renameSection(collectionName, rows, from, to): Promise<void>
deleteRows(collectionName, rows: {id}[]): Promise<void>
```

`src/lib/seedOnboardingTemplate.ts`
```ts
getOrSeedOnboardingTemplate(profiles: Profile[]): Promise<OnboardingTemplateItem[]>
```
Reads `onboardingTemplate` ordered by `order`; seeds ~140 rows from the sheet on
first use (needs superadmin write; fails silently → `[]` for everyone else).

## The due-date rule (the sheet's formula)

`dueDate = closingDate + daysFromClosing`, kept in sync **bidirectionally**:
- edit the offset → recompute the due date (`computeDueDate`)
- type a due date → re-derive the offset (`deriveDaysFromClosing`)
- change the property's closing date → `applyClosingDate` rewrites every task
  that carries an offset, in one batch

## Component API — `src/components/onboarding/ChecklistTable.tsx` (LANDED)

```ts
export interface ChecklistRow {
  id: string; section: string; order: number; code: string;
  indent: 0 | 1; title: string; responsibleIds: string[];
  daysFromClosing: number | null;
  dueDate?: string | null; status?: OnboardingStatus;
  notes?: string; delays?: OnboardingDelay[];
}

<ChecklistTable
  rows={ChecklistRow[]}
  people={Profile[]}
  mode={'template' | 'property'}   // 'template' hides Due Date/Status/Notes
  closingDate={string | null}      // property mode only
  canEdit={boolean}
  onPatchRow={(row, patch: Partial<ChecklistRow>) => void}
  onDueDateChange={(row, dueDate: string | null) => void}   // property mode
  onAddRow={(section: string, afterRow: ChecklistRow | null) => void}
  onDeleteRow={(row) => void}
  onMoveRow={(row, direction: -1 | 1) => void}
  onRenameSection={(from: string, to: string) => void}
  onDeleteSection={(section: string) => void}
  onAddSection={() => void}
/>
```

`src/components/onboarding/PostponeModal.tsx`
```ts
<PostponeModal
  open={boolean} taskTitle={string}
  fromDate={string | null} initialDate={string | null}
  onCancel={() => void}
  onConfirm={(toDate: string | null, reason: string) => void}
/>
```

## Routes (pinned — lanes must agree)

| Path | Page component (named export) | Guard |
|---|---|---|
| `/onboarding` | `OnboardingMyTasksPage` | onboarding access |
| `/onboarding/properties` | `OnboardingPropertiesPage` | onboarding access |
| `/onboarding/properties/:propertyId` | `OnboardingPropertiesPage` | onboarding access |
| `/onboarding/template` | `OnboardingTemplatePage` | superadmin |

All three pages live in `src/pages/`, are **named** exports (not default), and
are lazy-loaded in `App.tsx` following the existing pattern.

## Permission model

- **Superadmin**: everything — template editing, property create/archive/delete,
  property header fields, and every checklist row.
- **Onboarding access** (`profiles.onboardingAccess === true`): read the template,
  read properties, and fully edit `onboardingTasks` rows (status, notes,
  responsibility, dates, add/delete rows, rename sections).
- **Nobody else**: no read access to any onboarding collection.

## Existing patterns to follow

- Optimistic update + rollback on error, with an `actionError` banner —
  see `src/pages/TeamPage.tsx` and `src/pages/AdminSettingsPage.tsx`.
- `PageSpinner` while loading; `Modal` / `ConfirmModal` for dialogs.
- Cloud Functions: `escapeHtml`, `sendMail`, `emailsForAssignees`, `APP_URL`,
  `REGION` already exist in `functions/index.js` — reuse them.

## Change requests

_(append here if you need a contract change, then return BLOCKED)_
