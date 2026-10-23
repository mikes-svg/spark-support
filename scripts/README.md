# ClickUp import

One-off migration script for Phase 8 of `docs/CLICKUP_MIGRATION_PLAN.md` §13.
Reads a ClickUp CSV export and writes `taskSpaces` / `taskLists` /
`taskStatusSets` / `tasks` / `taskSeries` with the Admin SDK. It is **not**
client code — never imported by the app bundle, run by hand from the repo root.

## 1. Export from ClickUp

Per list (ClickUp doesn't offer a single "export everything" for tasks):

1. Open the list → **⋯** → **Export** → **Tasks (CSV)**.
2. Keep the default columns; the script only reads `Task ID`, `Task Name`,
   `Status`, `Priority`, `Assignees`, `Space`, `Folder`, `List`, `Due Date`,
   `Date Created` — extra columns are ignored, not an error.
3. Repeat for every list, or concatenate exports into one CSV (keep one header
   row at the top). The importer groups everything by the `Space`/`Folder`/
   `List` columns in the file, not by which file a row came from.
4. **Attachments do not travel in the CSV.** The plan flags the workspace as
   already at its storage limit — download anything worth keeping (Storage →
   each list) before the ClickUp account is closed. This script does not
   attempt attachment migration.

## 2. Dry run (always do this first)

```
node scripts/import-clickup.js --file path/to/export.csv
```

`--dry-run` is the default — this is identical to passing it explicitly.
Nothing touches Firestore except a best-effort read of `profiles` (see below).
Read the full summary before doing anything else:

- **Spaces / Lists** — Space stays as-is; Folder + List flatten into one list
  named `Folder — List` (e.g. `Insurance` + `Marketing` → `Insurance —
  Marketing`). A list with no folder keeps its plain name.
- **Status sets** — one per list, built from every distinct status name seen
  in that list's rows, in first-seen order. `to do` → `todo`, `in progress` →
  `active`, `complete`/`done` → `done`, `closed`/`cancelled` → `closed`,
  `future` → `scheduled` (the same pre-live mechanic tickets already have).
  Any `PENDING <person>` status collapses into one generic **Waiting On**
  status (type `waiting`) across the whole set — see below for the person.
  An unrecognized status name is kept as its own status (title-cased) with
  type `todo` and called out under **Warnings**, so you can retype it
  correctly from Task Settings after import rather than losing the task.
- **Recurrence collapse** — this is the finding the whole feature is designed
  around (plan §1): a completion-triggered ClickUp series that nobody ever
  finished materializes one row per period forever. The script detects runs of
  3+ tasks in the same list, with the same title and the same assignee(s), on
  a regular date interval (weekly/biweekly/monthly/etc, ±2 days tolerance),
  and reports them as `Collapsed N copies of "..." into 1 series + 1 open
  occurrence`. Only **unfinished** tasks are grouped this way — a completed
  task never joins a collapse run. Verify the reported count and interval
  against what you saw in ClickUp before committing.
- **Waiting-on / assignee resolution** — the script tries to match `PENDING
  <person>` names and `Assignees` entries against the `profiles` collection by
  name. If it can reach Firestore (see "Profile resolution" below) resolved
  names disappear from the summary; anything left under **Unresolved names**
  didn't match a profile and needs a name fixed in ClickUp (or a profile
  created) before it will resolve — those tasks import with an empty/`null`
  assignee otherwise, not a guess.

Nothing is written during a dry run, whether or not profile resolution
succeeded — read the summary, fix the source data or your name-matching
expectations, and dry-run again until it looks right.

### Profile resolution and credentials

Assignee/waiting-on resolution needs to read the `profiles` collection, so
even a dry run attempts an Admin SDK connection. If it can't authenticate —
this is expected on a machine with no `GOOGLE_APPLICATION_CREDENTIALS` /
`gcloud auth application-default login` set up for the project — the dry run
does **not** fail; it prints every name under **Unresolved names** and a
warning that profiles were unavailable, so you can still review the
spaces/lists/status-set/collapse plan offline. Get credentials sorted before
you actually care about the resolved names, or before `--commit`.

## 3. Commit

```
node scripts/import-clickup.js --file path/to/export.csv --commit [--project spark-support-28ed9]
```

Requires Admin SDK credentials for the target project (see above). `--project`
is only needed if it isn't already picked up from your environment/ADC.

**Idempotent by construction** — every doc gets a deterministic id derived
from its content (space/list name, the ClickUp `Task ID`, or, for a collapsed
series, the series' key + its kept occurrence date) and every write is a
`set(..., { merge: true })`. Re-running the same export re-applies the same
plan on top of what's already there instead of duplicating it — safe to run
again after fixing a name mismatch or re-exporting a list.

Writes are chunked at 400 per batch (`BATCH_LIMIT`, the same limit
`src/lib/onboarding.ts` uses), so an export of any realistic size won't hit
Firestore's 500-write batch cap.

## 4. After committing

- Re-run the **same** dry run again — it should report the same plan with
  nothing new to add, confirming nothing duplicated.
- Open **Task Settings** (`/admin/tasks`) and check the imported status sets:
  give any `scheduled`-typed status (from a ClickUp `FUTURE` list) a sane
  color/order, and fix anything flagged under Warnings as unrecognized.
- `creatorId` on an imported task/series is the first resolved assignee, or
  the literal string `clickup-import` when nothing resolved — there's no real
  "creator" for migrated work. That id isn't a signed-in account, so nobody
  can edit via "I'm the creator"; assignees and admins still can, which
  covers ordinary use. Reassign Work can move assignees off it later same as
  any other task.
- Per the plan (§13): run both systems for one week before making ClickUp
  read-only, and re-create the ~10–15 genuinely active recurring configs by
  hand with the settings you actually want (trigger, skip-weekends, carryover)
  — the importer intentionally does not try to reverse-engineer those from
  historical CSV rows, only to stop the already-materialized copies from
  flooding the new list.

## Fixture

`scripts/fixtures/clickup-sample.csv` is a small hand-built export used by the
done-check (`node scripts/import-clickup.js --dry-run --file
scripts/fixtures/clickup-sample.csv`), not a copy of real customer data. It
exercises every mapping this script does — a `FUTURE` status, both `PENDING
EDITA` and `PENDING CHLOE'`, a `Folder` that needs flattening, `complete` and
`closed` statuses — and includes a 30-row weekly "Check for Expired
Concessions" run so the collapse logic actually fires in CI, not just in
theory. **This script has only ever been run against that fixture.** Do a
careful, read-only dry run against a real export before anyone trusts its
output on production data.
