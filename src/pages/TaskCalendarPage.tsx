/**
 * Calendar — Phase 4 of docs/CLICKUP_MIGRATION_PLAN.md.
 *
 * A month grid of every task with a due date, built by hand with the date
 * helpers in src/lib/dates.ts (there is no calendar library, and none may be
 * added). `month` and the grid's own day cells are all 'YYYY-MM'/'YYYY-MM-DD'
 * strings — see CalendarGrid.tsx for why they're never run through
 * `new Date(dateStr)`.
 *
 * Task visibility is OPEN (§2), so this queries across every task in the
 * workspace, not just the signed-in user's own.
 */
import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { db } from '../lib/firebase';
import { listTasks } from '../lib/tasks';
import { getOrSeedStatusSets } from '../lib/taskStatuses';
import { toDateOnly, todayStr } from '../lib/dates';
import { CalendarGrid } from '../components/tasks/CalendarGrid';
import { TaskFilters } from '../components/tasks/TaskFilters';
import { TaskRow } from '../components/tasks/shared/TaskRow';
import { PageSpinner } from '../components/PageSpinner';
import type { Profile, Task, TaskFilter, TaskList, TaskStatusSet, TaskTag } from '../types';

/** The Sunday-to-Saturday span the 6-week grid actually covers for `month`
 *  ('YYYY-MM'), built the same way CalendarGrid builds its cells, so tasks
 *  that spill into a leading/trailing week from an adjacent month still load. */
function monthGridRange(month: string): { start: string; end: string } {
  const [yearStr, monthStr] = month.split('-');
  const year = Number(yearStr);
  const monthIndex = Number(monthStr) - 1;
  const firstOfMonth = new Date(year, monthIndex, 1);
  const gridStart = new Date(year, monthIndex, 1 - firstOfMonth.getDay());
  const gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + 41);
  return { start: toDateOnly(gridStart), end: toDateOnly(gridEnd) };
}

function shiftMonth(month: string, delta: number): string {
  const [yearStr, monthStr] = month.split('-');
  const d = new Date(Number(yearStr), Number(monthStr) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month: string): string {
  const [yearStr, monthStr] = month.split('-');
  return new Date(Number(yearStr), Number(monthStr) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function TaskCalendarPage() {
  const navigate = useNavigate();
  const today = todayStr();
  const [month, setMonth] = useState(() => today.slice(0, 7));
  const [tasks, setTasks] = useState<Task[]>([]);
  const [lists, setLists] = useState<TaskList[]>([]);
  const [statusSets, setStatusSets] = useState<TaskStatusSet[]>([]);
  const [people, setPeople] = useState<Profile[]>([]);
  const [tags, setTags] = useState<Record<string, TaskTag>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Filters TaskFilters manages. The date range comes from the grid itself —
  // it IS the date picker — so 'due' is hidden below and this never carries
  // dueFrom/dueTo.
  const [filter, setFilter] = useState<TaskFilter>({});
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  useEffect(() => {
    if (!db) { setLoading(false); return; }
    (async () => {
      try {
        const [listSnap, sets, peopleSnap, tagSnap] = await Promise.all([
          getDocs(collection(db!, 'taskLists')),
          getOrSeedStatusSets(),
          getDocs(collection(db!, 'profiles')),
          getDocs(collection(db!, 'taskTags')),
        ]);
        setLists(listSnap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskList)));
        setStatusSets(sets);
        setPeople(peopleSnap.docs.map((d) => ({ id: d.id, ...d.data() } as Profile)));
        const tagMap: Record<string, TaskTag> = {};
        tagSnap.docs.forEach((d) => { tagMap[d.id] = { id: d.id, ...d.data() } as TaskTag; });
        setTags(tagMap);
      } catch (err) {
        console.error('Failed to load task reference data:', err);
      }
    })();
  }, []);

  useEffect(() => {
    if (!db) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(false);
    const { start, end } = monthGridRange(month);
    listTasks({ ...filter, dueFrom: start, dueTo: end })
      .then((rows) => { if (!cancelled) setTasks(rows); })
      .catch((err) => {
        console.error('Failed to load tasks:', err);
        if (!cancelled) setError(true);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month, filter]);

  const peopleById = useMemo(() => {
    const map: Record<string, Profile> = {};
    people.forEach((p) => { map[p.id] = p; });
    return map;
  }, [people]);

  const selectedDayTasks = useMemo(
    () => (selectedDate ? tasks.filter((t) => t.dueDate === selectedDate) : []),
    [selectedDate, tasks],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:justify-between sm:items-center">
        <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-widest">Calendar</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
            aria-label="Previous month"
            className="flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 rounded-md border border-gray-300 bg-white hover:bg-gray-50 transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[9rem] text-center text-sm font-medium text-gray-900">{monthLabel(month)}</span>
          <button
            type="button"
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
            aria-label="Next month"
            className="flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 rounded-md border border-gray-300 bg-white hover:bg-gray-50 transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setMonth(today.slice(0, 7))}
            className="min-h-[44px] sm:min-h-0 px-3 py-2 text-sm font-medium rounded-md border border-gray-300 bg-white hover:bg-gray-50 transition-colors"
          >
            Today
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <TaskFilters value={filter} onChange={setFilter} lists={lists} statusSets={statusSets} people={people} hide={['due']} />
        <label className="flex items-center gap-2 min-h-[44px] sm:min-h-0 text-sm text-gray-700 whitespace-nowrap">
          <input
            type="checkbox"
            checked={filter.includeScheduled ?? false}
            onChange={(e) => setFilter((f) => ({ ...f, includeScheduled: e.target.checked }))}
            className="h-4 w-4 rounded border-gray-300 text-brand-dark focus:ring-brand-dark"
          />
          Include scheduled (pre-live) tasks
        </label>
      </div>

      {loading ? (
        <PageSpinner />
      ) : error ? (
        <div className="bg-white shadow-sm rounded-lg border border-gray-200 px-6 py-12 text-center text-sm text-red-600">
          Couldn't load the calendar. Check your connection and refresh.
        </div>
      ) : (
        <>
          <CalendarGrid
            month={month}
            tasks={tasks}
            today={today}
            people={peopleById}
            onSelectDate={setSelectedDate}
            onOpenTask={(taskId) => navigate(`/tasks/${taskId}`)}
          />

          {selectedDate && (
            <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
                <h3 className="text-sm font-serif font-semibold text-gray-900 flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-gray-400" aria-hidden="true" />
                  {selectedDate}
                </h3>
                <button
                  type="button"
                  onClick={() => setSelectedDate(null)}
                  aria-label="Close"
                  className="flex items-center justify-center h-8 w-8 rounded-md hover:bg-gray-100 text-gray-400"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              {selectedDayTasks.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-gray-500">No tasks due this day.</p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {selectedDayTasks.map((task) => (
                    <TaskRow key={task.id} task={task} today={today} people={peopleById} tags={tags} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
