# Google Calendar sync — creating the OAuth client

Your part is one page in the Google Cloud Console. Everything else is already
wired. Budget about three minutes.

Project: **spark-support-28ed9** (the same project the portal already uses —
don't make a new one, or the functions won't share its identity).

---

## 1. Enable the Calendar API

https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=spark-support-28ed9

Click **Enable**. If it already says "Manage", it's on.

## 2. Consent screen — already done, and **leave it External**

Nothing to do here. The portal's existing Google sign-in already runs through
this project's consent screen: it is **External**, **In production**, 0 of 100
users used.

**Do not click "Make Internal".** An earlier draft of this doc said to, and that
was wrong. The project's organization is `standifercapital.com` (IAM & Admin →
Settings → Location), but the team signs in with `@sparkmanage.com` — 11 of the
12 people, and `src/lib/firebase.ts` pins Google login to
`hd: 'sparkmanage.com'`. "Internal" means *this organization only*, so the click
would restrict OAuth to `standifercapital.com` and lock every sparkmanage.com
user out of signing in to the portal at all. Not just calendar — the whole login.

That holds unless `sparkmanage.com` is a secondary domain inside the same
Workspace account, which we did not confirm (checking it needs a passkey
challenge in the admin console). The upside of Internal is cosmetic and the
downside is a team-wide outage, so External stays.

### What External costs

- `calendar.events` is a sensitive scope on an unverified app, so each person
  sees Google's **"unverified app" screen once** when they connect their
  calendar: *Advanced → Go to Spark Support*. Annoying, not blocking.
- The **100-user cap** applies. You have 12.

Neither affects reliability. The 7-day refresh-token expiry that would wreck a
sync integration applies only to External apps in **Testing**; this one is in
production, so refresh tokens persist.

Submitting for Google verification removes the warning screen, takes weeks, and
is not worth blocking on.

## 3. Create the OAuth client

https://console.cloud.google.com/auth/clients?project=spark-support-28ed9

**Create client** → Application type: **Web application** → name it
`Support Portal — Calendar Sync`.

Under **Authorized redirect URIs**, add both, exactly as written:

```
http://localhost:5176/settings/calendar
https://support.sparkmanage.com/settings/calendar
```

These must match character for character. The client sends
`window.location.origin + /settings/calendar` and the server rejects any
mismatch, so a trailing slash or a different port fails with
`redirect_uri_mismatch`.

Leave **Authorized JavaScript origins** empty — this is a server-side code
exchange, not an implicit browser flow.

Create it, then copy the **Client ID** and **Client secret**.

## 4. Put them in the local env file

```bash
cp functions/.env.example functions/.env.local
```

Open `functions/.env.local` and paste the two values into `GCAL_CLIENT_ID` and
`GCAL_CLIENT_SECRET`. Leave the rest as it is.

`functions/.env.local` is gitignored — verified, not assumed. Don't paste the
secret into chat, a commit, or a screenshot; the checker below never prints it.

```bash
node scripts/check-gcal-config.js
```

That validates shape only — catches the two values being swapped, a wrong
redirect path, a non-https webhook. It does not talk to Google.

## 5. Restart the functions emulator

It reads env at startup, so it needs a restart to see the new file.

---

## What can and cannot be tested locally

| | Local emulator | Needs deploy |
|---|---|---|
| Consent screen + token exchange | ✅ | |
| Refresh-token storage and renewal | ✅ | |
| Task → Google event create/update/delete | ✅ | |
| **Google → task** (drag an event, due date follows) | ❌ | ✅ |

The inbound half is a Google **push channel**, and Google only delivers to a
public HTTPS URL on a verified domain. It will not call `localhost`, and it will
not call plain `http`. So leave `GCAL_WEBHOOK_URL` empty locally — the code
skips channel registration when it's unset rather than failing.

To exercise inbound, either deploy the function and set:

```
GCAL_WEBHOOK_URL=https://us-central1-spark-support-28ed9.cloudfunctions.net/gcalWebhook
```

…or tunnel the emulator (`cloudflared tunnel --url http://127.0.0.1:5001`) and
use the public URL. Deploying is the honest test — the tunnel proves the handler
runs but not that Google's real channel registration and renewal work against
your domain.

## Production

Same client, but set `GCAL_REDIRECT_URI` to the `support.sparkmanage.com` URL,
set `GCAL_WEBHOOK_URL`, and store the secret with
`firebase functions:secrets:set GCAL_CLIENT_SECRET` rather than a committed
`.env` file.
