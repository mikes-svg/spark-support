import { collection, doc, getDocs, query, where, writeBatch, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { CHECKLISTS, commitChunks, deleteRows, type ChecklistKind } from './onboarding';
import { SEEDS, resolveResponsible } from './checklistSeeds';
import type { OnboardingTask, OnboardingTemplateItem, Profile } from '../types';

/**
 * Named templates. Each checklist kind can have several (e.g. "Standard",
 * "Garden-style", "LIHTC"); a template's rows live in that kind's template
 * collection tagged with its id, and its name lives here.
 */
export const TEMPLATE_META = 'checklistTemplates';

export interface ChecklistTemplate {
  id: string;
  kind: ChecklistKind;
  name: string;
}

/**
 * The template that rows written before templates had names belong to. Its id
 * is fixed so those rows need no migration: a row with no templateId is in it.
 */
export function defaultTemplateId(kind: ChecklistKind): string {
  return `${kind}-default`;
}

const DEFAULT_NAME = 'Standard';

function templateOf(kind: ChecklistKind, item: OnboardingTemplateItem): string {
  return item.templateId ?? defaultTemplateId(kind);
}

async function fetchAllItems(kind: ChecklistKind): Promise<OnboardingTemplateItem[]> {
  if (!db) return [];
  const snap = await getDocs(collection(db, CHECKLISTS[kind].template));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as OnboardingTemplateItem));
}

/**
 * A kind's templates, default first, then by name. On first use (no templates
 * and no rows at all) the "Standard" template is seeded from the sheet; that
 * needs superadmin access and is skipped silently for everyone else.
 */
export async function fetchTemplates(kind: ChecklistKind, profiles: Profile[]): Promise<ChecklistTemplate[]> {
  if (!db) return [];
  const [metaSnap, items] = await Promise.all([
    getDocs(query(collection(db, TEMPLATE_META), where('kind', '==', kind))),
    fetchAllItems(kind),
  ]);
  const templates = metaSnap.docs.map((d) => ({ id: d.id, ...d.data() } as ChecklistTemplate));

  // Legacy rows with no named template doc still form the default template.
  const defaultId = defaultTemplateId(kind);
  if (!templates.some((t) => t.id === defaultId) && items.some((i) => templateOf(kind, i) === defaultId)) {
    templates.push({ id: defaultId, kind, name: DEFAULT_NAME });
  }

  if (templates.length === 0) {
    try {
      await seedDefaultTemplate(kind, profiles);
      templates.push({ id: defaultId, kind, name: DEFAULT_NAME });
    } catch (err) {
      console.warn(`Could not seed the ${kind} template (superadmin required):`, err);
    }
  }

  return templates.sort((a, b) =>
    a.id === defaultId ? -1 : b.id === defaultId ? 1 : a.name.localeCompare(b.name),
  );
}

/** One template's rows, in order. */
export async function fetchTemplateItems(kind: ChecklistKind, templateId: string): Promise<OnboardingTemplateItem[]> {
  const items = await fetchAllItems(kind);
  return items.filter((i) => templateOf(kind, i) === templateId).sort((a, b) => a.order - b.order);
}

async function seedDefaultTemplate(kind: ChecklistKind, profiles: Profile[]): Promise<void> {
  if (!db) return;
  const templateId = defaultTemplateId(kind);
  const items: OnboardingTemplateItem[] = SEEDS[kind].map((row, i) => ({
    id: doc(collection(db!, CHECKLISTS[kind].template)).id,
    templateId,
    section: row[0],
    code: row[1],
    indent: row[2],
    title: row[3],
    responsibleIds: resolveResponsible(row[4], profiles),
    daysFromClosing: row[5],
    // Leave gaps so rows can be inserted between two neighbours without
    // renumbering the whole list.
    order: (i + 1) * 100,
  }));
  await writeItems(kind, items);
  await setDoc(doc(db, TEMPLATE_META, templateId), { kind, name: DEFAULT_NAME, createdAt: serverTimestamp() });
}

async function writeItems(kind: ChecklistKind, items: OnboardingTemplateItem[]): Promise<void> {
  await commitChunks(items, (batch, { id, ...data }) =>
    batch.set(doc(db!, CHECKLISTS[kind].template, id), { ...data, createdAt: serverTimestamp() }),
  );
}

/** Copy rows into a template, with fresh ids, dropping anything per-property. */
function copyRows(
  kind: ChecklistKind,
  templateId: string,
  rows: (OnboardingTemplateItem | OnboardingTask)[],
): OnboardingTemplateItem[] {
  return [...rows]
    .sort((a, b) => a.order - b.order)
    .map((r) => ({
      id: doc(collection(db!, CHECKLISTS[kind].template)).id,
      templateId,
      section: r.section,
      order: r.order,
      code: r.code ?? '',
      indent: r.indent,
      title: r.title,
      responsibleIds: r.responsibleIds ?? [],
      daysFromClosing: r.daysFromClosing ?? null,
    }));
}

/**
 * Create a named template, empty or as a copy of `copyFrom` (another template's
 * rows, or a property's checklist). Returns the new template.
 */
export async function createTemplate(
  kind: ChecklistKind,
  name: string,
  copyFrom: (OnboardingTemplateItem | OnboardingTask)[] = [],
): Promise<ChecklistTemplate> {
  if (!db) throw new Error('Firestore is not configured.');
  const ref = doc(collection(db, TEMPLATE_META));
  await writeItems(kind, copyRows(kind, ref.id, copyFrom));
  // Name last: a template only appears in lists once its rows are written.
  await setDoc(ref, { kind, name, createdAt: serverTimestamp() });
  return { id: ref.id, kind, name };
}

export async function renameTemplate(template: ChecklistTemplate, name: string): Promise<void> {
  if (!db) throw new Error('Firestore is not configured.');
  // merge, so renaming the default writes its name doc if it never had one.
  await setDoc(doc(db, TEMPLATE_META, template.id), { kind: template.kind, name, updatedAt: serverTimestamp() }, { merge: true });
}

/** Delete a template and all its rows. Properties already created from it keep their checklists. */
export async function deleteTemplate(template: ChecklistTemplate): Promise<void> {
  if (!db) throw new Error('Firestore is not configured.');
  await deleteRows(CHECKLISTS[template.kind].template, await fetchTemplateItems(template.kind, template.id));
  const batch = writeBatch(db);
  batch.delete(doc(db, TEMPLATE_META, template.id));
  await batch.commit();
}

/**
 * Replace one template's rows with a property's current checklist structure.
 * Only the reusable shape carries over — section, order, code, indent, title,
 * responsibility, and days-from-closing; notes, statuses, due dates and delays
 * are dropped. Existing properties are untouched.
 */
export async function replaceTemplateRows(
  kind: ChecklistKind,
  templateId: string,
  tasks: OnboardingTask[],
): Promise<void> {
  if (!db) throw new Error('Firestore is not configured.');
  const existing = await fetchTemplateItems(kind, templateId);
  const items = copyRows(kind, templateId, tasks);
  const templateCollection = CHECKLISTS[kind].template;

  // A checklist is well under 500 rows, so the swap usually fits one atomic
  // batch: no window where the template is empty or holds duplicates.
  if (existing.length + items.length <= 450) {
    const batch = writeBatch(db);
    existing.forEach((i) => batch.delete(doc(db!, templateCollection, i.id)));
    items.forEach(({ id, ...data }) => batch.set(doc(db!, templateCollection, id), { ...data, createdAt: serverTimestamp() }));
    await batch.commit();
  } else {
    await writeItems(kind, items);
    await deleteRows(templateCollection, existing);
  }
}
