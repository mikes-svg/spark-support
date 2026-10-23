import { useEffect, useState } from 'react';
import { doc, setDoc, updateDoc, serverTimestamp, collection } from 'firebase/firestore';
import { Plus, Trash2, ChevronUp, ChevronDown } from 'lucide-react';
import { db } from '../../lib/firebase';
import { DD_ITEMS, fetchDdItems, seedDdItems, deleteRows, orderBetween, isTaskDone } from '../../lib/onboarding';
import { DD_STATUSES } from '../../types';
import type { DdStatus, OnboardingDdItem } from '../../types';
import { PageSpinner } from '../PageSpinner';
import { ConfirmModal } from '../ConfirmModal';
import { EditableText } from './ChecklistTable';

const STATUS_STYLES: Record<DdStatus, string> = {
  Outstanding: 'bg-gray-100 text-gray-700 border-gray-200',
  'To Review': 'bg-amber-100 text-amber-800 border-amber-200',
  Complete: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  'N/A': 'bg-slate-100 text-slate-500 border-slate-200',
};

/**
 * The seller's due-diligence request list for one property: each document
 * asked for, whether it has come in, and notes on it. A property with no list
 * yet gets the standard one the first time an editor opens the tab.
 */
export function DdMaterialsPanel({ propertyId, propertyName, canEdit }: {
  propertyId: string;
  propertyName: string;
  canEdit: boolean;
}) {
  const [items, setItems] = useState<OnboardingDdItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<OnboardingDdItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        let rows = await fetchDdItems(propertyId);
        if (rows.length === 0 && canEdit) rows = await seedDdItems(propertyId);
        if (!cancelled) setItems(rows);
      } catch (err) {
        console.error('Failed to load DD materials:', err);
        if (!cancelled) setError('Could not load the DD materials list. Please refresh.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [propertyId, canEdit]);

  /** Optimistically apply a patch, rolling back if the write fails. */
  const patchItem = async (item: OnboardingDdItem, patch: Partial<OnboardingDdItem>) => {
    if (!db) return;
    setError('');
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...patch } : i)));
    try {
      await updateDoc(doc(db, DD_ITEMS, item.id), { ...patch, updatedAt: serverTimestamp() });
    } catch (err) {
      console.error('Failed to update DD item:', err);
      setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)));
      setError('Could not save that change. Please try again.');
    }
  };

  const addItem = async () => {
    if (!db) return;
    setError('');
    const last = items[items.length - 1];
    const ref = doc(collection(db, DD_ITEMS));
    const item: OnboardingDdItem = {
      id: ref.id,
      propertyId,
      order: orderBetween(last?.order ?? null, null),
      item: '',
      status: 'Outstanding',
      notes: '',
    };
    setItems((prev) => [...prev, item]);
    try {
      const { id: _id, ...data } = item;
      await setDoc(ref, { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    } catch (err) {
      console.error('Failed to add DD item:', err);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setError('Could not add that item. Please try again.');
    }
  };

  const moveItem = async (index: number, direction: -1 | 1) => {
    const a = items[index];
    const b = items[index + direction];
    if (!a || !b) return;
    // Swap the two sort keys; both writes go through patchItem's rollback.
    setItems((prev) => {
      const next = [...prev];
      next[index] = { ...b, order: a.order };
      next[index + direction] = { ...a, order: b.order };
      return next;
    });
    await Promise.all([patchItem(a, { order: b.order }), patchItem(b, { order: a.order })]);
    setItems((prev) => [...prev].sort((x, y) => x.order - y.order));
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    const before = items;
    setItems((prev) => prev.filter((i) => i.id !== target.id));
    try {
      await deleteRows(DD_ITEMS, [target]);
    } catch (err) {
      console.error('Failed to delete DD item:', err);
      setItems(before);
      setError('Could not delete that item. Please try again.');
    }
  };

  if (loading) return <PageSpinner />;

  const doneCount = items.filter(isTaskDone).length;
  const counts = DD_STATUSES.map((s) => ({ status: s, count: items.filter((i) => i.status === s).length }));

  return (
    <div className="space-y-6">
      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-md" role="alert">{error}</p>
      )}

      <div className="bg-white shadow-sm rounded-xl border border-gray-200 p-6 space-y-4">
        <div>
          <h1 className="text-2xl font-serif font-semibold text-gray-900">{propertyName}</h1>
          <p className="mt-1 text-sm text-gray-500">
            DD request list · {doneCount} of {items.length} items complete or N/A
          </p>
        </div>
        <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
          <div
            className="bg-brand-dark h-2 rounded-full transition-all"
            style={{ width: items.length ? `${Math.round((doneCount / items.length) * 100)}%` : '0%' }}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {counts.map(({ status, count }) => (
            <span key={status} className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[status]}`}>
              {status}<span className="tabular-nums">{count}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-white">
              <tr>
                {['#', 'Item', 'Status', 'Notes'].map((h) => (
                  <th key={h} scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
                {canEdit && <th scope="col" className="px-4 py-3 w-px"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.length === 0 && (
                <tr>
                  <td colSpan={canEdit ? 5 : 4} className="px-6 py-12 text-center text-sm text-gray-500">
                    No DD materials list has been set up for this property yet.
                  </td>
                </tr>
              )}
              {items.map((item, index) => {
                // Numbers come from position, like the onboarding checklist, so
                // they stay sequential through adds, deletes and moves.
                const number = index + 1;
                return (
                  <tr key={item.id} className="group hover:bg-gray-50/60">
                    <td className="px-3 py-1.5 align-top">
                      <span className="inline-block px-2 py-1 text-xs tabular-nums text-gray-500">{number}</span>
                    </td>
                    <td className="px-4 py-1.5 align-top min-w-[24rem] w-1/2">
                      <EditableText
                        value={item.item}
                        disabled={!canEdit}
                        textarea
                        placeholder="Document requested"
                        ariaLabel={`DD item ${number}`}
                        onCommit={(next) => patchItem(item, { item: next })}
                        className="text-gray-900"
                      />
                    </td>
                    <td className="px-4 py-1.5 align-top">
                      <select
                        value={item.status}
                        disabled={!canEdit}
                        aria-label={`Status for DD item ${number}`}
                        onChange={(e) => patchItem(item, { status: e.target.value as DdStatus })}
                        className={`rounded-full border px-2.5 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-brand-dark ${STATUS_STYLES[item.status]}`}
                      >
                        {DD_STATUSES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-1.5 align-top min-w-[14rem]">
                      <EditableText
                        value={item.notes}
                        disabled={!canEdit}
                        textarea
                        placeholder="—"
                        ariaLabel={`Notes for DD item ${number}`}
                        onCommit={(notes) => patchItem(item, { notes })}
                        className="text-gray-600"
                      />
                    </td>
                    {canEdit && (
                      <td className="px-2 py-1.5 align-top whitespace-nowrap">
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                          <button
                            onClick={() => moveItem(index, -1)}
                            disabled={index === 0}
                            title="Move up"
                            aria-label={`Move DD item ${number} up`}
                            className="p-1 text-gray-400 hover:text-brand-dark disabled:opacity-30 disabled:hover:text-gray-400"
                          >
                            <ChevronUp className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => moveItem(index, 1)}
                            disabled={index === items.length - 1}
                            title="Move down"
                            aria-label={`Move DD item ${number} down`}
                            className="p-1 text-gray-400 hover:text-brand-dark disabled:opacity-30 disabled:hover:text-gray-400"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => setDeleteTarget(item)}
                            title="Delete item"
                            aria-label={`Delete DD item ${number}`}
                            className="p-1 text-red-400 hover:text-red-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {canEdit && (
          <div className="border-t border-gray-100 px-4 py-2">
            <button
              onClick={addItem}
              className="inline-flex items-center px-2 py-1 text-sm font-medium text-gray-600 hover:text-brand-dark"
            >
              <Plus className="h-4 w-4 mr-1" />Add item
            </button>
          </div>
        )}
      </div>

      <ConfirmModal
        open={deleteTarget !== null}
        title="Delete DD item"
        message={`Delete “${deleteTarget?.item.slice(0, 80) || 'this item'}${(deleteTarget?.item.length ?? 0) > 80 ? '…' : ''}”?`}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
