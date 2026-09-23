/**
 * Reassign Work — Phase 7 of docs/CLICKUP_MIGRATION_PLAN.md §9.
 *
 * Pick who's leaving, see everything assigned to them, choose which categories
 * to sweep, pick who picks it up, and hand it off in one server-side callable.
 * The preview here is entirely client-side reads (fast, cheap, lets someone
 * browse before committing to anything); the actual move is a single call to
 * `reassignWork`, which does its own read-and-write server-side so the result
 * is atomic-per-item and chunked — see functions/reassign.js for why this
 * can't just be a client loop calling updateTask N times.
 *
 * `scope` is category-level, matching the pinned callable signature
 * (`{ fromUserId, toUserIds, scope, statuses }` — no per-item id list): there's
 * no per-task checkbox list here by design, only per-category. Narrow a
 * category (e.g. uncheck "Subtask assignees") rather than expecting to pick
 * individual rows.
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from '../../lib/firebase';
import { listTasks, TASK_SERIES } from '../../lib/tasks';
import { isTaskDone } from '../../types';
import type { Profile, Task, TaskSeries, TaskStatusType } from '../../types';
import { AssigneeSelector } from '../../components/AssigneeSelector';
import { ConfirmModal } from '../../components/ConfirmModal';
import { PageSpinner } from '../../components/PageSpinner';
import { UserMinus, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface OnboardingRow { id: string; title: string; status: string; responsibleIds?: string[]; }
interface TicketRow { id: string; title: string; status: string; assigneeIds?: string[]; assigneeId?: string | null; }

type ScopeKey = 'tasks' | 'waitingOn' | 'subtaskAssignees' | 'series' | 'tickets' | 'onboarding';

const SCOPE_INFO: { key: ScopeKey; label: string; hint: string; optional?: boolean }[] = [
  { key: 'tasks', label: 'Assigned tasks', hint: 'task.assigneeIds' },
  { key: 'waitingOn', label: 'Waiting on them', hint: 'task.waitingOnUserId — the field that replaced person-named statuses' },
  { key: 'subtaskAssignees', label: 'Subtask assignees', hint: 'checklist items assigned to them on any task' },
  { key: 'series', label: 'Recurring series they own', hint: 'taskSeries.payload.assigneeIds — future occurrences too, not just minted ones' },
  { key: 'tickets', label: 'Open support tickets', hint: 'optional — see the note below before including this', optional: true },
  { key: 'onboarding', label: 'Onboarding checklist rows', hint: 'optional', optional: true },
];

const DEFAULT_SCOPE: ScopeKey[] = ['tasks', 'waitingOn', 'subtaskAssignees', 'series'];
const LIVE_STATUS_TYPES: TaskStatusType[] = ['scheduled', 'todo', 'active', 'waiting'];

interface Preview {
  tasks: Task[];
  waitingOn: Task[];
  subtaskAssignees: { task: Task; subtaskTitle: string }[];
  series: TaskSeries[];
  tickets: TicketRow[];
  onboarding: OnboardingRow[];
}

const EMPTY_PREVIEW: Preview = { tasks: [], waitingOn: [], subtaskAssignees: [], series: [], tickets: [], onboarding: [] };

export function ReassignPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [fromUserId, setFromUserId] = useState('');
  const [toUserIds, setToUserIds] = useState<string[]>([]);
  const [scope, setScope] = useState<ScopeKey[]>(DEFAULT_SCOPE);
  const [preview, setPreview] = useState<Preview>(EMPTY_PREVIEW);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState('');
  const [result, setResult] = useState<{ updated: number } | null>(null);

  useEffect(() => {
    if (!db) { setLoadingProfiles(false); return; }
    (async () => {
      try {
        const snap = await getDocs(query(collection(db!, 'profiles'), orderBy('name')));
        setProfiles(snap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile)));
      } catch (err) {
        console.error('Failed to load profiles:', err);
      } finally {
        setLoadingProfiles(false);
      }
    })();
  }, []);

  async function loadPreview(userId: string) {
    if (!db || !userId) { setPreview(EMPTY_PREVIEW); return; }
    setLoadingPreview(true);
    setPreviewError('');
    setResult(null);
    try {
      // One broad read of every live (+ scheduled) task, reused for three of the
      // four task-shaped categories — matches how functions/reassign.js scans
      // for subtask assignees, and avoids four separate round-trips.
      const liveTasks = await listTasks({ statusTypes: LIVE_STATUS_TYPES, includeScheduled: true, limit: 2000 });

      const tasksAssigned = liveTasks.filter((t) => !isTaskDone(t) && (t.assigneeIds ?? []).includes(userId));
      const waitingOn = liveTasks.filter((t) => !isTaskDone(t) && t.waitingOnUserId === userId);
      const subtaskAssignees: { task: Task; subtaskTitle: string }[] = [];
      for (const t of liveTasks) {
        if (isTaskDone(t)) continue;
        for (const s of t.subtasks ?? []) {
          if (!s.done && (s.assigneeIds ?? []).includes(userId)) subtaskAssignees.push({ task: t, subtaskTitle: s.title });
        }
      }

      const seriesSnap = await getDocs(query(collection(db, TASK_SERIES), where('active', '==', true)));
      const series = seriesSnap.docs
        .map((d) => ({ id: d.id, ...d.data() } as TaskSeries))
        .filter((s) => (s.payload?.assigneeIds ?? []).includes(userId));

      // Tickets: array-contains only for the preview (a quick, read-only look).
      // The callable itself also checks the legacy singular assigneeId field
      // before writing, so nothing is missed at commit time even if this
      // preview undercounts a pre-multi-assignee ticket.
      const ticketsSnap = await getDocs(query(collection(db, 'tickets'), where('assigneeIds', 'array-contains', userId)));
      const tickets = ticketsSnap.docs
        .map((d) => ({ id: d.id, ...d.data() } as TicketRow))
        .filter((t) => t.status === 'Open' || t.status === 'In Progress');

      const onboardingSnap = await getDocs(query(collection(db, 'onboardingTasks'), where('responsibleIds', 'array-contains', userId)));
      const onboarding = onboardingSnap.docs
        .map((d) => ({ id: d.id, ...d.data() } as OnboardingRow))
        .filter((r) => r.status !== 'Complete' && r.status !== 'N/A');

      setPreview({ tasks: tasksAssigned, waitingOn, subtaskAssignees, series, tickets, onboarding });
    } catch (err) {
      console.error('Failed to load reassign preview:', err);
      setPreviewError('Could not load what this person has assigned to them. Please try again.');
      setPreview(EMPTY_PREVIEW);
    } finally {
      setLoadingPreview(false);
    }
  }

  useEffect(() => {
    if (fromUserId) loadPreview(fromUserId);
    else setPreview(EMPTY_PREVIEW);
    setToUserIds([]);
    setResult(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- loadPreview is stable enough for this; re-running on its identity would refetch every render.
  }, [fromUserId]);

  const toggleScope = (key: ScopeKey) => {
    setScope((prev) => prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key]);
  };

  const counts: Record<ScopeKey, number> = {
    tasks: preview.tasks.length,
    waitingOn: preview.waitingOn.length,
    subtaskAssignees: preview.subtaskAssignees.length,
    series: preview.series.length,
    tickets: preview.tickets.length,
    onboarding: preview.onboarding.length,
  };
  const selectedTotal = scope.reduce((sum, key) => sum + counts[key], 0);
  const fromProfile = useMemo(() => profiles.find((p) => p.id === fromUserId) ?? null, [profiles, fromUserId]);
  const toProfiles = useMemo(() => profiles.filter((p) => toUserIds.includes(p.id)), [profiles, toUserIds]);
  const candidateProfiles = useMemo(() => profiles.filter((p) => p.id !== fromUserId), [profiles, fromUserId]);

  async function submit() {
    if (!functions || !fromUserId || toUserIds.length === 0 || scope.length === 0) return;
    setConfirming(false);
    setSubmitting(true);
    setActionError('');
    try {
      const call = httpsCallable<{ fromUserId: string; toUserIds: string[]; scope: ScopeKey[] }, { updated: number }>(functions, 'reassignWork');
      const res = await call({ fromUserId, toUserIds, scope });
      setResult(res.data);
      await loadPreview(fromUserId); // selected categories should now read empty (or smaller)
    } catch (err) {
      console.error('reassignWork failed:', err);
      const message = (err as { message?: string })?.message;
      setActionError(message || 'Could not reassign that work. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadingProfiles) return <PageSpinner />;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3">
        <UserMinus className="h-6 w-6 text-brand-dark" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-serif font-semibold text-gray-900">Reassign Work</h1>
          <p className="text-sm text-gray-500">Move everything assigned to a departing person onto whoever picks it up.</p>
        </div>
      </div>

      {actionError && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-md" role="alert">{actionError}</p>
      )}
      {result && (
        <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-4 py-3 rounded-md flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          Reassigned {result.updated} item{result.updated === 1 ? '' : 's'} from {fromProfile?.name ?? 'that person'} to {toProfiles.map((p) => p.name).join(', ')}.
        </p>
      )}

      <div className="bg-white shadow-sm rounded-xl border border-gray-200 p-6 space-y-5">
        <div className="space-y-1">
          <label htmlFor="from-user" className="block text-sm font-medium text-gray-700">Departing person</label>
          <select
            id="from-user"
            value={fromUserId}
            onChange={(e) => setFromUserId(e.target.value)}
            className="w-full sm:w-80 border border-gray-300 rounded-lg px-3 py-2 text-sm min-h-[44px]"
          >
            <option value="">— choose a person —</option>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>

        {fromUserId && (
          <>
            {loadingPreview ? (
              <PageSpinner />
            ) : previewError ? (
              <p className="text-sm text-red-600">{previewError}</p>
            ) : (
              <div className="space-y-2">
                <span className="block text-sm font-medium text-gray-700">What's assigned to {fromProfile?.name ?? 'them'} — pick which categories to move</span>
                <ul className="divide-y divide-gray-200 border border-gray-200 rounded-lg overflow-hidden">
                  {SCOPE_INFO.map((s) => (
                    <li key={s.key} className="flex items-start gap-3 px-4 py-3 bg-white">
                      <input
                        type="checkbox"
                        id={`scope-${s.key}`}
                        checked={scope.includes(s.key)}
                        onChange={() => toggleScope(s.key)}
                        disabled={counts[s.key] === 0}
                        className="mt-1 h-4 w-4"
                      />
                      <label htmlFor={`scope-${s.key}`} className="flex-1 cursor-pointer">
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900">{s.label}</span>
                          <span className="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-700">{counts[s.key]}</span>
                          {s.optional && <span className="text-[11px] uppercase tracking-wide text-gray-400">Optional</span>}
                        </span>
                        <span className="block text-xs text-gray-500">{s.hint}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                {scope.includes('tickets') && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
                    Reassigning tickets also triggers the normal "assigned to you" email for each ticket (Support Portal's existing ticket-notification code isn't suppressible from here yet) — the one-summary-email guarantee below applies fully to tasks, series, subtasks, and waiting-on, but not to tickets.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-1">
              <span className="block text-sm font-medium text-gray-700">Reassign to</span>
              <AssigneeSelector value={toUserIds} onChange={setToUserIds} admins={candidateProfiles} placeholder="Choose one or more people" />
              <p className="text-xs text-gray-500">Splitting across more than one person adds all of them as assignees on every moved task.</p>
            </div>

            <div className="pt-2 flex items-center justify-between border-t border-gray-100">
              <span className="text-sm text-gray-600">
                {selectedTotal === 0 ? 'Nothing selected to move.' : `${selectedTotal} item${selectedTotal === 1 ? '' : 's'} will be reassigned.`}
              </span>
              <button
                onClick={() => setConfirming(true)}
                disabled={submitting || selectedTotal === 0 || toUserIds.length === 0}
                className="inline-flex items-center justify-center px-5 py-2.5 min-h-[44px] text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#05391B] disabled:opacity-50 transition-colors"
              >
                {submitting ? 'Reassigning…' : 'Reassign'}
              </button>
            </div>
          </>
        )}
      </div>

      {fromUserId && !loadingPreview && !previewError && (
        <PreviewLists fromName={fromProfile?.name ?? 'them'} preview={preview} />
      )}

      <ConfirmModal
        open={confirming}
        title="Reassign Work"
        message={`Move ${selectedTotal} item${selectedTotal === 1 ? '' : 's'} from ${fromProfile?.name ?? 'this person'} to ${toProfiles.map((p) => p.name).join(', ')}? This can't be undone — ${fromProfile?.name ?? 'they'} will no longer be assigned to any of it.`}
        confirmLabel="Reassign"
        danger
        onConfirm={submit}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

/** Read-only detail underneath the picker — what's actually about to move. */
function PreviewLists({ fromName, preview }: { fromName: string; preview: Preview }) {
  const total = preview.tasks.length + preview.waitingOn.length + preview.subtaskAssignees.length + preview.series.length + preview.tickets.length + preview.onboarding.length;
  if (total === 0) {
    return (
      <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-10 text-center text-sm text-gray-500">
        {fromName} has nothing open assigned to them right now.
      </div>
    );
  }
  return (
    <div className="bg-white shadow-sm rounded-xl border border-gray-200 divide-y divide-gray-200">
      {preview.tasks.length > 0 && (
        <Section title="Assigned tasks">
          {preview.tasks.map((t) => <Row key={t.id} title={t.title} meta={t.statusName} />)}
        </Section>
      )}
      {preview.waitingOn.length > 0 && (
        <Section title="Waiting on them">
          {preview.waitingOn.map((t) => <Row key={t.id} title={t.title} meta={t.statusName} />)}
        </Section>
      )}
      {preview.subtaskAssignees.length > 0 && (
        <Section title="Subtask assignees">
          {preview.subtaskAssignees.map(({ task, subtaskTitle }, i) => (
            <Row key={`${task.id}-${i}`} title={subtaskTitle} meta={`on “${task.title}”`} />
          ))}
        </Section>
      )}
      {preview.series.length > 0 && (
        <Section title="Recurring series">
          {preview.series.map((s) => <Row key={s.id} title={s.name} meta={s.recurrence?.freq} />)}
        </Section>
      )}
      {preview.tickets.length > 0 && (
        <Section title="Open tickets">
          {preview.tickets.map((t) => <Row key={t.id} title={t.title} meta={t.status} />)}
        </Section>
      )}
      {preview.onboarding.length > 0 && (
        <Section title="Onboarding rows">
          {preview.onboarding.map((r) => <Row key={r.id} title={r.title} meta={r.status} />)}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-6 py-2 bg-gray-50/70 text-xs font-semibold uppercase tracking-wide text-gray-500">{title}</div>
      <ul className="divide-y divide-gray-100">{children}</ul>
    </div>
  );
}

function Row({ title, meta }: { title: string; meta?: string | null }) {
  return (
    <li className="px-6 py-2.5 flex items-center justify-between gap-3">
      <span className="text-sm text-gray-900 truncate">{title}</span>
      {meta && <span className="text-xs text-gray-400 flex-shrink-0">{meta}</span>}
    </li>
  );
}
