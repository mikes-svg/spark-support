/**
 * The single place any Google HTTP call is made — the seam the sync logic is
 * tested through.
 *
 * Everything in gcal.js / gcalWebhook.js talks to Google exclusively through a
 * transport object created here, and takes it as a dependency rather than
 * importing it. That is deliberate: the OAuth client does not exist yet (the
 * Workspace admin creates it after this lands), so the only way to prove the
 * sync rules — loop suppression, token refresh, all-day vs timed mapping — is
 * to drive them against a fake transport. Keeping every fetch behind this one
 * module means a fake has exactly one surface to imitate.
 *
 * Responses are returned as `{ status, ok, body }` and are NEVER thrown on a
 * non-2xx: callers need to branch on 401 (refresh + retry), 404 (event deleted
 * out from under us), and 410 (sync token expired), and an exception would
 * flatten all three into one failure. Only a transport-level failure (DNS,
 * socket, unparseable response) throws, as a `GoogleTransportError`.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

/**
 * The one scope this integration asks for.
 *
 * NOT `calendar.events`, which the plan originally specified: that scope grants
 * event access across EVERY calendar the user owns, and still cannot create a
 * calendar — `calendars.insert` returns 403 under it, which is exactly how this
 * was found (the first real sync failed with "Could not create the Spark Tasks
 * calendar (403)").
 *
 * `calendar.app.created` is both the working scope and the narrower one: it
 * permits creating secondary calendars and managing events ON CALENDARS THIS APP
 * CREATED, and nothing else. That makes the promise on the settings page — "Your
 * other calendars are never touched" — enforced by Google rather than by our own
 * good behaviour.
 *
 * Changing this value invalidates existing grants; everyone must reconnect.
 */
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

class GoogleTransportError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'GoogleTransportError';
    this.cause = cause;
  }
}

/** Serialize a flat object as application/x-www-form-urlencoded. */
function formEncode(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    usp.set(key, String(value));
  }
  return usp.toString();
}

/** Append a query string to a path, skipping undefined/null values. */
function withQuery(path, query) {
  if (!query) return path;
  const qs = formEncode(query);
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

/**
 * Build the consent-screen URL the user is sent to.
 *
 * `access_type=offline` + `prompt=consent` is what makes Google return a
 * refresh token. Without `prompt=consent` Google omits the refresh token on
 * every authorization after the first, which silently produces a connection
 * that works for an hour and then can never be renewed.
 */
function buildAuthUrl({ clientId, redirectUri, state, loginHint, scope = CALENDAR_SCOPE }) {
  return `${AUTH_URL}?${formEncode({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    login_hint: loginHint,
  })}`;
}

/**
 * Create a transport. `fetchImpl` defaults to the platform fetch (Node 22 has
 * it globally); tests pass a fake with the same signature.
 */
function createTransport({ fetchImpl, timeoutMs = 20000 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;

  async function request(url, { method = 'GET', headers = {}, body } = {}) {
    let res;
    try {
      res = await doFetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      });
    } catch (err) {
      throw new GoogleTransportError(`Google request failed: ${method} ${url}`, err);
    }

    // Google answers 204 with an empty body on a successful DELETE, and returns
    // text/html for some error pages, so parsing is best-effort by design.
    let parsed = null;
    const raw = typeof res.text === 'function' ? await res.text() : '';
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { raw };
      }
    }

    return { status: res.status, ok: res.status >= 200 && res.status < 300, body: parsed };
  }

  return {
    /** Trade an authorization code for access + refresh tokens. */
    async exchangeCode({ clientId, clientSecret, code, redirectUri }) {
      return request(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formEncode({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
    },

    /**
     * Mint a fresh access token. A revoked or expired refresh token comes back
     * as 400 with `error: 'invalid_grant'` — the caller treats that as "the
     * user disconnected us at Google's end", not as a retryable failure.
     */
    async refreshAccessToken({ clientId, clientSecret, refreshToken }) {
      return request(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formEncode({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });
    },

    /** Best-effort revocation on disconnect; a failure here is not fatal. */
    async revokeToken({ token }) {
      return request(REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formEncode({ token }),
      });
    },

    /** Any Calendar v3 call. `path` is relative to the v3 base, e.g. '/calendars'. */
    async calendar({ method = 'GET', path, accessToken, query, body }) {
      return request(`${CALENDAR_BASE}${withQuery(path, query)}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    },
  };
}

module.exports = {
  createTransport,
  buildAuthUrl,
  formEncode,
  withQuery,
  GoogleTransportError,
  CALENDAR_SCOPE,
  TOKEN_URL,
  REVOKE_URL,
  AUTH_URL,
  CALENDAR_BASE,
};
