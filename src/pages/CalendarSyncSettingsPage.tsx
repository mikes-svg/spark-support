/**
 * Calendar Sync — Phase 6 of docs/CLICKUP_MIGRATION_PLAN.md (§8).
 *
 * Every Google secret lives server-side. This page never sees a token, a client
 * id or a client secret: it asks `gcalAuthUrl` for the consent link, hands the
 * returned `code` straight back to `gcalConnect`, and reads status through
 * `gcalStatus`. The `gcalConnections` collection is deliberately absent from
 * firestore.rules — with no catch-all match, Firestore's default deny makes it
 * unreachable from any client — so there is nothing here to subscribe to even
 * if someone tried.
 *
 * The OAuth redirect lands back on THIS route with `?code=…`, which is why the
 * connect flow is split across a mount effect rather than living in one handler.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { CalendarClock, CheckCircle2, Link2, Loader2, RefreshCw, TriangleAlert, Unlink } from 'lucide-react';
import { functions } from '../lib/firebase';
import { ConfirmModal } from '../components/ConfirmModal';
import { PageSpinner } from '../components/PageSpinner';
import { formatDateTime } from '../lib/dates';

interface GcalStatus {
  connected: boolean;
  status: 'connected' | 'revoked' | 'disconnected' | string;
  calendarName?: string;
  connectedAt?: string | null;
  lastSyncedAt?: string | null;
  watching?: boolean;
  lastError?: string | null;
  /** False until the Workspace admin puts the OAuth client in the functions env. */
  serverConfigured?: boolean;
}

/** Where Google sends the user back. Must match GCAL_REDIRECT_URI on the server. */
function redirectUri() {
  return `${window.location.origin}/settings/calendar`;
}

const STATE_KEY = 'gcalOAuthState';

export function CalendarSyncSettingsPage() {
  const [status, setStatus] = useState<GcalStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // React 18 StrictMode mounts effects twice in dev. An authorization code is
  // single-use, so a second exchange would fail and show a spurious error —
  // this latch makes the redirect handler run once per page load.
  const handledRedirect = useRef(false);

  const fetchStatus = useCallback(async () => {
    if (!functions) return null;
    const res = await httpsCallable<void, GcalStatus>(functions, 'gcalStatus')();
    setStatus(res.data);
    return res.data;
  }, []);

  useEffect(() => {
    if (handledRedirect.current) return;
    handledRedirect.current = true;

    (async () => {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const returnedState = params.get('state');
      const oauthError = params.get('error');
      const expectedState = sessionStorage.getItem(STATE_KEY);

      // Clean the query string immediately, whatever happens next: an
      // authorization code should not survive in history or in a shared URL.
      if (code || oauthError) {
        window.history.replaceState({}, '', window.location.pathname);
        sessionStorage.removeItem(STATE_KEY);
      }

      try {
        if (oauthError) {
          setActionError(
            oauthError === 'access_denied'
              ? 'You cancelled the Google authorization, so nothing was connected.'
              : `Google returned an error: ${oauthError}`,
          );
        } else if (code && functions) {
          // A mismatched state means the redirect did not originate from this
          // tab's connect click — refuse it rather than exchange the code.
          if (!expectedState || expectedState !== returnedState) {
            setActionError('That sign-in did not start from this page, so it was ignored. Please try connecting again.');
          } else {
            setBusy('connect');
            await httpsCallable<{ code: string; redirectUri: string }, { connected: boolean; watching: boolean }>(
              functions,
              'gcalConnect',
            )({ code, redirectUri: redirectUri() });
            setNotice('Google Calendar connected.');
          }
        }
        await fetchStatus();
      } catch (err) {
        console.error('Calendar sync: could not load status', err);
        setActionError(messageFor(err, 'Could not reach calendar sync. Please try again.'));
      } finally {
        setBusy(null);
        setLoading(false);
      }
    })();
  }, [fetchStatus]);

  const handleConnect = async () => {
    if (!functions) return;
    setActionError('');
    setNotice('');
    setBusy('connect');
    try {
      // A random state, echoed back by Google, ties the redirect to this tab.
      const state = crypto.randomUUID();
      sessionStorage.setItem(STATE_KEY, state);
      const res = await httpsCallable<{ redirectUri: string; state: string }, { url: string }>(
        functions,
        'gcalAuthUrl',
      )({ redirectUri: redirectUri(), state });
      window.location.assign(res.data.url);
    } catch (err) {
      console.error('Calendar sync: could not start authorization', err);
      sessionStorage.removeItem(STATE_KEY);
      setBusy(null);
      setActionError(messageFor(err, 'Could not start Google authorization. Please try again.'));
    }
  };

  const handleDisconnect = async () => {
    setConfirmDisconnect(false);
    if (!functions) return;
    const previous = status;
    setActionError('');
    setNotice('');
    setBusy('disconnect');
    // Optimistic: the switch to "not connected" is what the user is waiting to
    // see, and `previous` restores the old card if the callable fails.
    setStatus({ ...(previous as GcalStatus), connected: false, status: 'disconnected', watching: false });
    try {
      await httpsCallable<void, { disconnected: boolean }>(functions, 'gcalDisconnect')();
      setNotice('Google Calendar disconnected. Existing events stay on your calendar.');
      await fetchStatus();
    } catch (err) {
      console.error('Calendar sync: disconnect failed', err);
      setStatus(previous);
      setActionError(messageFor(err, 'Could not disconnect. Please try again.'));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <PageSpinner />;

  const connected = Boolean(status?.connected);
  const revoked = status?.status === 'revoked';
  const serverReady = status?.serverConfigured !== false;

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      {actionError && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-md" role="alert">{actionError}</p>
      )}
      {notice && (
        <p className="text-sm text-green-800 bg-green-50 border border-green-200 px-4 py-3 rounded-md" role="status">{notice}</p>
      )}

      <section className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-200 bg-gray-50/50 flex items-start gap-3">
          <CalendarClock className="h-6 w-6 text-brand-dark shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-serif font-semibold text-gray-900">Google Calendar</h2>
            <p className="mt-0.5 text-sm text-gray-500">
              Keep your tasks and your calendar in step, in both directions.
            </p>
          </div>
        </div>

        <div className="px-6 py-5 space-y-5">
          {!serverReady ? (
            <div className="flex items-start gap-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-4 py-3">
              <TriangleAlert className="h-5 w-5 shrink-0 mt-0.5" aria-hidden="true" />
              <p>
                Calendar sync isn&apos;t switched on for this portal yet. An administrator needs to add the
                Google OAuth client to the server configuration before anyone can connect.
              </p>
            </div>
          ) : (
            <>
              <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <dt className="text-gray-500">Status</dt>
                  <dd className="mt-1 flex items-center gap-1.5 font-medium text-gray-900">
                    {connected ? (
                      <>
                        <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" />
                        Connected
                      </>
                    ) : revoked ? (
                      <>
                        <TriangleAlert className="h-4 w-4 text-amber-600" aria-hidden="true" />
                        Needs reconnecting
                      </>
                    ) : (
                      'Not connected'
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-gray-500">Calendar</dt>
                  <dd className="mt-1 font-medium text-gray-900">{status?.calendarName || 'Spark Tasks'}</dd>
                </div>
                <div>
                  <dt className="text-gray-500">Last synced</dt>
                  <dd className="mt-1 font-medium text-gray-900">
                    {status?.lastSyncedAt ? formatDateTime(status.lastSyncedAt) : '—'}
                  </dd>
                </div>
              </dl>

              {revoked && (
                <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-4 py-3" role="alert">
                  Google has withdrawn access — usually because the connection was removed from your Google
                  account. Reconnect to start syncing again.
                </p>
              )}

              {connected && status?.watching === false && (
                <p className="text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-md px-4 py-3">
                  Changes you make in the portal reach Google, but changes made in Google Calendar aren&apos;t
                  coming back yet. This usually fixes itself within a day; reconnect if it doesn&apos;t.
                </p>
              )}

              <div className="flex flex-wrap gap-3">
                {connected || revoked ? (
                  <>
                    {revoked && (
                      <button
                        type="button"
                        onClick={handleConnect}
                        disabled={busy !== null}
                        className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-md bg-brand-dark text-white text-sm font-medium hover:bg-brand-dark/90 disabled:opacity-60"
                      >
                        {busy === 'connect' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
                        Reconnect
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setConfirmDisconnect(true)}
                      disabled={busy !== null}
                      className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-md border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 disabled:opacity-60"
                    >
                      {busy === 'disconnect' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Unlink className="h-4 w-4" aria-hidden="true" />}
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={handleConnect}
                    disabled={busy !== null}
                    className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-md bg-brand-dark text-white text-sm font-medium hover:bg-brand-dark/90 disabled:opacity-60"
                  >
                    {busy === 'connect' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Link2 className="h-4 w-4" aria-hidden="true" />}
                    Connect Google Calendar
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </section>

      {/* Sync is two-way but deliberately narrow. Spelling out exactly which
          fields travel, and which do not, is the difference between people
          trusting the integration and quietly working around it. */}
      <section className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-200 bg-gray-50/50">
          <h2 className="text-lg font-serif font-semibold text-gray-900">What syncs</h2>
        </div>
        <div className="px-6 py-5 grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
          <div>
            <h3 className="font-medium text-gray-900">Portal → Google</h3>
            <ul className="mt-2 space-y-2 text-gray-600 list-disc pl-5">
              <li>Any task with a due date appears on a calendar called <strong>Spark Tasks</strong>, created for you. Your other calendars are never touched.</li>
              <li>A task due on a date shows as an all-day event. A task with a time shows at that time, for 30 minutes.</li>
              <li>Renaming a task or moving its due date updates the event.</li>
              <li>Completing or deleting a task removes the event.</li>
              <li>A task goes on the calendar of its first assignee who has connected; if none have, its creator&apos;s.</li>
            </ul>
          </div>
          <div>
            <h3 className="font-medium text-gray-900">Google → Portal</h3>
            <ul className="mt-2 space-y-2 text-gray-600 list-disc pl-5">
              <li>Renaming an event renames the task.</li>
              <li>Dragging an event to another day or time moves the task&apos;s due date.</li>
              <li>Deleting an event does <strong>not</strong> delete the task — it just stops syncing that one. Close the task in the portal instead.</li>
              <li>Status, priority, assignees, subtasks and comments stay portal-only. A calendar edit can never reassign work.</li>
            </ul>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50/50 text-xs text-gray-500">
          The portal asks Google only for permission to make its own calendar and manage the events on
          it — it cannot see or change your existing calendars, your email or your contacts. That limit
          is enforced by Google, not just by us. Disconnecting revokes the permission; events already on
          your calendar stay where they are.
        </div>
      </section>

      <ConfirmModal
        open={confirmDisconnect}
        title="Disconnect Google Calendar?"
        message="Your tasks will stop syncing in both directions. Events already on your Spark Tasks calendar will stay there."
        confirmLabel="Disconnect"
        danger
        onConfirm={handleDisconnect}
        onCancel={() => setConfirmDisconnect(false)}
      />
    </div>
  );
}

/** Prefer a callable's own message — the server writes them for humans. */
function messageFor(err: unknown, fallback: string) {
  const message = (err as { message?: string })?.message;
  return message && message !== 'internal' ? message : fallback;
}
