import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { doc, updateDoc, setDoc, serverTimestamp, collection } from 'firebase/firestore';
import { Plus, Archive, ArchiveRestore, Trash2, Building2, LayoutTemplate } from 'lucide-react';
import { db } from '../lib/firebase';
import { useAuth } from '../context/AuthContext';
import { isSuperadminRole, canEditOnboarding } from '../types';
import type { OnboardingProperty, OnboardingTask, Profile } from '../types';
import { PageSpinner } from '../components/PageSpinner';
import { Modal } from '../components/Modal';
import { ConfirmModal } from '../components/ConfirmModal';
import { ChecklistTable, type ChecklistRow } from '../components/onboarding/ChecklistTable';
import { PostponeModal } from '../components/onboarding/PostponeModal';
import { getOrSeedOnboardingTemplate } from '../lib/seedOnboardingTemplate';
import { todayStr } from '../lib/dates';
import {
  TASKS,
  PROPERTIES,
  fetchProperties,
  fetchTasksForProperty,
  fetchOnboardingPeople,
  createPropertyFromTemplate,
  applyClosingDate,
  deletePropertyWithTasks,
  savePropertyChecklistAsTemplate,
  renameSection,
  deleteRows,
  computeDueDate,
  deriveDaysFromClosing,
  orderBetween,
  isTaskDone,
  isOverdue,
} from '../lib/onboarding';

/** The editable milestone fields on a property, in display order. */
const PROPERTY_DATES: { key: keyof OnboardingProperty; label: string }[] = [
  { key: 'psaExecutionDate', label: 'PSA Execution' },
  { key: 'titleCommitmentDate', label: 'Title Commitment' },
  { key: 'titleNoticeDate', label: 'Title Notice to Seller' },
  { key: 'ddCompletionDate', label: 'Due Diligence Completion' },
];

export function OnboardingPropertiesPage() {
  const { propertyId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isSuperadmin = isSuperadminRole(user?.role);
  // Managers see the checklist read-only; superadmins and granted users can edit.
  const canEdit = canEditOnboarding(user);

  const [properties, setProperties] = useState<OnboardingProperty[]>([]);
  const [people, setPeople] = useState<Profile[]>([]);
  const [tasks, setTasks] = useState<OnboardingTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [propertiesError, setPropertiesError] = useState('');
  const [checklistError, setChecklistError] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const [showNewModal, setShowNewModal] = useState(false);
  const [newName, setNewName] = useState('');
  const [newClosingDate, setNewClosingDate] = useState('');
  const [creating, setCreating] = useState(false);

  const [deleteRowTarget, setDeleteRowTarget] = useState<OnboardingTask | null>(null);
  const [deleteSectionTarget, setDeleteSectionTarget] = useState<string | null>(null);
  const [deletePropertyTarget, setDeletePropertyTarget] = useState<OnboardingProperty | null>(null);
  const [postponeTarget, setPostponeTarget] = useState<{ task: OnboardingTask; newDate: string | null } | null>(null);
  const [saveTemplateTarget, setSaveTemplateTarget] = useState<OnboardingProperty | null>(null);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [successNotice, setSuccessNotice] = useState('');

  const visibleProperties = properties.filter((p) => showArchived || !p.archived);
  const property = properties.find((p) => p.id === propertyId) ?? null;

  useEffect(() => {
    (async () => {
      try {
        const [props, peeps] = await Promise.all([fetchProperties(), fetchOnboardingPeople()]);
        setProperties(props);
        setPeople(peeps);
      } catch (err) {
        console.error('Failed to load onboarding properties:', err);
        setPropertiesError('Could not load properties. Please refresh.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Land on a property: keep the URL as the source of truth so tabs are linkable.
  useEffect(() => {
    if (loading || propertyId) return;
    const first = properties.find((p) => !p.archived);
    if (first) navigate(`/onboarding/properties/${first.id}`, { replace: true });
  }, [loading, propertyId, properties, navigate]);

  useEffect(() => {
    setChecklistError('');
    if (!propertyId) { setTasks([]); return; }
    let cancelled = false;
    setTasksLoading(true);
    (async () => {
      try {
        const rows = await fetchTasksForProperty(propertyId);
        if (!cancelled) setTasks(rows);
      } catch (err) {
        console.error('Failed to load checklist:', err);
        if (!cancelled) setChecklistError('Could not load this checklist. Please refresh.');
      } finally {
        if (!cancelled) setTasksLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [propertyId]);

  const today = useMemo(() => todayStr(), []);
  const doneCount = tasks.filter(isTaskDone).length;
  const overdueCount = tasks.filter((t) => isOverdue(t, today)).length;

  /** Optimistically apply a task patch, rolling back if the write fails. */
  const patchTask = async (task: OnboardingTask, patch: Partial<OnboardingTask>) => {
    if (!db) return;
    setActionError('');
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, ...patch } : t)));
    try {
      await updateDoc(doc(db, TASKS, task.id), { ...patch, updatedAt: serverTimestamp() });
    } catch (err) {
      console.error('Failed to update task:', err);
      setTasks((prev) => prev.map((t) => (t.id === task.id ? task : t)));
      setActionError('Could not save that change. Please try again.');
    }
  };

  const handlePatchRow = (row: ChecklistRow, patch: Partial<ChecklistRow>) => {
    const task = tasks.find((t) => t.id === row.id);
    if (!task) return;
    const next: Partial<OnboardingTask> = { ...patch } as Partial<OnboardingTask>;
    // Days-from-Closing drives the due date: setting an offset recomputes it.
    // Clearing the offset leaves the existing date alone as a manual one.
    if (patch.daysFromClosing != null) {
      const computed = computeDueDate(property?.closingDate ?? null, patch.daysFromClosing);
      if (computed) next.dueDate = computed;
    }
    patchTask(task, next);
  };

  const handleDueDateChange = (row: ChecklistRow, dueDate: string | null) => {
    const task = tasks.find((t) => t.id === row.id);
    if (!task) return;
    // Moving an overdue task needs a reason on the record; everything else is a
    // plain edit that re-derives the offset so it keeps tracking closing.
    if (isOverdue(task, today)) {
      setPostponeTarget({ task, newDate: dueDate });
      return;
    }
    patchTask(task, {
      dueDate,
      daysFromClosing: deriveDaysFromClosing(property?.closingDate ?? null, dueDate),
    });
  };

  const confirmPostpone = async (toDate: string | null, reason: string) => {
    const target = postponeTarget;
    setPostponeTarget(null);
    if (!target || !user) return;
    const { task } = target;
    const delay = {
      at: new Date().toISOString(),
      byId: user.id,
      fromDate: task.dueDate ?? null,
      toDate,
      reason,
    };
    await patchTask(task, {
      dueDate: toDate,
      daysFromClosing: deriveDaysFromClosing(property?.closingDate ?? null, toDate),
      delays: [...(task.delays ?? []), delay],
    });
  };

  /** Create a blank row in `section`, ordered just after `afterRow` (or last). */
  const addRow = async (section: string, afterRow: ChecklistRow | null) => {
    if (!db || !propertyId) return;
    const sorted = [...tasks].sort((a, b) => a.order - b.order);
    const index = afterRow ? sorted.findIndex((t) => t.id === afterRow.id) : sorted.length - 1;
    const before = sorted[index] ?? null;
    const after = sorted[index + 1] ?? null;
    const newTask: OnboardingTask = {
      id: doc(collection(db, TASKS)).id,
      propertyId,
      section,
      order: orderBetween(before?.order ?? null, after?.order ?? null),
      code: '',
      indent: 0,
      title: '',
      responsibleIds: [],
      daysFromClosing: null,
      dueDate: null,
      status: 'Not Started',
      notes: '',
      delays: [],
    };
    setActionError('');
    setTasks((prev) => [...prev, newTask]);
    try {
      const { id, ...data } = newTask;
      await setDoc(doc(db, TASKS, id), { ...data, createdAt: serverTimestamp() });
    } catch (err) {
      console.error('Failed to add row:', err);
      setTasks((prev) => prev.filter((t) => t.id !== newTask.id));
      setActionError('Could not add the row. Please try again.');
    }
  };

  const handleMoveRow = async (row: ChecklistRow, direction: -1 | 1) => {
    const sorted = [...tasks].sort((a, b) => a.order - b.order);
    const index = sorted.findIndex((t) => t.id === row.id);
    const neighbour = sorted[index + direction];
    const task = sorted[index];
    if (!task || !neighbour) return;
    // At a section boundary the row steps into the neighbouring section rather
    // than jumping over its header; inside a section the two rows swap places.
    if (neighbour.section !== task.section) {
      patchTask(task, { section: neighbour.section });
      return;
    }
    if (!db) return;
    setActionError('');
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === task.id) return { ...t, order: neighbour.order };
        if (t.id === neighbour.id) return { ...t, order: task.order };
        return t;
      })
    );
    try {
      await Promise.all([
        updateDoc(doc(db, TASKS, task.id), { order: neighbour.order, updatedAt: serverTimestamp() }),
        updateDoc(doc(db, TASKS, neighbour.id), { order: task.order, updatedAt: serverTimestamp() }),
      ]);
    } catch (err) {
      console.error('Failed to reorder tasks:', err);
      setTasks((prev) =>
        prev.map((t) => {
          if (t.id === task.id) return { ...t, order: task.order };
          if (t.id === neighbour.id) return { ...t, order: neighbour.order };
          return t;
        })
      );
      setActionError('Could not reorder the rows. Please try again.');
    }
  };

  const handleRenameSection = async (from: string, to: string) => {
    const previous = tasks;
    setActionError('');
    setTasks((prev) => prev.map((t) => (t.section === from ? { ...t, section: to } : t)));
    try {
      await renameSection(TASKS, tasks, from, to);
    } catch (err) {
      console.error('Failed to rename section:', err);
      setTasks(previous);
      setActionError('Could not rename the section. Please try again.');
    }
  };

  const confirmDeleteSection = async () => {
    const section = deleteSectionTarget;
    setDeleteSectionTarget(null);
    if (!section) return;
    const doomed = tasks.filter((t) => t.section === section);
    const previous = tasks;
    setActionError('');
    setTasks((prev) => prev.filter((t) => t.section !== section));
    try {
      await deleteRows(TASKS, doomed);
    } catch (err) {
      console.error('Failed to delete section:', err);
      setTasks(previous);
      setActionError('Could not delete the section. Please try again.');
    }
  };

  const confirmDeleteRow = async () => {
    const target = deleteRowTarget;
    setDeleteRowTarget(null);
    if (!target) return;
    const previous = tasks;
    setActionError('');
    setTasks((prev) => prev.filter((t) => t.id !== target.id));
    try {
      await deleteRows(TASKS, [target]);
    } catch (err) {
      console.error('Failed to delete task:', err);
      setTasks(previous);
      setActionError('Could not delete the row. Please try again.');
    }
  };

  /** A new section is just a blank row at the end carrying a new section name. */
  const handleAddSection = () => {
    const sorted = [...tasks].sort((a, b) => a.order - b.order);
    const existing = new Set(tasks.map((t) => t.section));
    let name = 'New Section';
    for (let i = 2; existing.has(name); i++) name = `New Section ${i}`;
    addRow(name, sorted[sorted.length - 1] ?? null);
  };

  const patchProperty = async (target: OnboardingProperty, patch: Partial<OnboardingProperty>) => {
    if (!db) return;
    setActionError('');
    setProperties((prev) => prev.map((p) => (p.id === target.id ? { ...p, ...patch } : p)));
    try {
      await updateDoc(doc(db, PROPERTIES, target.id), patch);
    } catch (err) {
      console.error('Failed to update property:', err);
      setProperties((prev) => prev.map((p) => (p.id === target.id ? target : p)));
      setActionError('Could not save that change. Please try again.');
    }
  };

  /** Changing the closing date cascades to every task carrying an offset. */
  const handleClosingDateChange = async (nextClosing: string | null) => {
    if (!property) return;
    const previousProperty = property;
    const previousTasks = tasks;
    setActionError('');
    setProperties((prev) => prev.map((p) => (p.id === property.id ? { ...p, closingDate: nextClosing } : p)));
    try {
      const updated = await applyClosingDate(property.id, nextClosing, tasks);
      setTasks(updated);
    } catch (err) {
      console.error('Failed to apply the closing date:', err);
      setProperties((prev) => prev.map((p) => (p.id === property.id ? previousProperty : p)));
      setTasks(previousTasks);
      setActionError('Could not update the closing date. Please try again.');
    }
  };

  const handleCreateProperty = async () => {
    if (!newName.trim() || !user) return;
    setCreating(true);
    setActionError('');
    try {
      const template = await getOrSeedOnboardingTemplate(people);
      const { property: created, tasks: createdTasks } = await createPropertyFromTemplate(
        { name: newName.trim(), closingDate: newClosingDate || null },
        template,
        user.id,
      );
      setProperties((prev) => [...prev, created]);
      setTasks(createdTasks);
      setShowNewModal(false);
      setNewName('');
      setNewClosingDate('');
      navigate(`/onboarding/properties/${created.id}`);
    } catch (err) {
      console.error('Failed to create property:', err);
      setActionError('Could not create the property. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  const confirmDeleteProperty = async () => {
    const target = deletePropertyTarget;
    setDeletePropertyTarget(null);
    if (!target) return;
    const previous = properties;
    setActionError('');
    setProperties((prev) => prev.filter((p) => p.id !== target.id));
    try {
      const doomedTasks = target.id === propertyId ? tasks : await fetchTasksForProperty(target.id);
      await deletePropertyWithTasks(target.id, doomedTasks);
      if (target.id === propertyId) navigate('/onboarding/properties', { replace: true });
    } catch (err) {
      console.error('Failed to delete property:', err);
      setProperties(previous);
      setActionError('Could not delete the property. Please try again.');
    }
  };

  const confirmSaveTemplate = async () => {
    const target = saveTemplateTarget;
    setSaveTemplateTarget(null);
    if (!target) return;
    setSavingTemplate(true);
    setActionError('');
    setSuccessNotice('');
    try {
      await savePropertyChecklistAsTemplate(tasks);
      setSuccessNotice(`The checklist template was replaced with “${target.name}”. New properties will start from it; existing ones are unchanged.`);
    } catch (err) {
      console.error('Failed to save checklist as template:', err);
      setActionError('Could not save this checklist as the template. Please try again.');
    } finally {
      setSavingTemplate(false);
    }
  };

  if (loading) return <PageSpinner />;

  return (
    <div className="space-y-6">
      {successNotice && (
        <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 px-4 py-3 rounded-md" role="status">{successNotice}</p>
      )}
      {[propertiesError, checklistError, actionError].filter(Boolean).map((message) => (
        <p key={message} className="text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-md" role="alert">{message}</p>
      ))}

      {/* Property tabs */}
      <div className="flex items-end gap-2 border-b border-gray-200 overflow-x-auto pb-px">
        {visibleProperties.map((p) => {
          const active = p.id === propertyId;
          return (
            <button
              key={p.id}
              onClick={() => navigate(`/onboarding/properties/${p.id}`)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg border border-b-0 whitespace-nowrap transition-colors ${
                active
                  ? 'bg-white border-gray-200 text-brand-dark -mb-px'
                  : 'bg-gray-50 border-transparent text-gray-500 hover:text-gray-800 hover:bg-gray-100'
              }`}
            >
              {p.name}
              {p.archived && <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-400">Archived</span>}
            </button>
          );
        })}
        {isSuperadmin && (
          <button
            onClick={() => setShowNewModal(true)}
            className="px-3 py-2 text-sm font-medium text-gray-600 hover:text-brand-dark whitespace-nowrap"
          >
            <Plus className="h-4 w-4 inline -mt-0.5 mr-1" />New Property
          </button>
        )}
        {properties.some((p) => p.archived) && (
          <button
            onClick={() => setShowArchived((v) => !v)}
            className="ml-auto px-3 py-2 text-xs font-medium text-gray-500 hover:text-gray-800 whitespace-nowrap"
          >
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
        )}
      </div>

      {!property ? (
        <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center">
          <Building2 className="h-10 w-10 mx-auto text-gray-300" />
          <h2 className="mt-4 text-lg font-serif font-semibold text-gray-900">
            {propertyId ? 'Property not found' : 'No property selected'}
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            {propertyId
              ? 'This property no longer exists, or your access to it was removed.'
              : visibleProperties.length === 0
                ? isSuperadmin
                  ? 'Create your first property to start its onboarding checklist.'
                  : 'No properties have been set up yet.'
                : 'Pick a property tab above.'}
          </p>
          {isSuperadmin && !propertyId && visibleProperties.length === 0 && (
            <button
              onClick={() => setShowNewModal(true)}
              className="mt-5 inline-flex items-center px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#05391B] transition-colors"
            >
              <Plus className="h-4 w-4 mr-2" />New Property
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Property header */}
          <div className="bg-white shadow-sm rounded-xl border border-gray-200 p-6 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 className="text-2xl font-serif font-semibold text-gray-900">{property.name}</h1>
                <p className="mt-1 text-sm text-gray-500">
                  {doneCount} of {tasks.length} tasks done
                  {overdueCount > 0 && <span className="text-red-600 font-medium"> · {overdueCount} overdue</span>}
                </p>
              </div>
              {isSuperadmin && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { setSuccessNotice(''); setSaveTemplateTarget(property); }}
                    disabled={savingTemplate || tasks.length === 0}
                    title="Replace the master checklist template with this property's checklist"
                    className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 shadow-sm transition-colors disabled:opacity-50"
                  >
                    <LayoutTemplate className="h-4 w-4 mr-2" />
                    {savingTemplate ? 'Saving…' : 'Save as Template'}
                  </button>
                  <button
                    onClick={() => patchProperty(property, { archived: !property.archived })}
                    className="inline-flex items-center px-3 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 shadow-sm transition-colors"
                  >
                    {property.archived ? <ArchiveRestore className="h-4 w-4 mr-2" /> : <Archive className="h-4 w-4 mr-2" />}
                    {property.archived ? 'Unarchive' : 'Archive'}
                  </button>
                  <button
                    onClick={() => setDeletePropertyTarget(property)}
                    aria-label={`Delete ${property.name}`}
                    className="p-2 text-red-400 hover:text-red-600 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>

            <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
              <div
                className="bg-brand-dark h-2 rounded-full transition-all"
                style={{ width: tasks.length ? `${Math.round((doneCount / tasks.length) * 100)}%` : '0%' }}
              />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              {PROPERTY_DATES.map(({ key, label }) => (
                <div key={key}>
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">{label}</label>
                  <input
                    type="date"
                    value={(property[key] as string | null) ?? ''}
                    disabled={!isSuperadmin}
                    onChange={(e) => patchProperty(property, { [key]: e.target.value || null } as Partial<OnboardingProperty>)}
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark disabled:bg-gray-50 disabled:text-gray-500"
                  />
                </div>
              ))}
              <div>
                <label className="block text-xs font-medium text-brand-dark uppercase tracking-wider mb-1">Closing</label>
                <input
                  type="date"
                  value={property.closingDate ?? ''}
                  disabled={!isSuperadmin}
                  onChange={(e) => handleClosingDateChange(e.target.value || null)}
                  className="w-full border-2 border-brand-dark/30 rounded-md px-2 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-brand-dark disabled:bg-gray-50 disabled:text-gray-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Extension</label>
                <input
                  type="text"
                  value={property.extension ?? ''}
                  disabled={!isSuperadmin}
                  placeholder="1 x 30"
                  onChange={(e) => setProperties((prev) => prev.map((p) => (p.id === property.id ? { ...p, extension: e.target.value } : p)))}
                  onBlur={(e) => patchProperty(property, { extension: e.target.value })}
                  className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark disabled:bg-gray-50 disabled:text-gray-500"
                />
              </div>
            </div>
            {isSuperadmin && (
              <p className="text-xs text-gray-400">
                Changing the closing date recalculates every due date that has a “Days” offset.
              </p>
            )}
          </div>

          {tasksLoading ? (
            <PageSpinner />
          ) : (
            <ChecklistTable
              rows={tasks}
              people={people}
              mode="property"
              closingDate={property.closingDate}
              canEdit={canEdit}
              onPatchRow={handlePatchRow}
              onDueDateChange={handleDueDateChange}
              onAddRow={addRow}
              onDeleteRow={(row) => setDeleteRowTarget(tasks.find((t) => t.id === row.id) ?? null)}
              onMoveRow={handleMoveRow}
              onRenameSection={handleRenameSection}
              onDeleteSection={(section) => setDeleteSectionTarget(section)}
              onAddSection={handleAddSection}
            />
          )}
        </>
      )}

      {/* New property */}
      <Modal open={showNewModal} onClose={() => setShowNewModal(false)} labelledBy="new-property-title" widthClass="max-w-md">
        <div className="px-6 py-5 border-b border-gray-200">
          <h3 id="new-property-title" className="text-lg font-serif font-semibold text-gray-900">New Property</h3>
          <p className="mt-1 text-sm text-gray-500">The full template checklist is copied in, ready to customize.</p>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <label htmlFor="new-property-name" className="block text-sm font-medium text-gray-700 mb-1">Property name</label>
            <input
              id="new-property-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Riverchase Homes"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark"
            />
          </div>
          <div>
            <label htmlFor="new-property-closing" className="block text-sm font-medium text-gray-700 mb-1">Closing date</label>
            <input
              id="new-property-closing"
              type="date"
              value={newClosingDate}
              onChange={(e) => setNewClosingDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark"
            />
            <p className="mt-1 text-xs text-gray-400">Every due date is calculated from this. You can set or change it later.</p>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 bg-gray-50/50">
          <button onClick={() => setShowNewModal(false)} className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900">Cancel</button>
          <button
            onClick={handleCreateProperty}
            disabled={creating || !newName.trim()}
            className="px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#05391B] disabled:opacity-50 transition-colors"
          >
            {creating ? 'Creating…' : 'Create Property'}
          </button>
        </div>
      </Modal>

      <PostponeModal
        open={!!postponeTarget}
        taskTitle={postponeTarget?.task.title ?? ''}
        fromDate={postponeTarget?.task.dueDate ?? null}
        initialDate={postponeTarget?.newDate ?? null}
        onCancel={() => setPostponeTarget(null)}
        onConfirm={confirmPostpone}
      />

      <ConfirmModal
        open={!!saveTemplateTarget}
        title="Save Checklist as Template"
        message={
          saveTemplateTarget
            ? `Replace the master checklist template with “${saveTemplateTarget.name}”'s checklist (${tasks.length} rows)? The sections, items, responsibilities, and days-from-closing carry over — notes, statuses, and due dates are cleared. This overwrites the current template and can't be undone, but existing properties keep their checklists.`
            : ''
        }
        confirmLabel="Replace Template"
        onConfirm={confirmSaveTemplate}
        onCancel={() => setSaveTemplateTarget(null)}
      />

      <ConfirmModal
        open={!!deleteRowTarget}
        title="Delete Row"
        message={deleteRowTarget ? `Delete “${deleteRowTarget.title || 'this row'}” from ${property?.name}? This can't be undone.` : ''}
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
            ? `Delete the “${deleteSectionTarget}” section and all ${tasks.filter((t) => t.section === deleteSectionTarget).length} of its rows? This can't be undone.`
            : ''
        }
        confirmLabel="Delete Section"
        danger
        onConfirm={confirmDeleteSection}
        onCancel={() => setDeleteSectionTarget(null)}
      />
      <ConfirmModal
        open={!!deletePropertyTarget}
        title="Delete Property"
        message={
          deletePropertyTarget
            ? `Delete “${deletePropertyTarget.name}” and its entire checklist? This can't be undone — consider archiving instead.`
            : ''
        }
        confirmLabel="Delete"
        danger
        onConfirm={confirmDeleteProperty}
        onCancel={() => setDeletePropertyTarget(null)}
      />
    </div>
  );
}
