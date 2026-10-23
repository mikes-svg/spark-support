import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, updateDoc, setDoc, serverTimestamp, collection } from 'firebase/firestore';
import { ClipboardList, Plus, Trash2 } from 'lucide-react';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { isSuperadminRole } from '../types';
import type { OnboardingTemplateItem, Profile } from '../types';
import { PageSpinner } from '../components/PageSpinner';
import { Modal } from '../components/Modal';
import { ConfirmModal } from '../components/ConfirmModal';
import { ChecklistTable, type ChecklistRow } from '../components/onboarding/ChecklistTable';
import {
  fetchTemplates,
  fetchTemplateItems,
  createTemplate,
  renameTemplate,
  deleteTemplate,
  type ChecklistTemplate,
} from '../lib/checklistTemplates';
import {
  CHECKLISTS,
  CHECKLIST_KINDS,
  fetchOnboardingPeople,
  orderBetween,
  renameSection,
  deleteRows,
  type ChecklistKind,
} from '../lib/onboarding';

/**
 * Every checklist template in one place: pick the checklist (PM Onboarding or
 * DD Inspections), then one of its named templates. The URL carries both, so a
 * template is linkable: /onboarding/templates/:kind/:templateId.
 */
export function OnboardingTemplatePage() {
  const { user } = useAuth();
  const canEdit = isSuperadminRole(user?.role);
  const navigate = useNavigate();
  const params = useParams<{ kind?: string; templateId?: string }>();
  const kind: ChecklistKind = params.kind === 'inspections' ? 'inspections' : 'onboarding';
  const templateCollection = CHECKLISTS[kind].template;

  const [people, setPeople] = useState<Profile[]>([]);
  const [templates, setTemplates] = useState<ChecklistTemplate[]>([]);
  const [items, setItems] = useState<OnboardingTemplateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [loadError, setLoadError] = useState('');
  // Bumping this re-runs the load effect, which is what the error banner's Retry does.
  const [reloadKey, setReloadKey] = useState(0);

  const [deleteRowTarget, setDeleteRowTarget] = useState<OnboardingTemplateItem | null>(null);
  const [deleteSectionTarget, setDeleteSectionTarget] = useState<string | null>(null);
  const [deleteTemplateTarget, setDeleteTemplateTarget] = useState<ChecklistTemplate | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [copyFromId, setCopyFromId] = useState('');
  const [creating, setCreating] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const template = templates.find((t) => t.id === params.templateId) ?? null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const peeps = await fetchOnboardingPeople();
        const list = await fetchTemplates(kind, peeps);
        if (cancelled) return;
        setPeople(peeps);
        setTemplates(list);
      } catch (err) {
        console.error('Failed to load templates:', err);
        if (!cancelled) setLoadError('Could not load the templates.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey, kind]);

  // Land on a template: keep the URL as the source of truth, like property tabs.
  useEffect(() => {
    if (loading || template || templates.length === 0) return;
    navigate(`/onboarding/templates/${kind}/${templates[0].id}`, { replace: true });
  }, [loading, template, templates, kind, navigate]);

  useEffect(() => {
    if (!template) { setItems([]); return; }
    setNameDraft(template.name);
    let cancelled = false;
    setItemsLoading(true);
    (async () => {
      try {
        const rows = await fetchTemplateItems(kind, template.id);
        if (!cancelled) setItems(rows);
      } catch (err) {
        console.error('Failed to load template rows:', err);
        if (!cancelled) setLoadError('Could not load this template.');
      } finally {
        if (!cancelled) setItemsLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Only a different template reloads the rows; a rename doesn't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, template?.id]);

  const sectionCount = new Set(items.map((i) => i.section)).size;

  const patchItem = async (item: OnboardingTemplateItem, patch: Partial<OnboardingTemplateItem>) => {
    if (!db) return;
    setActionError('');
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...patch } : i)));
    try {
      await updateDoc(doc(db, templateCollection, item.id), { ...patch, updatedAt: serverTimestamp() });
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
    if (!db || !template) return;
    const sorted = [...items].sort((a, b) => a.order - b.order);
    const index = afterRow ? sorted.findIndex((i) => i.id === afterRow.id) : sorted.length - 1;
    const before = sorted[index] ?? null;
    const after = sorted[index + 1] ?? null;
    const newItem: OnboardingTemplateItem = {
      id: doc(collection(db, templateCollection)).id,
      templateId: template.id,
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
      await setDoc(doc(db, templateCollection, id), { ...data, createdAt: serverTimestamp() });
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
        updateDoc(doc(db, templateCollection, item.id), { order: neighbour.order, updatedAt: serverTimestamp() }),
        updateDoc(doc(db, templateCollection, neighbour.id), { order: item.order, updatedAt: serverTimestamp() }),
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
      await renameSection(templateCollection, items, from, to);
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
      await deleteRows(templateCollection, doomed);
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
      await deleteRows(templateCollection, [target]);
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

  const commitRename = async () => {
    if (!template) return;
    const name = nameDraft.trim();
    if (!name || name === template.name) { setNameDraft(template.name); return; }
    const previous = templates;
    setActionError('');
    setTemplates((prev) => prev.map((t) => (t.id === template.id ? { ...t, name } : t)));
    try {
      await renameTemplate(template, name);
    } catch (err) {
      console.error('Failed to rename template:', err);
      setTemplates(previous);
      setNameDraft(template.name);
      setActionError('Could not rename the template. Please try again.');
    }
  };

  const openNew = () => {
    setNewName('');
    setCopyFromId(template?.id ?? '');
    setShowNew(true);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setActionError('');
    try {
      const source = copyFromId ? await fetchTemplateItems(kind, copyFromId) : [];
      const created = await createTemplate(kind, name, source);
      setTemplates((prev) => [...prev, created]);
      setShowNew(false);
      navigate(`/onboarding/templates/${kind}/${created.id}`);
    } catch (err) {
      console.error('Failed to create template:', err);
      setActionError('Could not create the template. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  const confirmDeleteTemplate = async () => {
    const target = deleteTemplateTarget;
    setDeleteTemplateTarget(null);
    if (!target) return;
    const previous = templates;
    setActionError('');
    setTemplates((prev) => prev.filter((t) => t.id !== target.id));
    try {
      await deleteTemplate(target);
      const next = previous.find((t) => t.id !== target.id);
      navigate(next ? `/onboarding/templates/${kind}/${next.id}` : `/onboarding/templates/${kind}`, { replace: true });
    } catch (err) {
      console.error('Failed to delete template:', err);
      setTemplates(previous);
      setActionError('Could not delete the template. Please try again.');
    }
  };

  return (
    <div className="space-y-6">
      {loadError && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-md"
          role="alert"
        >
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="inline-flex items-center px-3 py-1.5 text-sm font-medium rounded-md border border-red-300 bg-white text-red-700 hover:bg-red-100 transition-colors"
          >
            Retry
          </button>
        </div>
      )}
      {actionError && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-md" role="alert">{actionError}</p>
      )}

      {/* Which checklist's templates */}
      <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
        {CHECKLIST_KINDS.map((k) => (
          <button
            key={k}
            onClick={() => navigate(`/onboarding/templates/${k}`)}
            className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
              kind === k ? 'bg-brand-dark text-white shadow-sm' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {CHECKLISTS[k].label}
          </button>
        ))}
      </div>

      {loading ? (
        <PageSpinner />
      ) : (
        <>
          {/* Template tabs */}
          <div className="flex items-end gap-2 border-b border-gray-200 overflow-x-auto pb-px">
            {templates.map((t) => {
              const active = t.id === template?.id;
              return (
                <button
                  key={t.id}
                  onClick={() => navigate(`/onboarding/templates/${kind}/${t.id}`)}
                  className={`px-4 py-2 text-sm font-medium rounded-t-lg border border-b-0 whitespace-nowrap transition-colors ${
                    active
                      ? 'bg-white border-gray-200 text-brand-dark -mb-px'
                      : 'bg-gray-50 border-transparent text-gray-500 hover:text-gray-800 hover:bg-gray-100'
                  }`}
                >
                  {t.name}
                </button>
              );
            })}
            {canEdit && (
              <button
                onClick={openNew}
                className="px-3 py-2 text-sm font-medium text-gray-600 hover:text-brand-dark whitespace-nowrap"
              >
                <Plus className="h-4 w-4 inline -mt-0.5 mr-1" />New Template
              </button>
            )}
          </div>

          {!template ? (
            <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center">
              <ClipboardList className="h-10 w-10 mx-auto text-gray-300" />
              <h2 className="mt-4 text-lg font-serif font-semibold text-gray-900">No {CHECKLISTS[kind].label} templates yet</h2>
              <p className="mt-1 text-sm text-gray-500">
                {canEdit ? 'Create one to start building this checklist.' : "These templates haven't been set up yet."}
              </p>
            </div>
          ) : (
            <>
              <div className="bg-white shadow-sm rounded-xl border border-gray-200 p-6 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <label htmlFor="template-name" className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">
                      {CHECKLISTS[kind].label} template
                    </label>
                    <input
                      id="template-name"
                      value={nameDraft}
                      disabled={!canEdit}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') setNameDraft(template.name);
                      }}
                      className="w-full max-w-md text-2xl font-serif font-semibold text-gray-900 bg-transparent border border-transparent rounded px-1 -mx-1 hover:border-gray-300 focus:border-brand-dark focus:bg-white focus:outline-none focus:ring-1 focus:ring-brand-dark disabled:hover:border-transparent"
                    />
                  </div>
                  {canEdit && (
                    <button
                      onClick={() => setDeleteTemplateTarget(template)}
                      aria-label={`Delete template ${template.name}`}
                      title="Delete template"
                      className="p-2 text-red-400 hover:text-red-600 transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <p className="text-sm text-gray-500">
                  Pick this template when creating a property, or apply it to a property whose {CHECKLISTS[kind].label} list is empty.
                  Edits only affect properties set up afterwards — existing checklists are never changed.
                </p>
                <p className="text-xs text-gray-600">
                  {items.length} {items.length === 1 ? 'row' : 'rows'} across {sectionCount} {sectionCount === 1 ? 'section' : 'sections'}
                </p>
              </div>

              {itemsLoading ? (
                <PageSpinner />
              ) : items.length === 0 ? (
                <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center">
                  <ClipboardList className="h-10 w-10 mx-auto text-gray-300" />
                  <h2 className="mt-4 text-lg font-serif font-semibold text-gray-900">No rows yet</h2>
                  <p className="mt-1 text-sm text-gray-500">
                    {canEdit ? 'Add a section to start building this template.' : 'This template is empty.'}
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
            </>
          )}
        </>
      )}

      {/* New template */}
      <Modal open={showNew} onClose={() => setShowNew(false)} labelledBy="new-template-title" widthClass="max-w-md">
        <div className="px-6 py-5 border-b border-gray-200">
          <h3 id="new-template-title" className="text-lg font-serif font-semibold text-gray-900">New {CHECKLISTS[kind].label} Template</h3>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label htmlFor="new-template-name" className="block text-sm font-medium text-gray-700 mb-1">Template name</label>
            <input
              id="new-template-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
              placeholder="e.g. Garden-style, LIHTC"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark"
            />
          </div>
          <div>
            <label htmlFor="new-template-source" className="block text-sm font-medium text-gray-700 mb-1">Start from</label>
            <select
              id="new-template-source"
              value={copyFromId}
              onChange={(e) => setCopyFromId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark"
            >
              <option value="">Blank</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>Copy of {t.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 bg-gray-50/50">
          <button onClick={() => setShowNew(false)} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">Cancel</button>
          <button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#05391B] disabled:opacity-50 transition-colors"
          >
            {creating ? 'Creating…' : 'Create Template'}
          </button>
        </div>
      </Modal>

      <ConfirmModal
        open={!!deleteTemplateTarget}
        title="Delete Template"
        message={
          deleteTemplateTarget
            ? `Delete the “${deleteTemplateTarget.name}” template and all ${items.length} of its rows? Properties already set up from it keep their checklists. This can't be undone.`
            : ''
        }
        confirmLabel="Delete Template"
        danger
        onConfirm={confirmDeleteTemplate}
        onCancel={() => setDeleteTemplateTarget(null)}
      />
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
