# Running the portal locally against the Firebase emulators

Walk the app with seeded data, without touching the real `spark-support-28ed9`
project. Nothing in this setup can reach production: the client only connects to
emulators when `VITE_USE_EMULATORS=true`, and that flag is additionally gated on
`import.meta.env.DEV`, which Vite replaces with a literal `false` in any
production build.

## One-time prerequisite

The Firestore emulator is a Java binary:

```bash
brew install openjdk
```

No `sudo` and no system-wide JDK link needed — the emulator finds it on `PATH`.
If `npm run emulators` reports "Unable to locate a Java Runtime", prepend it:

```bash
export PATH="$(brew --prefix openjdk)/bin:$PATH"
```

## Each run — three terminals

```bash
npm run emulators       # auth 9099, firestore 8080, functions 5001, storage 9199, UI 4000
npm run seed:emulator   # idempotent — safe to re-run any time
npm run dev:emulator    # http://localhost:5176
```

Open http://localhost:5176. Under the Google button there is an **Emulator mode
— seeded accounts** panel; click a person to sign in as them. `Mike Sanghvi` is
the superadmin. The emulator UI is at http://localhost:4000 if you want to
inspect the data directly.

### Why the account picker instead of the Google button

The Auth emulator's sign-in widget finishes by calling back through the popup's
opener frame. Any browser that reuses the tab — or blocks the popup — loses that
frame and the widget dies with `Internal Error: No matching frame`; the redirect
fallback then loses its pending-redirect state across the `9099 → 5176` origin
hop. Neither is an app bug, but both make the emulator unusable for a
walkthrough, so `src/components/EmulatorSignIn.tsx` signs in with an unsigned
custom token instead. The emulator accepts those; a real Firebase project
rejects them outright, and there is no key involved.

## What gets seeded

Shaped after the real ClickUp workspace this feature replaces, so a walkthrough
hits the cases that actually matter rather than happy-path rows:

- 6 people (1 superadmin, 2 admins, 3 users), 3 spaces, 4 lists, 3 tags
- One status set covering all six `statusType`s, including `Waiting On`
- 13 tasks: 2 overdue, 2 due today, 1 pre-live (`scheduled`), 2 complete,
  1 closed, 2 waiting-on-a-person, several with part-done subtasks
- 3 recurring series — one deliberately carrying **30 consecutive missed
  occurrences**, reproducing the "Check for Expired Concessions" pile-up from
  the real ClickUp. It should show as **0% recurring compliance, in red**, on
  `/admin/workload`. If that ever reads green, the compliance metric is broken.

The seed is idempotent: every document has a fixed id, so re-running updates in
place rather than duplicating.

## Resetting

The emulators hold everything in memory — stop them and the data is gone. To
clear without restarting:

```bash
curl -X DELETE "http://127.0.0.1:8080/emulator/v1/projects/spark-support-28ed9/databases/(default)/documents"
curl -X DELETE "http://127.0.0.1:9099/emulator/v1/projects/spark-support-28ed9/accounts"
```
