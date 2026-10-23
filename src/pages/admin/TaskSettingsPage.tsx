/**
 * Task Settings — Phase 7 of docs/CLICKUP_MIGRATION_PLAN.md.
 *
 * CRUD over the hierarchy tasks are organized by: spaces, lists, status sets
 * (and their statuses), and tags. Follows the inline-edit-in-a-table pattern
 * from AdminSettingsPage.tsx — optimistic update, rollback, one actionError
 * banner — rather than a form-per-row.
 *
 * The one piece of this page that isn't routine CRUD: a status's TYPE.
 * CONTRACTS-TASKS.md is explicit that every metric, digest, and carryover rule
 * keys off statusType, never the label — so getting the type right when adding
 * a status matters far more than the wording, and getting it WRONG silently
 * mis-files a status in every downstream count with no error anywhere. The
 * status editor below makes the type the most prominent field, not an
 * afterthought next to the name.
 */
import { useEffect, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getCountFromServer,
  getDocs,
  orderBy,
  query,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { TASKS, TASK_LISTS, TASK_SPACES } from '../../lib/tasks';
import { STATUS_SETS_COLLECTION, getOrSeedStatusSets } from '../../lib/taskStatuses';
import { listTaskTags, createTaskTag, updateTaskTag, deleteTaskTag } from '../../lib/taskTags';
import { Modal } from '../../components/Modal';
import { ConfirmModal } from '../../components/ConfirmModal';
import { PageSpinner } from '../../components/PageSpinner';
import { TaskStatusPill } from '../../components/tasks/shared/TaskStatusPill';
import { TaskTagPill } from '../../components/tasks/shared/TaskTagPill';
import type { TaskList, TaskSpace, TaskStatusDef, TaskStatusSet, TaskStatusType, TaskTag } from '../../types';
import {
  SlidersHorizontal, Plus, Trash2, Edit2, Check, X, ArrowUp, ArrowDown,
  Archive, ArchiveRestore, Info, Tag as TagIcon,
} from 'lucide-react';

type TabKey = 'lists' | 'statuses' | 'tags';

const STATUS_TYPE_INFO: { value: TaskStatusType; label: string; hint: string }[] = [
  { value: 'todo', label: 'To Do', hint: 'Open work, not started yet.' },
  { value: 'active', label: 'Active', hint: 'Currently being worked.' },
  { value: 'waiting', label: 'Waiting On', hint: 'Blocked on someone — pairs with a "waiting on" person, never a person\'s name in the status itself.' },
  { value: 'done', label: 'Done', hint: 'Completed. Counts as finished everywhere.' },
  { value: 'closed', label: 'Closed', hint: 'No longer relevant — also counts as finished, but isn\'t completed work.' },
  { value: 'scheduled', label: 'Scheduled (pre-live)', hint: 'Hidden from lists, the calendar, and digests until its go-live date, then flips automatically — the same mechanic ticket Scheduled uses.' },
];

const COLOR_PRESETS = ['#6B7280', '#B45309', '#EA580C', '#7C3AED', '#16A34A', '#9CA3AF', '#0EA5E9', '#DB2777', '#CA8A04', '#0891B2'];

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'status';
}

/**
 * A status id unique across EVERY set, not just its own — prefixed with the
 * set's doc id (itself globally unique) rather than a bare slug. Two sets both
 * naming a status "To Do" would otherwise both mint the id "to-do", and then
 * "which tasks use this status" (below, guarding delete) couldn't tell them
 * apart without a statusId+listId composite index that doesn't exist. Prefixing
 * makes every id unambiguous, so a plain `where('statusId', '==', id)` is
 * always correct on its own — no extra index, no cross-set ambiguity.
 */
function uniqueStatusId(setId: string, name: string, existing: TaskStatusDef[]): string {
  const base = `${setId}_${slugify(name)}`;
  if (!existing.some((s) => s.id === base)) return base;
  let n = 2;
  while (existing.some((s) => s.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function TaskSettingsPage() {
  const [tab, setTab] = useState<TabKey>('lists');
  const [spaces, setSpaces] = useState<TaskSpace[]>([]);
  const [lists, setLists] = useState<TaskList[]>([]);
  const [statusSets, setStatusSets] = useState<TaskStatusSet[]>([]);
  const [tags, setTags] = useState<TaskTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState('');

  async function load() {
    if (!db) { setLoading(false); return; }
    try {
      const [spacesSnap, listsSnap, sets, tagRows] = await Promise.all([
        getDocs(query(collection(db, TASK_SPACES), orderBy('order'))),
        getDocs(query(collection(db, TASK_LISTS), orderBy('order'))),
        getOrSeedStatusSets(),
        listTaskTags(),
      ]);
      setSpaces(spacesSnap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskSpace)));
      setLists(listsSnap.docs.map((d) => ({ id: d.id, ...d.data() } as TaskList)));
      setStatusSets(sets);
      setTags(tagRows);
    } catch (err) {
      console.error('Failed to load task settings:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  if (loading) return <PageSpinner />;

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-3">
        <SlidersHorizontal className="h-6 w-6 text-brand-dark" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-serif font-semibold text-gray-900">Task Settings</h1>
          <p className="text-sm text-gray-500">Spaces, lists, status sets, and tags.</p>
        </div>
      </div>

      {actionError && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-md" role="alert">{actionError}</p>
      )}

      <div className="flex gap-1 border-b border-gray-200 overflow-x-auto">
        {([['lists', 'Spaces & Lists'], ['statuses', 'Status Sets'], ['tags', 'Tags']] as [TabKey, string][]).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap min-h-[44px] transition-colors ${tab === key ? 'border-brand-dark text-brand-dark' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'lists' && (
        <SpacesAndLists
          spaces={spaces} lists={lists} statusSets={statusSets}
          setSpaces={setSpaces} setLists={setLists}
          setActionError={setActionError}
        />
      )}
      {tab === 'statuses' && (
        <StatusSets
          statusSets={statusSets} lists={lists}
          setStatusSets={setStatusSets}
          setActionError={setActionError}
        />
      )}
      {tab === 'tags' && (
        <Tags tags={tags} setTags={setTags} setActionError={setActionError} />
      )}
    </div>
  );
}

// ─── Spaces & Lists ────────────────────────────────────────────────────────

function SpacesAndLists({
  spaces, lists, statusSets, setSpaces, setLists, setActionError,
}: {
  spaces: TaskSpace[]; lists: TaskList[]; statusSets: TaskStatusSet[];
  setSpaces: React.Dispatch<React.SetStateAction<TaskSpace[]>>;
  setLists: React.Dispatch<React.SetStateAction<TaskList[]>>;
  setActionError: (msg: string) => void;
}) {
  const [showAddSpace, setShowAddSpace] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState('');
  const [savingSpace, setSavingSpace] = useState(false);

  const [showAddList, setShowAddList] = useState(false);
  const [newListName, setNewListName] = useState('');
  // Optional parent, giving Space > List > Sub-list. Empty means top level.
  const [newListParentId, setNewListParentId] = useState('');
  const [newListSpaceId, setNewListSpaceId] = useState('');
  const [newListStatusSetId, setNewListStatusSetId] = useState('');
  const [savingList, setSavingList] = useState(false);

  const [editingSpaceId, setEditingSpaceId] = useState<string | null>(null);
  const [editingSpaceName, setEditingSpaceName] = useState('');
  const [editingListId, setEditingListId] = useState<string | null>(null);
  const [editingListName, setEditingListName] = useState('');

  const [deleteSpaceTarget, setDeleteSpaceTarget] = useState<TaskSpace | null>(null);
  const [deleteSpaceBlocked, setDeleteSpaceBlocked] = useState(false);
  const [deleteListTarget, setDeleteListTarget] = useState<TaskList | null>(null);
  const [deleteListBlocked, setDeleteListBlocked] = useState<number | null>(null);

  async function addSpace() {
    const name = newSpaceName.trim();
    if (!name || !db) return;
    setSavingSpace(true);
    try {
      const order = spaces.length ? Math.max(...spaces.map((s) => s.order)) + 1 : 0;
      const ref = await addDoc(collection(db, TASK_SPACES), { name, order, archived: false });
      setSpaces((prev) => [...prev, { id: ref.id, name, order, archived: false }]);
      setShowAddSpace(false);
      setNewSpaceName('');
    } catch (err) {
      console.error('Failed to add space:', err);
      setActionError('Could not add the space. Please try again.');
    } finally {
      setSavingSpace(false);
    }
  }

  async function renameSpace(space: TaskSpace) {
    const name = editingSpaceName.trim();
    setEditingSpaceId(null);
    if (!name || name === space.name || !db) return;
    setActionError('');
    setSpaces((prev) => prev.map((s) => s.id === space.id ? { ...s, name } : s));
    try {
      await updateDoc(doc(db, TASK_SPACES, space.id), { name });
    } catch (err) {
      console.error('Failed to rename space:', err);
      setSpaces((prev) => prev.map((s) => s.id === space.id ? { ...s, name: space.name } : s));
      setActionError('Could not rename the space. Please try again.');
    }
  }

  async function toggleArchiveSpace(space: TaskSpace) {
    if (!db) return;
    const next = !space.archived;
    setActionError('');
    setSpaces((prev) => prev.map((s) => s.id === space.id ? { ...s, archived: next } : s));
    try {
      await updateDoc(doc(db, TASK_SPACES, space.id), { archived: next });
    } catch (err) {
      console.error('Failed to update space:', err);
      setSpaces((prev) => prev.map((s) => s.id === space.id ? { ...s, archived: space.archived } : s));
      setActionError('Could not update the space. Please try again.');
    }
  }

  async function requestDeleteSpace(space: TaskSpace) {
    if (!db) return;
    setActionError('');
    const listCount = lists.filter((l) => l.spaceId === space.id).length;
    setDeleteSpaceBlocked(listCount > 0);
    setDeleteSpaceTarget(space);
  }

  async function confirmDeleteSpace() {
    const target = deleteSpaceTarget;
    setDeleteSpaceTarget(null);
    if (!target || !db || deleteSpaceBlocked) return;
    setSpaces((prev) => prev.filter((s) => s.id !== target.id));
    try {
      await deleteDoc(doc(db, TASK_SPACES, target.id));
    } catch (err) {
      console.error('Failed to delete space:', err);
      setSpaces((prev) => [...prev, target].sort((a, b) => a.order - b.order));
      setActionError('Could not delete the space. Please try again.');
    }
  }

  function openAddList() {
    setNewListName('');
    setNewListSpaceId(spaces[0]?.id ?? '');
    setNewListStatusSetId(statusSets[0]?.id ?? '');
    setShowAddList(true);
  }

  async function addList() {
    const name = newListName.trim();
    if (!name || !newListSpaceId || !db) return;
    setSavingList(true);
    try {
      const siblings = lists.filter((l) => l.spaceId === newListSpaceId);
      const order = siblings.length ? Math.max(...siblings.map((l) => l.order)) + 1 : 0;
      // Only a top-level list in the chosen space may be a parent, which keeps the
      // hierarchy one level deep without needing cycle detection.
      const parentValid = newListParentId
        && lists.some((l) => l.id === newListParentId && l.spaceId === newListSpaceId && !l.parentListId);
      const data = {
        spaceId: newListSpaceId,
        name,
        order,
        archived: false,
        defaultStatusSetId: newListStatusSetId || null,
        parentListId: parentValid ? newListParentId : null,
      };
      const ref = await addDoc(collection(db, TASK_LISTS), data);
      setLists((prev) => [...prev, { id: ref.id, ...data }]);
      setShowAddList(false);
    } catch (err) {
      console.error('Failed to add list:', err);
      setActionError('Could not add the list. Please try again.');
    } finally {
      setSavingList(false);
    }
  }

  async function renameList(list: TaskList) {
    const name = editingListName.trim();
    setEditingListId(null);
    if (!name || name === list.name || !db) return;
    setActionError('');
    setLists((prev) => prev.map((l) => l.id === list.id ? { ...l, name } : l));
    try {
      await updateDoc(doc(db, TASK_LISTS, list.id), { name });
    } catch (err) {
      console.error('Failed to rename list:', err);
      setLists((prev) => prev.map((l) => l.id === list.id ? { ...l, name: list.name } : l));
      setActionError('Could not rename the list. Please try again.');
    }
  }

  async function updateListStatusSet(list: TaskList, statusSetId: string) {
    if (!db) return;
    setActionError('');
    setLists((prev) => prev.map((l) => l.id === list.id ? { ...l, defaultStatusSetId: statusSetId } : l));
    try {
      await updateDoc(doc(db, TASK_LISTS, list.id), { defaultStatusSetId: statusSetId });
    } catch (err) {
      console.error('Failed to update list status set:', err);
      setLists((prev) => prev.map((l) => l.id === list.id ? { ...l, defaultStatusSetId: list.defaultStatusSetId } : l));
      setActionError('Could not update the status set. Please try again.');
    }
  }

  async function toggleArchiveList(list: TaskList) {
    if (!db) return;
    const next = !list.archived;
    setActionError('');
    setLists((prev) => prev.map((l) => l.id === list.id ? { ...l, archived: next } : l));
    try {
      await updateDoc(doc(db, TASK_LISTS, list.id), { archived: next });
    } catch (err) {
      console.error('Failed to update list:', err);
      setLists((prev) => prev.map((l) => l.id === list.id ? { ...l, archived: list.archived } : l));
      setActionError('Could not update the list. Please try again.');
    }
  }

  async function requestDeleteList(list: TaskList) {
    if (!db) return;
    setActionError('');
    try {
      const snap = await getCountFromServer(query(collection(db, TASKS), where('listId', '==', list.id)));
      setDeleteListBlocked(snap.data().count);
    } catch (err) {
      console.error('Failed to check list usage:', err);
      setDeleteListBlocked(null);
    }
    setDeleteListTarget(list);
  }

  async function confirmDeleteList() {
    const target = deleteListTarget;
    setDeleteListTarget(null);
    if (!target || !db || (deleteListBlocked ?? 0) > 0) return;
    setLists((prev) => prev.filter((l) => l.id !== target.id));
    try {
      await deleteDoc(doc(db, TASK_LISTS, target.id));
    } catch (err) {
      console.error('Failed to delete list:', err);
      setLists((prev) => [...prev, target].sort((a, b) => a.order - b.order));
      setActionError('Could not delete the list. Please try again.');
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50 flex justify-between items-center gap-3">
          <h2 className="text-base font-serif font-semibold text-gray-900">Spaces</h2>
          <button onClick={() => { setNewSpaceName(''); setShowAddSpace(true); }} className="inline-flex items-center justify-center px-3 py-2 min-h-[44px] border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 shadow-sm">
            <Plus className="h-4 w-4 mr-1.5" />Add Space
          </button>
        </div>
        <ul className="divide-y divide-gray-200">
          {spaces.length === 0 && <li className="px-6 py-8 text-center text-sm text-gray-500">No spaces yet.</li>}
          {spaces.map((space) => (
            <li key={space.id} className="px-6 py-3 flex items-center justify-between gap-3">
              {editingSpaceId === space.id ? (
                <div className="flex items-center gap-2 flex-1">
                  <input value={editingSpaceName} onChange={(e) => setEditingSpaceName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') renameSpace(space); }} autoFocus className="border border-gray-300 rounded px-2 py-1.5 text-sm flex-1 max-w-xs" />
                  <button onClick={() => renameSpace(space)} className="text-emerald-600 hover:text-emerald-800 p-1"><Check className="h-4 w-4" /></button>
                  <button onClick={() => setEditingSpaceId(null)} className="text-gray-400 hover:text-gray-600 p-1"><X className="h-4 w-4" /></button>
                </div>
              ) : (
                <span className={`text-sm font-medium ${space.archived ? 'text-gray-400 line-through' : 'text-gray-900'}`}>{space.name}</span>
              )}
              <div className="flex items-center gap-1 text-gray-400">
                <span className="text-xs text-gray-400 mr-2">{lists.filter((l) => l.spaceId === space.id).length} list(s)</span>
                <button onClick={() => { setEditingSpaceId(space.id); setEditingSpaceName(space.name); }} aria-label={`Rename ${space.name}`} className="p-2 hover:text-brand-dark"><Edit2 className="h-4 w-4" /></button>
                <button onClick={() => toggleArchiveSpace(space)} aria-label={space.archived ? `Restore ${space.name}` : `Archive ${space.name}`} className="p-2 hover:text-brand-dark">
                  {space.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                </button>
                <button onClick={() => requestDeleteSpace(space)} aria-label={`Delete ${space.name}`} className="p-2 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50 flex justify-between items-center gap-3">
          <h2 className="text-base font-serif font-semibold text-gray-900">Lists</h2>
          <button onClick={openAddList} disabled={spaces.length === 0} className="inline-flex items-center justify-center px-3 py-2 min-h-[44px] border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 shadow-sm disabled:opacity-50">
            <Plus className="h-4 w-4 mr-1.5" />Add List
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-white">
              <tr>{['List', 'Space', 'Status Set', 'Actions'].map((h) => <th key={h} scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>)}</tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {lists.length === 0 && (
                <tr><td colSpan={4} className="px-6 py-12 text-center text-sm text-gray-500">No lists yet. {spaces.length === 0 ? 'Add a space first.' : 'Click "Add List" to create one.'}</td></tr>
              )}
              {lists.map((list) => (
                <tr key={list.id}>
                  <td className="px-6 py-3 text-sm font-medium">
                    {editingListId === list.id ? (
                      <div className="flex items-center gap-2">
                        <input value={editingListName} onChange={(e) => setEditingListName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') renameList(list); }} autoFocus className="border border-gray-300 rounded px-2 py-1.5 text-sm" />
                        <button onClick={() => renameList(list)} className="text-emerald-600 hover:text-emerald-800 p-1"><Check className="h-4 w-4" /></button>
                        <button onClick={() => setEditingListId(null)} className="text-gray-400 hover:text-gray-600 p-1"><X className="h-4 w-4" /></button>
                      </div>
                    ) : (
                      <span className={list.archived ? 'text-gray-400 line-through' : 'text-gray-900'}>{list.name}</span>
                    )}
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-500">{spaces.find((s) => s.id === list.spaceId)?.name ?? '—'}</td>
                  <td className="px-6 py-3 text-sm text-gray-500">
                    <select
                      value={list.defaultStatusSetId ?? ''}
                      onChange={(e) => updateListStatusSet(list, e.target.value)}
                      className="border border-gray-300 rounded px-2 py-1.5 text-sm min-h-[36px]"
                    >
                      <option value="">— none —</option>
                      {statusSets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </td>
                  <td className="px-6 py-3 text-right text-sm space-x-1 whitespace-nowrap">
                    <button onClick={() => { setEditingListId(list.id); setEditingListName(list.name); }} aria-label={`Rename ${list.name}`} className="p-2 text-gray-400 hover:text-brand-dark inline-block"><Edit2 className="h-4 w-4" /></button>
                    <button onClick={() => toggleArchiveList(list)} aria-label={list.archived ? `Restore ${list.name}` : `Archive ${list.name}`} className="p-2 text-gray-400 hover:text-brand-dark inline-block">
                      {list.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                    </button>
                    <button onClick={() => requestDeleteList(list)} aria-label={`Delete ${list.name}`} className="p-2 text-red-400 hover:text-red-600 inline-block"><Trash2 className="h-4 w-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={showAddSpace} onClose={() => setShowAddSpace(false)} labelledBy="add-space-title" widthClass="max-w-sm">
        <div className="px-6 py-5 border-b border-gray-200"><h3 id="add-space-title" className="text-lg font-serif font-semibold text-gray-900">Add Space</h3></div>
        <div className="p-6 space-y-2">
          <label htmlFor="new-space-name" className="block text-sm font-medium text-gray-700">Space name</label>
          <input id="new-space-name" value={newSpaceName} onChange={(e) => setNewSpaceName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addSpace(); }} autoFocus placeholder="e.g. Operations" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark" />
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 bg-gray-50/50">
          <button onClick={() => setShowAddSpace(false)} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">Cancel</button>
          <button onClick={addSpace} disabled={savingSpace || !newSpaceName.trim()} className="px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#05391B] disabled:opacity-50">{savingSpace ? 'Adding…' : 'Add Space'}</button>
        </div>
      </Modal>

      <Modal open={showAddList} onClose={() => setShowAddList(false)} labelledBy="add-list-title" widthClass="max-w-sm">
        <div className="px-6 py-5 border-b border-gray-200"><h3 id="add-list-title" className="text-lg font-serif font-semibold text-gray-900">Add List</h3></div>
        <div className="p-6 space-y-4">
          <div className="space-y-1">
            <label htmlFor="new-list-name" className="block text-sm font-medium text-gray-700">List name</label>
            <input id="new-list-name" value={newListName} onChange={(e) => setNewListName(e.target.value)} autoFocus placeholder="e.g. Marketing" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark" />
          </div>
          <div className="space-y-1">
            <label htmlFor="new-list-space" className="block text-sm font-medium text-gray-700">Space</label>
            <select id="new-list-space" value={newListSpaceId} onChange={(e) => setNewListSpaceId(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm min-h-[44px]">
              {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="new-list-parent" className="block text-sm font-medium text-gray-700">Inside another list (optional)</label>
            <select
              id="new-list-parent"
              value={newListParentId}
              onChange={(e) => setNewListParentId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm min-h-[44px]"
            >
              <option value="">— top level —</option>
              {lists
                .filter((l) => l.spaceId === newListSpaceId && !l.parentListId && !l.archived)
                .map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <p className="text-xs text-gray-500">
              Makes this a sub-list, e.g. Accounting &rsaquo; FOM Activities &rsaquo; Housing. Sub-lists
              cannot contain further lists.
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor="new-list-statusset" className="block text-sm font-medium text-gray-700">Status set</label>
            <select id="new-list-statusset" value={newListStatusSetId} onChange={(e) => setNewListStatusSetId(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm min-h-[44px]">
              <option value="">— none yet —</option>
              {statusSets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 bg-gray-50/50">
          <button onClick={() => { setShowAddList(false); setNewListParentId(''); }} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">Cancel</button>
          <button onClick={addList} disabled={savingList || !newListName.trim() || !newListSpaceId} className="px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#05391B] disabled:opacity-50">{savingList ? 'Adding…' : 'Add List'}</button>
        </div>
      </Modal>

      <ConfirmModal
        open={!!deleteSpaceTarget}
        title={deleteSpaceBlocked ? "Can't Delete Space" : 'Delete Space'}
        message={
          deleteSpaceTarget
            ? deleteSpaceBlocked
              ? `"${deleteSpaceTarget.name}" still has ${lists.filter((l) => l.spaceId === deleteSpaceTarget.id).length} list(s). Move or delete those first.`
              : `Delete "${deleteSpaceTarget.name}"? This can't be undone.`
            : ''
        }
        confirmLabel={deleteSpaceBlocked ? 'OK' : 'Delete'}
        danger={!deleteSpaceBlocked}
        onConfirm={deleteSpaceBlocked ? () => setDeleteSpaceTarget(null) : confirmDeleteSpace}
        onCancel={() => setDeleteSpaceTarget(null)}
      />

      <ConfirmModal
        open={!!deleteListTarget}
        title={(deleteListBlocked ?? 0) > 0 ? "Can't Delete List" : 'Delete List'}
        message={
          deleteListTarget
            ? deleteListBlocked === null
              ? 'Could not check whether tasks still use this list. Try again.'
              : deleteListBlocked > 0
                ? `"${deleteListTarget.name}" still has ${deleteListBlocked} task(s). Move them to another list (or archive the list instead) before deleting it.`
                : `Delete "${deleteListTarget.name}"? This can't be undone.`
            : ''
        }
        confirmLabel={(deleteListBlocked ?? 0) > 0 || deleteListBlocked === null ? 'OK' : 'Delete'}
        danger={!((deleteListBlocked ?? 0) > 0 || deleteListBlocked === null)}
        onConfirm={(deleteListBlocked ?? 0) > 0 || deleteListBlocked === null ? () => setDeleteListTarget(null) : confirmDeleteList}
        onCancel={() => setDeleteListTarget(null)}
      />
    </div>
  );
}

// ─── Status Sets ───────────────────────────────────────────────────────────

function StatusSets({
  statusSets, lists, setStatusSets, setActionError,
}: {
  statusSets: TaskStatusSet[]; lists: TaskList[];
  setStatusSets: React.Dispatch<React.SetStateAction<TaskStatusSet[]>>;
  setActionError: (msg: string) => void;
}) {
  const [showAddSet, setShowAddSet] = useState(false);
  const [newSetName, setNewSetName] = useState('');
  const [savingSet, setSavingSet] = useState(false);
  const [deleteSetTarget, setDeleteSetTarget] = useState<TaskStatusSet | null>(null);

  const [statusEditor, setStatusEditor] = useState<{ setId: string; status: TaskStatusDef | null } | null>(null);
  const [deleteStatus, setDeleteStatus] = useState<{ setId: string; status: TaskStatusDef; usage: number | null } | null>(null);
  const [remapTo, setRemapTo] = useState('');
  const [remapping, setRemapping] = useState(false);

  async function addSet() {
    const name = newSetName.trim();
    if (!name || !db) return;
    setSavingSet(true);
    try {
      const ref = await addDoc(collection(db, STATUS_SETS_COLLECTION), { name, statuses: [] });
      setStatusSets((prev) => [...prev, { id: ref.id, name, statuses: [] }]);
      setShowAddSet(false);
      setNewSetName('');
    } catch (err) {
      console.error('Failed to add status set:', err);
      setActionError('Could not add the status set. Please try again.');
    } finally {
      setSavingSet(false);
    }
  }

  function requestDeleteSet(set: TaskStatusSet) {
    setActionError('');
    setDeleteSetTarget(set);
  }

  async function confirmDeleteSet() {
    const target = deleteSetTarget;
    setDeleteSetTarget(null);
    if (!target || !db) return;
    const blockedBy = lists.filter((l) => l.defaultStatusSetId === target.id);
    if (blockedBy.length > 0) {
      setActionError(`"${target.name}" is still used by ${blockedBy.length} list(s) (${blockedBy.map((l) => l.name).join(', ')}). Point them at another status set first.`);
      return;
    }
    setStatusSets((prev) => prev.filter((s) => s.id !== target.id));
    try {
      await deleteDoc(doc(db, STATUS_SETS_COLLECTION, target.id));
    } catch (err) {
      console.error('Failed to delete status set:', err);
      setStatusSets((prev) => [...prev, target]);
      setActionError('Could not delete the status set. Please try again.');
    }
  }

  async function writeStatuses(setId: string, statuses: TaskStatusDef[]) {
    if (!db) return;
    const prevSet = statusSets.find((s) => s.id === setId);
    setActionError('');
    setStatusSets((prev) => prev.map((s) => s.id === setId ? { ...s, statuses } : s));
    try {
      await updateDoc(doc(db, STATUS_SETS_COLLECTION, setId), { statuses });
    } catch (err) {
      console.error('Failed to update statuses:', err);
      if (prevSet) setStatusSets((prev) => prev.map((s) => s.id === setId ? prevSet : s));
      setActionError('Could not save the status change. Please try again.');
    }
  }

  function saveStatus(setId: string, name: string, color: string, type: TaskStatusType, editing: TaskStatusDef | null) {
    const set = statusSets.find((s) => s.id === setId);
    if (!set) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if (editing) {
      const next = set.statuses.map((s) => s.id === editing.id ? { ...s, name: trimmed, color, type } : s);
      writeStatuses(setId, next);
    } else {
      const id = uniqueStatusId(setId, trimmed, set.statuses);
      const order = set.statuses.length ? Math.max(...set.statuses.map((s) => s.order)) + 1 : 0;
      writeStatuses(setId, [...set.statuses, { id, name: trimmed, color, order, type }]);
    }
    setStatusEditor(null);
  }

  function moveStatus(setId: string, status: TaskStatusDef, direction: -1 | 1) {
    const set = statusSets.find((s) => s.id === setId);
    if (!set) return;
    const sorted = [...set.statuses].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((s) => s.id === status.id);
    const swapWith = sorted[idx + direction];
    if (!swapWith) return;
    const next = set.statuses.map((s) => {
      if (s.id === status.id) return { ...s, order: swapWith.order };
      if (s.id === swapWith.id) return { ...s, order: status.order };
      return s;
    });
    writeStatuses(setId, next);
  }

  async function requestDeleteStatus(setId: string, status: TaskStatusDef) {
    setActionError('');
    setRemapTo('');
    if (!db) { setDeleteStatus({ setId, status, usage: null }); return; }
    try {
      // statusId is globally unique (prefixed with its set's id — see
      // uniqueStatusId), so a plain equality count is unambiguous on its own:
      // no other set's status can share this id, and no composite index is
      // needed for a single-field query.
      const snap = await getCountFromServer(query(collection(db, TASKS), where('statusId', '==', status.id)));
      setDeleteStatus({ setId, status, usage: snap.data().count });
    } catch (err) {
      console.error('Failed to check status usage:', err);
      // Shouldn't block the flow — fall back to "unknown usage" and let the
      // remap-or-confirm UI ask instead of guessing.
      setDeleteStatus({ setId, status, usage: null });
    }
  }

  async function confirmDeleteStatus() {
    if (!deleteStatus || !db) return;
    const { setId, status, usage } = deleteStatus;
    const set = statusSets.find((s) => s.id === setId);
    if (!set) { setDeleteStatus(null); return; }

    if (usage && usage > 0) {
      if (!remapTo) return; // guarded in the UI too — remap target is required when usage > 0
      setRemapping(true);
      try {
        const target = set.statuses.find((s) => s.id === remapTo);
        if (!target) throw new Error('Remap target not found.');
        const affected = await getDocs(query(collection(db, TASKS), where('statusId', '==', status.id)));
        const BATCH_LIMIT = 400; // mirrors src/lib/onboarding.ts
        let batch = writeBatch(db);
        let pending = 0;
        for (const taskDoc of affected.docs) {
          batch.update(taskDoc.ref, { statusId: target.id, statusName: target.name, statusType: target.type });
          pending++;
          if (pending >= BATCH_LIMIT) { await batch.commit(); batch = writeBatch(db); pending = 0; }
        }
        if (pending > 0) await batch.commit();
        await writeStatuses(setId, set.statuses.filter((s) => s.id !== status.id));
      } catch (err) {
        console.error('Failed to remap tasks off status:', err);
        setActionError('Could not remap those tasks. Please try again.');
      } finally {
        setRemapping(false);
        setDeleteStatus(null);
      }
      return;
    }

    await writeStatuses(setId, set.statuses.filter((s) => s.id !== status.id));
    setDeleteStatus(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button onClick={() => { setNewSetName(''); setShowAddSet(true); }} className="inline-flex items-center justify-center px-3 py-2 min-h-[44px] border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 shadow-sm">
          <Plus className="h-4 w-4 mr-1.5" />Add Status Set
        </button>
      </div>

      {statusSets.length === 0 && (
        <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-12 text-center text-sm text-gray-500">No status sets yet.</div>
      )}

      {statusSets.map((set) => (
        <div key={set.id} className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50 flex justify-between items-center gap-3">
            <h2 className="text-base font-serif font-semibold text-gray-900">{set.name}</h2>
            <div className="flex items-center gap-2">
              <button onClick={() => setStatusEditor({ setId: set.id, status: null })} className="inline-flex items-center justify-center px-3 py-2 min-h-[44px] border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50">
                <Plus className="h-4 w-4 mr-1.5" />Add Status
              </button>
              <button onClick={() => requestDeleteSet(set)} aria-label={`Delete ${set.name}`} className="p-2 text-red-400 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
            </div>
          </div>
          <ul className="divide-y divide-gray-200">
            {set.statuses.length === 0 && <li className="px-6 py-6 text-center text-sm text-gray-500">No statuses yet. Add one above.</li>}
            {[...set.statuses].sort((a, b) => a.order - b.order).map((status, idx, arr) => (
              <li key={status.id} className="px-6 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <TaskStatusPill name={status.name} type={status.type} color={status.color} />
                  <span className="text-xs text-gray-400">{STATUS_TYPE_INFO.find((t) => t.value === status.type)?.label ?? status.type}</span>
                </div>
                <div className="flex items-center gap-1 text-gray-400">
                  <button onClick={() => moveStatus(set.id, status, -1)} disabled={idx === 0} aria-label="Move up" className="p-2 hover:text-brand-dark disabled:opacity-30 disabled:hover:text-gray-400"><ArrowUp className="h-4 w-4" /></button>
                  <button onClick={() => moveStatus(set.id, status, 1)} disabled={idx === arr.length - 1} aria-label="Move down" className="p-2 hover:text-brand-dark disabled:opacity-30 disabled:hover:text-gray-400"><ArrowDown className="h-4 w-4" /></button>
                  <button onClick={() => setStatusEditor({ setId: set.id, status })} aria-label={`Edit ${status.name}`} className="p-2 hover:text-brand-dark"><Edit2 className="h-4 w-4" /></button>
                  <button onClick={() => requestDeleteStatus(set.id, status)} aria-label={`Delete ${status.name}`} className="p-2 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <Modal open={showAddSet} onClose={() => setShowAddSet(false)} labelledBy="add-set-title" widthClass="max-w-sm">
        <div className="px-6 py-5 border-b border-gray-200"><h3 id="add-set-title" className="text-lg font-serif font-semibold text-gray-900">Add Status Set</h3></div>
        <div className="p-6 space-y-2">
          <label htmlFor="new-set-name" className="block text-sm font-medium text-gray-700">Set name</label>
          <input id="new-set-name" value={newSetName} onChange={(e) => setNewSetName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addSet(); }} autoFocus placeholder="e.g. Marketing statuses" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark" />
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 bg-gray-50/50">
          <button onClick={() => setShowAddSet(false)} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">Cancel</button>
          <button onClick={addSet} disabled={savingSet || !newSetName.trim()} className="px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#05391B] disabled:opacity-50">{savingSet ? 'Adding…' : 'Add Set'}</button>
        </div>
      </Modal>

      {statusEditor && (
        <StatusEditorModal
          key={statusEditor.status?.id ?? 'new'}
          editing={statusEditor.status}
          onCancel={() => setStatusEditor(null)}
          onSave={(name, color, type) => saveStatus(statusEditor.setId, name, color, type, statusEditor.status)}
        />
      )}

      <ConfirmModal
        open={!!deleteSetTarget}
        title="Delete Status Set"
        message={deleteSetTarget ? `Delete "${deleteSetTarget.name}" and all ${deleteSetTarget.statuses.length} of its statuses? Any list still using it must be pointed elsewhere first. This can't be undone.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDeleteSet}
        onCancel={() => setDeleteSetTarget(null)}
      />

      <Modal open={!!deleteStatus} onClose={() => setDeleteStatus(null)} labelledBy="delete-status-title" widthClass="max-w-sm">
        {deleteStatus && (() => {
          const set = statusSets.find((s) => s.id === deleteStatus.setId);
          const otherStatuses = set?.statuses.filter((s) => s.id !== deleteStatus.status.id) ?? [];
          const hasUsage = deleteStatus.usage !== null && deleteStatus.usage > 0;
          return (
            <>
              <div className="px-6 py-5 border-b border-gray-200">
                <h3 id="delete-status-title" className="text-lg font-serif font-semibold text-gray-900">Delete Status</h3>
              </div>
              <div className="p-6 space-y-4">
                {deleteStatus.usage === null ? (
                  <p className="text-sm text-gray-600">Delete <strong>{deleteStatus.status.name}</strong>? (Couldn't confirm whether tasks still use it — proceed carefully.)</p>
                ) : hasUsage ? (
                  <>
                    <p className="text-sm text-gray-600">
                      <strong>{deleteStatus.usage}</strong> task{deleteStatus.usage === 1 ? '' : 's'} still {deleteStatus.usage === 1 ? 'has' : 'have'} the status <strong>{deleteStatus.status.name}</strong>.
                      Deleting a status those tasks reference would leave them pointing at nothing — pick a status to move them to instead:
                    </p>
                    {otherStatuses.length === 0 ? (
                      <p className="text-sm text-red-600">There's no other status in this set to remap to. Add one first.</p>
                    ) : (
                      <select value={remapTo} onChange={(e) => setRemapTo(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm min-h-[44px]">
                        <option value="">— choose a status —</option>
                        {otherStatuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-gray-600">Delete <strong>{deleteStatus.status.name}</strong>? No tasks currently use it. This can't be undone.</p>
                )}
              </div>
              <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 bg-gray-50/50">
                <button onClick={() => setDeleteStatus(null)} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">Cancel</button>
                <button
                  onClick={confirmDeleteStatus}
                  disabled={remapping || (hasUsage && (!remapTo || otherStatuses.length === 0))}
                  className="px-5 py-2 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {remapping ? 'Remapping…' : hasUsage ? 'Remap & Delete' : 'Delete'}
                </button>
              </div>
            </>
          );
        })()}
      </Modal>
    </div>
  );
}

/**
 * Add/edit a single status. TYPE is deliberately the most prominent field —
 * a labeled radio group with an inline explanation under it, not a plain
 * select buried under the name — because a mistyped type corrupts reporting
 * silently, while a mistyped name is merely wrong-looking.
 */
function StatusEditorModal({
  editing, onSave, onCancel,
}: {
  editing: TaskStatusDef | null;
  onSave: (name: string, color: string, type: TaskStatusType) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [color, setColor] = useState(editing?.color ?? COLOR_PRESETS[0]);
  const [type, setType] = useState<TaskStatusType>(editing?.type ?? 'todo');

  return (
    <Modal open onClose={onCancel} labelledBy="status-editor-title" widthClass="max-w-md">
      <div className="px-6 py-5 border-b border-gray-200">
        <h3 id="status-editor-title" className="text-lg font-serif font-semibold text-gray-900">{editing ? 'Edit Status' : 'Add Status'}</h3>
      </div>
      <div className="p-6 space-y-5">
        <div className="space-y-2 bg-brand-cream/40 border border-brand-gold/30 rounded-lg p-4">
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 text-brand-dark flex-shrink-0" aria-hidden="true" />
            <span className="text-sm font-semibold text-gray-900">Type — pick this carefully</span>
          </div>
          <p className="text-xs text-gray-600">
            Every metric, digest, and carryover rule keys off the TYPE below, never the name.
            Renaming a status later is always safe; picking the wrong type here silently
            mis-files it everywhere it's counted.
          </p>
          <div className="space-y-1 pt-1">
            {STATUS_TYPE_INFO.map((t) => (
              <label key={t.value} className="flex items-start gap-2 p-2 rounded-md hover:bg-white cursor-pointer">
                <input type="radio" name="status-type" value={t.value} checked={type === t.value} onChange={() => setType(t.value)} className="mt-1" />
                <span>
                  <span className="block text-sm font-medium text-gray-900">{t.label}</span>
                  <span className="block text-xs text-gray-500">{t.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <label htmlFor="status-name" className="block text-sm font-medium text-gray-700">Name</label>
          <input id="status-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. In Progress" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark" />
        </div>

        <div className="space-y-1">
          <span className="block text-sm font-medium text-gray-700">Color</span>
          <div className="flex flex-wrap gap-2">
            {COLOR_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={`Use color ${c}`}
                className={`w-8 h-8 rounded-full border-2 ${color === c ? 'border-brand-dark' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
              />
            ))}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Custom color" className="w-8 h-8 rounded-full border border-gray-300 p-0 overflow-hidden" />
          </div>
        </div>

        <div className="pt-1">
          <span className="block text-xs text-gray-500 mb-1">Preview</span>
          <TaskStatusPill name={name.trim() || 'Status name'} type={type} color={color} />
        </div>
      </div>
      <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 bg-gray-50/50">
        <button onClick={onCancel} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">Cancel</button>
        <button onClick={() => onSave(name, color, type)} disabled={!name.trim()} className="px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#05391B] disabled:opacity-50">{editing ? 'Save' : 'Add Status'}</button>
      </div>
    </Modal>
  );
}

// ─── Tags ──────────────────────────────────────────────────────────────────

function Tags({ tags, setTags, setActionError }: {
  tags: TaskTag[];
  setTags: React.Dispatch<React.SetStateAction<TaskTag[]>>;
  setActionError: (msg: string) => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(COLOR_PRESETS[0]);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<TaskTag | null>(null);

  async function addTag() {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    try {
      const tag = await createTaskTag(name, newColor);
      setTags((prev) => [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)));
      setShowAdd(false);
      setNewName('');
    } catch (err) {
      console.error('Failed to add tag:', err);
      setActionError('Could not add the tag. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function renameTag(tag: TaskTag) {
    const name = editingName.trim();
    setEditingId(null);
    if (!name || name === tag.name) return;
    setActionError('');
    setTags((prev) => prev.map((t) => t.id === tag.id ? { ...t, name } : t));
    try {
      await updateTaskTag(tag.id, { name });
    } catch (err) {
      console.error('Failed to rename tag:', err);
      setTags((prev) => prev.map((t) => t.id === tag.id ? { ...t, name: tag.name } : t));
      setActionError('Could not rename the tag. Please try again.');
    }
  }

  async function recolorTag(tag: TaskTag, color: string) {
    setActionError('');
    setTags((prev) => prev.map((t) => t.id === tag.id ? { ...t, color } : t));
    try {
      await updateTaskTag(tag.id, { color });
    } catch (err) {
      console.error('Failed to recolor tag:', err);
      setTags((prev) => prev.map((t) => t.id === tag.id ? { ...t, color: tag.color } : t));
      setActionError('Could not update the tag color. Please try again.');
    }
  }

  async function confirmDelete() {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    setActionError('');
    setTags((prev) => prev.filter((t) => t.id !== target.id));
    try {
      await deleteTaskTag(target.id);
    } catch (err) {
      console.error('Failed to delete tag:', err);
      setTags((prev) => [...prev, target].sort((a, b) => a.name.localeCompare(b.name)));
      setActionError('Could not delete the tag. Please try again.');
    }
  }

  return (
    <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 bg-gray-50/50 flex justify-between items-center gap-3">
        <div className="flex items-center gap-2">
          <TagIcon className="h-4 w-4 text-gray-400" aria-hidden="true" />
          <h2 className="text-base font-serif font-semibold text-gray-900">Tags</h2>
        </div>
        <button onClick={() => { setNewName(''); setNewColor(COLOR_PRESETS[0]); setShowAdd(true); }} className="inline-flex items-center justify-center px-3 py-2 min-h-[44px] border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 shadow-sm">
          <Plus className="h-4 w-4 mr-1.5" />Add Tag
        </button>
      </div>
      <ul className="divide-y divide-gray-200">
        {tags.length === 0 && <li className="px-6 py-12 text-center text-sm text-gray-500">No tags yet.</li>}
        {tags.map((tag) => (
          <li key={tag.id} className="px-6 py-3 flex items-center justify-between gap-3">
            {editingId === tag.id ? (
              <div className="flex items-center gap-2 flex-1">
                <input value={editingName} onChange={(e) => setEditingName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') renameTag(tag); }} autoFocus className="border border-gray-300 rounded px-2 py-1.5 text-sm flex-1 max-w-xs" />
                <button onClick={() => renameTag(tag)} className="text-emerald-600 hover:text-emerald-800 p-1"><Check className="h-4 w-4" /></button>
                <button onClick={() => setEditingId(null)} className="text-gray-400 hover:text-gray-600 p-1"><X className="h-4 w-4" /></button>
              </div>
            ) : (
              <TaskTagPill tag={tag} />
            )}
            <div className="flex items-center gap-2 text-gray-400">
              <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(tag.color) ? tag.color : '#6B7280'} onChange={(e) => recolorTag(tag, e.target.value)} aria-label={`Color for ${tag.name}`} className="w-7 h-7 rounded-full border border-gray-300 p-0 overflow-hidden" />
              <button onClick={() => { setEditingId(tag.id); setEditingName(tag.name); }} aria-label={`Rename ${tag.name}`} className="p-2 hover:text-brand-dark"><Edit2 className="h-4 w-4" /></button>
              <button onClick={() => setDeleteTarget(tag)} aria-label={`Delete ${tag.name}`} className="p-2 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
            </div>
          </li>
        ))}
      </ul>

      <Modal open={showAdd} onClose={() => setShowAdd(false)} labelledBy="add-tag-title" widthClass="max-w-sm">
        <div className="px-6 py-5 border-b border-gray-200"><h3 id="add-tag-title" className="text-lg font-serif font-semibold text-gray-900">Add Tag</h3></div>
        <div className="p-6 space-y-4">
          <div className="space-y-1">
            <label htmlFor="new-tag-name" className="block text-sm font-medium text-gray-700">Tag name</label>
            <input id="new-tag-name" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addTag(); }} autoFocus placeholder="e.g. Urgent" className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark" />
          </div>
          <div className="space-y-1">
            <span className="block text-sm font-medium text-gray-700">Color</span>
            <div className="flex flex-wrap gap-2">
              {COLOR_PRESETS.map((c) => (
                <button key={c} type="button" onClick={() => setNewColor(c)} aria-label={`Use color ${c}`} className={`w-8 h-8 rounded-full border-2 ${newColor === c ? 'border-brand-dark' : 'border-transparent'}`} style={{ backgroundColor: c }} />
              ))}
            </div>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 bg-gray-50/50">
          <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">Cancel</button>
          <button onClick={addTag} disabled={saving || !newName.trim()} className="px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#05391B] disabled:opacity-50">{saving ? 'Adding…' : 'Add Tag'}</button>
        </div>
      </Modal>

      <ConfirmModal
        open={!!deleteTarget}
        title="Delete Tag"
        message={deleteTarget ? `Delete "${deleteTarget.name}"? It will be removed from every task that has it. This can't be undone.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
