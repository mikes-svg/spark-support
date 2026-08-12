import { useState, useEffect } from 'react';
import { doc, updateDoc, setDoc, serverTimestamp, collection } from 'firebase/firestore';
import { ClipboardList } from 'lucide-react';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { isSuperadminRole } from '../types';
import type { OnboardingTemplateItem, Profile } from '../types';
import { PageSpinner } from '../components/PageSpinner';
import { ConfirmModal } from '../components/ConfirmModal';
import { ChecklistTable, type ChecklistRow } from '../components/onboarding/ChecklistTable';
import { getOrSeedOnboardingTemplate } from '../lib/seedOnboardingTemplate';
import { TEMPLATE, fetchOnboardingPeople, orderBetween, renameSection, deleteRows } from '../lib/onboarding';

export function OnboardingTemplatePage() {
  const { user } = useAuth();
  const canEdit = isSuperadminRole(user?.role);

  const [people, setPeople] = useState<Profile[]>([]);
  const [items, setItems] = useState<OnboardingTemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState('');

  const [deleteRowTarget, setDeleteRowTarget] = useState<OnboardingTemplateItem | null>(null);
  const [deleteSectionTarget, setDeleteSectionTarget] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const peeps = await fetchOnboardingPeople();
        const template = await getOrSeedOnboardingTemplate(peeps);
        setPeople(peeps);
        setItems(template);
      } catch (err) {
        console.error('Failed to load the template:', err);
        setActionError('Could not load the template. Please refresh.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const sectionCount = new Set(items.map((i) => i.section)).size;

  const patchItem = async (item: OnboardingTemplateItem, patch: Partial<OnboardingTemplateItem>) => {
    if (!db) return;
    setActionError('');
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...patch } : i)));
    try {
      await updateDoc(doc(db, TEMPLATE, item.id), { ...patch, updatedAt: serverTimestamp() });
    } catch (err) {
      console.error('Failed to update row:', err);
      setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)));
      setActionError('Could not save that change. Please try again.');
    }
  };

  const handlePatchRow = (row: ChecklistRow, patch: Partial<ChecklistRow>) => {
    const item = items.find((i) => i.id === row.id);
    if (!item) return;
    patchItem(item, patch as Partial<OnboardingTemplateItem>);
  };

  /** Create a blank row in `section`, ordered just after `afterRow` (or last). */
  const addRow = async (section: string, afterRow: ChecklistRow | null) => {
    if (!db) return;
    const sorted = [...items].sort((a, b) => a.order - b.order);
    const index = afterRow ? sorted.findIndex((i) => i.id === afterRow.id) : sorted.length - 1;
    const before = sorted[index] ?? null;
    const after = sorted[index + 1] ?? null;
    const newItem: OnboardingTemplateItem = {
      id: doc(collection(db, TEMPLATE)).id,
      section,
      order: orderBetween(before?.order ?? null, after?.order ?? null),
      code: '',
      indent: 0,
      title: '',
      responsibleIds: [],
      daysFromClosing: null,
    };
    setActionError('');
    setItems((prev) => [...prev, newItem]);
    try {
      const { id, ...data } = newItem;
      await setDoc(doc(db, TEMPLATE, id), { ...data, createdAt: serverTimestamp() });
    } catch (err) {
      console.error('Failed to add row:', err);
      setItems((prev) => prev.filter((i) => i.id !== newItem.id));
      setActionError('Could not add the row. Please try again.');
    }
  };

  const handleMoveRow = async (row: ChecklistRow, direction: -1 | 1) => {
    const sorted = [...items].sort((a, b) => a.order - b.order);
    const index = sorted.findIndex((i) => i.id === row.id);
    const neighbour = sorted[index + direction];
    const item = sorted[index];
    if (!item || !neighbour) return;
    // At a section boundary the row steps into the neighbouring section rather
    // than jumping over its header; inside a section the two rows swap places.
    if (neighbour.section !== item.section) {
      patchItem(item, { section: neighbour.section });
      return;
    }
    if (!db) return;
    setActionError('');
    setItems((prev) =>
      prev.map((i) => {
        if (i.id === item.id) return { ...i, order: neighbour.order };
        if (i.id === neighbour.id) return { ...i, order: item.order };
        return i;
      })
    );
    try {
      await Promise.all([
        updateDoc(doc(db, TEMPLATE, item.id), { order: neighbour.order, updatedAt: serverTimestamp() }),
        updateDoc(doc(db, TEMPLATE, neighbour.id), { order: item.order, updatedAt: serverTimestamp() }),
      ]);
    } catch (err) {
      console.error('Failed to reorder rows:', err);
      setItems((prev) =>
        prev.map((i) => {
          if (i.id === item.id) return { ...i, order: item.order };
          if (i.id === neighbour.id) return { ...i, order: neighbour.order };
          return i;
        })
      );
      setActionError('Could not reorder the rows. Please try again.');
    }
  };

  const handleRenameSection = async (from: string, to: string) => {
    const previous = items;
    setActionError('');
    setItems((prev) => prev.map((i) => (i.section === from ? { ...i, section: to } : i)));
    try {
      await renameSection(TEMPLATE, items, from, to);
    } catch (err) {
      console.error('Failed to rename section:', err);
      setItems(previous);
      setActionError('Could not rename the section. Please try again.');
    }
  };

  const confirmDeleteSection = async () => {
    const section = deleteSectionTarget;
    setDeleteSectionTarget(null);
    if (!section) return;
    const doomed = items.filter((i) => i.section === section);
    const previous = items;
    setActionError('');
    setItems((prev) => prev.filter((i) => i.section !== section));
    try {
      await deleteRows(TEMPLATE, doomed);
    } catch (err) {
      console.error('Failed to delete section:', err);
      setItems(previous);
      setActionError('Could not delete the section. Please try again.');
    }
  };

  const confirmDeleteRow = async () => {
    const target = deleteRowTarget;
    setDeleteRowTarget(null);
    if (!target) return;
    const previous = items;
    setActionError('');
    setItems((prev) => prev.filter((i) => i.id !== target.id));
    try {
      await deleteRows(TEMPLATE, [target]);
    } catch (err) {
      console.error('Failed to delete row:', err);
      setItems(previous);
      setActionError('Could not delete the row. Please try again.');
    }
  };

  /** A new section is just a blank row at the end carrying a new section name. */
  const handleAddSection = () => {
    const sorted = [...items].sort((a, b) => a.order - b.order);
    const existing = new Set(items.map((i) => i.section));
    let name = 'New Section';
    for (let i = 2; existing.has(name); i++) name = `New Section ${i}`;
    addRow(name, sorted[sorted.length - 1] ?? null);
  };

  if (loading) return <PageSpinner />;

  return (
    <div className="space-y-6">
      {actionError && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-md" role="alert">{actionError}</p>
      )}

      <div className="bg-white shadow-sm rounded-xl border border-gray-200 p-6 space-y-2">
        <h1 className="text-2xl font-serif font-semibold text-gray-900">Checklist Template</h1>
        <p className="text-sm text-gray-500">
          This is the master checklist copied into every new property when it's created.
        </p>
        <p className="text-sm text-brand-dark font-medium">
          Edits here only apply to properties created after the change — existing properties keep
          the checklist they were created with.
        </p>
        <p className="text-xs text-gray-400 pt-1">
          {items.length} {items.length === 1 ? 'row' : 'rows'} across {sectionCount} {sectionCount === 1 ? 'section' : 'sections'}
        </p>
      </div>

      {items.length === 0 ? (
        <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center">
          <ClipboardList className="h-10 w-10 mx-auto text-gray-300" />
          <h2 className="mt-4 text-lg font-serif font-semibold text-gray-900">No template rows yet</h2>
          <p className="mt-1 text-sm text-gray-500">
            {canEdit
              ? 'Add a section to start building the template checklist.'
              : "The template hasn't been set up yet."}
          </p>
          {canEdit && (
            <button
              onClick={handleAddSection}
              className="mt-5 inline-flex items-center px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#05391B] transition-colors"
            >
              Add Section
            </button>
          )}
        </div>
      ) : (
        <ChecklistTable
          rows={items}
          people={people}
          mode="template"
          canEdit={canEdit}
          onPatchRow={handlePatchRow}
          onAddRow={addRow}
          onDeleteRow={(row) => setDeleteRowTarget(items.find((i) => i.id === row.id) ?? null)}
          onMoveRow={handleMoveRow}
          onRenameSection={handleRenameSection}
          onDeleteSection={(section) => setDeleteSectionTarget(section)}
          onAddSection={handleAddSection}
        />
      )}

      <ConfirmModal
        open={!!deleteRowTarget}
        title="Delete Row"
        message={deleteRowTarget ? `Delete “${deleteRowTarget.title || 'this row'}” from the template? This can't be undone.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDeleteRow}
        onCancel={() => setDeleteRowTarget(null)}
      />
      <ConfirmModal
        open={!!deleteSectionTarget}
        title="Delete Section"
        message={
          deleteSectionTarget
            ? `Delete the “${deleteSectionTarget}” section and all ${items.filter((i) => i.section === deleteSectionTarget).length} of its rows? This can't be undone.`
            : ''
        }
        confirmLabel="Delete Section"
        danger
        onConfirm={confirmDeleteSection}
        onCancel={() => setDeleteSectionTarget(null)}
      />
    </div>
  );
}
