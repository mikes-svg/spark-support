import { useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, getDoc, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import {
  Activity,
  CheckSquare,
  Clock,
  Flag,
  MessageSquare,
  Sparkles,
  UserPlus,
  Users,
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { Avatar } from '../Avatar';
import { statusDefOf } from '../../lib/taskStatuses';
import { formatDateOnly, toDate } from '../../lib/dates';
import type { FsTimestamp } from '../../types';
import type { ComponentType } from 'react';
import type { Profile, Task, TaskComment, TaskEvent, TaskList, TaskStatusSet, TaskStatusType } from '../../types';

/**
 * Task activity feed — Phase 2. Reads `taskEvents` and `taskComments` (both
 * where taskId == …, both index-backed) and merges them into one newest-first
 * timeline. Every label is derived from the event's stored statusType/id or
 * the stored priority/date values, never from a hard-coded status list —
 * `statusType` is the only thing this codebase trusts a status for.
 */
export interface TaskActivityProps {
  taskId: string;
  /** Cap the feed and show a "show all" affordance past this many events. */
  initialCount?: number;
}

const STATUS_TYPE_LABEL: Record<TaskStatusType, string> = {
  scheduled: 'Scheduled',
  todo: 'To Do',
  active: 'In Progress',
  waiting: 'Waiting On',
  done: 'Done',
  closed: 'Closed',
};

type FeedRow =
  | { kind: 'event'; id: string; createdAt: FsTimestamp | undefined; event: TaskEvent }
  | { kind: 'comment'; id: string; createdAt: FsTimestamp | undefined; comment: TaskComment };

export function TaskActivity({ taskId, initialCount = 10 }: TaskActivityProps) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [statusSet, setStatusSet] = useState<TaskStatusSet | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  // Loaded profiles, mirrored into a ref so the two listeners (whose effects
  // only depend on taskId) can read the latest map instead of a stale closure,
  // avoiding refetching an actor/commenter we already have.
  const profilesRef = useRef<Record<string, Profile>>({});
  useEffect(() => { profilesRef.current = profiles; }, [profiles]);

  useEffect(() => {
    if (!db || !taskId) { setLoading(false); return; }

    // Resolve this task's status set once, to turn statusIds into display
    // names. Best-effort: an unresolved id still renders via its statusType.
    (async () => {
      try {
        const taskSnap = await getDoc(doc(db!, 'tasks', taskId));
        if (!taskSnap.exists()) return;
        const task = taskSnap.data() as Task;
        const listSnap = await getDoc(doc(db!, 'taskLists', task.listId));
        const list = listSnap.exists() ? (listSnap.data() as TaskList) : null;
        if (list?.defaultStatusSetId) {
          const setSnap = await getDoc(doc(db!, 'taskStatusSets', list.defaultStatusSetId));
          if (setSnap.exists()) setStatusSet({ id: setSnap.id, ...setSnap.data() } as TaskStatusSet);
        }
      } catch (err) {
        console.warn('Failed to resolve status set for activity labels:', err);
      }
    })();

    const resolveProfiles = async (ids: string[]) => {
      const missing = [...new Set(ids)].filter((id) => id && !profilesRef.current[id]);
      if (missing.length === 0) return;
      // One batch, not one read per row.
      const docs = await Promise.all(missing.map((id) => getDoc(doc(db!, 'profiles', id))));
      setProfiles((prev) => {
        const updated = { ...prev };
        docs.forEach((d) => { if (d.exists()) updated[d.id] = { id: d.id, ...d.data() } as Profile; });
        return updated;
      });
    };

    const unsubEvents = onSnapshot(
      query(collection(db, 'taskEvents'), where('taskId', '==', taskId), orderBy('createdAt', 'asc')),
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskEvent));
        setEvents(rows);
        setLoading(false);
        resolveProfiles(rows.flatMap((e) => [e.actorId, ...(e.toAssigneeIds ?? []), ...(e.fromAssigneeIds ?? [])]));
      },
      (err) => { console.warn('Task events listener failed:', err); setLoading(false); },
    );

    const unsubComments = onSnapshot(
      query(collection(db, 'taskComments'), where('taskId', '==', taskId), orderBy('createdAt', 'asc')),
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskComment));
        setComments(rows);
        resolveProfiles(rows.map((c) => c.userId));
      },
      (err) => console.warn('Task comments listener failed (activity feed):', err),
    );

    return () => { unsubEvents(); unsubComments(); };
  }, [taskId]);

  const statusLabel = (statusId?: string | null, statusType?: TaskStatusType | null): string => {
    const def = statusDefOf(statusSet, statusId);
    if (def) return def.name;
    if (statusType) return STATUS_TYPE_LABEL[statusType];
    return 'a status';
  };

  const nameOf = (id: string | null | undefined): string => (id && profiles[id]?.name) || 'Someone';

  const describeEvent = (event: TaskEvent): { text: string; Icon: ComponentType<{ className?: string }> } => {
    const actor = nameOf(event.actorId);
    switch (event.type) {
      case 'created':
        return { text: `${actor} created this task`, Icon: Sparkles };
      case 'status_changed':
        return {
          text: `${actor} moved this from ${statusLabel(event.fromStatusId, event.fromStatusType)} to ${statusLabel(event.toStatusId, event.toStatusType)}`,
          Icon: Activity,
        };
      case 'priority_changed':
        return {
          text: `${actor} changed priority from ${event.fromPriority ?? 'none'} to ${event.toPriority ?? 'none'}`,
          Icon: Flag,
        };
      case 'assignees_changed': {
        const from = event.fromAssigneeIds ?? [];
        const to = event.toAssigneeIds ?? [];
        const added = to.filter((id) => !from.includes(id)).map(nameOf);
        const removed = from.filter((id) => !to.includes(id)).map(nameOf);
        const parts: string[] = [];
        if (added.length) parts.push(`added ${added.join(', ')}`);
        if (removed.length) parts.push(`removed ${removed.join(', ')}`);
        return { text: `${actor} ${parts.join(' and ') || 'changed the assignees'}`, Icon: UserPlus };
      }
      case 'due_date_changed':
        return {
          text: `${actor} changed the due date from ${event.fromDueDate ? formatDateOnly(event.fromDueDate) : 'none'} to ${event.toDueDate ? formatDateOnly(event.toDueDate) : 'none'}`,
          Icon: Clock,
        };
      case 'subtask_toggled':
        return { text: `${actor} ${event.note === 'unchecked' ? 'unchecked' : 'checked off'} a subtask`, Icon: CheckSquare };
      case 'activated':
        return { text: `${actor} activated this task`, Icon: Sparkles };
      case 'occurrence_created':
        return { text: `A new occurrence was generated from this series`, Icon: Sparkles };
      case 'missed_occurrence':
        return { text: `An occurrence was missed${event.note ? ` — ${event.note}` : ''}`, Icon: Clock };
      case 'reassigned':
        return { text: `${actor} reassigned this task${event.note ? ` — ${event.note}` : ''}`, Icon: Users };
      case 'commented':
      default:
        return { text: `${actor} commented`, Icon: MessageSquare };
    }
  };

  const rows: FeedRow[] = useMemo(() => {
    // 'commented' taskEvents exist for future metrics (first-response, cycle
    // time) — the comment itself, with its body, is what renders here, so a
    // commented-type event is excluded to avoid a duplicate line.
    const eventRows: FeedRow[] = events
      .filter((e) => e.type !== 'commented')
      .map((e) => ({ kind: 'event', id: e.id, createdAt: e.createdAt, event: e }));
    const commentRows: FeedRow[] = comments.map((c) => ({ kind: 'comment', id: c.id, createdAt: c.createdAt, comment: c }));
    return [...eventRows, ...commentRows].sort((a, b) => {
      const ta = toDate(a.createdAt)?.getTime() ?? 0;
      const tb = toDate(b.createdAt)?.getTime() ?? 0;
      return tb - ta; // newest first
    });
  }, [events, comments]);

  if (loading) {
    return (
      <div className="rounded-lg border border-gray-200 px-4 py-6 text-center text-sm text-gray-400">
        Loading activity…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500">
        No activity yet.
      </div>
    );
  }

  const visible = expanded ? rows : rows.slice(0, initialCount);

  return (
    <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50">
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-widest">Activity</h3>
      </div>
      <div className="p-6">
        <ul className="space-y-4">
          {visible.map((row) => {
            const when = toDate(row.createdAt);
            if (row.kind === 'comment') {
              const author = profiles[row.comment.userId];
              return (
                <li key={`c-${row.id}`} className="flex items-start gap-3">
                  <Avatar src={author?.photoURL} name={author?.name} className="w-7 h-7 rounded-full flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900">
                      <span className="font-medium">{author?.name || 'Someone'}</span> commented: <span className="text-gray-600">"{row.comment.body.length > 140 ? `${row.comment.body.slice(0, 140)}…` : row.comment.body}"</span>
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">{when ? when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</p>
                  </div>
                </li>
              );
            }
            const { text, Icon } = describeEvent(row.event);
            return (
              <li key={`e-${row.id}`} className="flex items-start gap-3">
                <span className="mt-0.5 flex-shrink-0 w-7 h-7 rounded-full bg-brand-dark/5 flex items-center justify-center">
                  <Icon className="w-3.5 h-3.5 text-brand-dark" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-900">{text}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{when ? when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</p>
                </div>
              </li>
            );
          })}
        </ul>
        {rows.length > initialCount && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-4 min-h-[44px] text-xs font-medium text-brand-dark hover:text-brand-gold transition-colors"
          >
            {expanded ? 'Show less' : `Show all ${rows.length}`}
          </button>
        )}
      </div>
    </div>
  );
}
