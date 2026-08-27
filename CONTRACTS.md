# Property Notebooks — pinned contract

Coordination file for the notebook swarm. **Do not edit files you don't own.**
Need a change to anything here? Append a request under "Change requests" and
return `BLOCKED` — don't edit the shared file yourself.

The foundation is landed and typechecks clean (`npx tsc --noEmit` exits 0).
TipTap 2.27 is installed. `firestore.rules` has the notebook rules.

## The feature

One **notebook per property**, owned by its creator and **private until shared**.
A notebook holds a flat list of **pages** (rich text). The owner can share the
whole notebook or a single page with **onboarding users** as **view** or **edit**.
Lives as a **Checklist / Notebook** sub-tab on the property page.

## Data model — `src/types.ts` (LANDED)

```ts
interface OnboardingNotebook {
  id: string;                  // == propertyId (one per property)
  propertyId: string;
  ownerId: string;
  pageOrder: string[];         // page ids in display order
  sharedWithUserIds: string[]; // notebook-level view
  editorIds: string[];         // notebook-level edit
  createdAt?; updatedAt?;
}
interface OnboardingNotebookPage {
  id: string; title: string;
  body: string;                // JSON.stringify(<TipTap doc>) — a STRING
  sharedWithUserIds: string[]; // page-level view
  editorIds: string[];         // page-level edit
  createdBy?; order?; createdAt?; updatedAt?;
}
type NotebookShareLevel = 'none' | 'view' | 'edit';
```

Firestore layout: `onboardingNotebooks/{propertyId}` with a `pages/{pageId}`
subcollection. `body` is stored as a **string** (TipTap JSON stringified) — the
20-level Firestore nesting cap rejects nested rich text otherwise.

## `src/lib/notebooks.ts` (LANDED — consume, do not redefine)

```ts
NOTEBOOKS: string
EMPTY_BODY: TipTapDoc                  // { type:'doc', content:[{type:'paragraph'}] }
type TipTapDoc = Record<string, unknown>
serializeBody(doc): string             parseBody(raw): TipTapDoc
getNotebook(propertyId): Promise<OnboardingNotebook | null>   // throws permission-denied if private to someone else
createNotebook(propertyId, ownerId): Promise<OnboardingNotebook>
fetchPages(notebook): Promise<OnboardingNotebookPage[]>       // ordered by notebook.pageOrder
createPage(notebook, title, createdBy): Promise<OnboardingNotebookPage>
updatePage(propertyId, pageId, { title?, body? /* TipTapDoc */ }): Promise<void>  // serializes body for you
deletePage(notebook, pageId): Promise<void>
reorderPages(propertyId, pageOrder: string[]): Promise<void>
shareNotebook(propertyId, userId, level): Promise<void>
sharePage(propertyId, pageId, userId, level): Promise<void>
fetchShareableUsers(): Promise<Profile[]>            // onboarding users only
shareLevelOf(target, userId): NotebookShareLevel
canViewNotebook(uid, nb) / canEditNotebook(uid, nb) / canManageShares(uid, nb): boolean
canViewPage(uid, nb, page) / canEditPage(uid, nb, page): boolean
```

Access is strict: privacy holds even for superadmins — a user sees a notebook
only if they own it or it's shared with them. Editing a notebook = add/edit/
reorder/delete pages; **managing shares is owner-only**.

## Component interfaces (pinned)

**`src/components/notebook/NoteEditor.tsx`** (Editor lane — stub landed):
```ts
interface NoteEditorProps { initialBody: TipTapDoc; editable: boolean; onChange: (body: TipTapDoc) => void }
```
A controlled TipTap editor. Seed from `initialBody`; the panel remounts it per
page via `key={page.id}`. Debounce edits (~800ms) and call `onChange(tiptapDoc)`;
the panel persists via `updatePage`. Hide the toolbar / disable when `!editable`.
Extensions available (installed): StarterKit, Link, Underline, Placeholder,
TaskList, TaskItem, Image.

**`src/components/notebook/ShareNotebookDialog.tsx`** (Sharing lane — stub landed):
```ts
type ShareTarget =
  | { kind: 'notebook'; notebook: OnboardingNotebook }
  | { kind: 'page'; notebook: OnboardingNotebook; page: OnboardingNotebookPage }
interface ShareNotebookDialogProps {
  open: boolean; target: ShareTarget | null; people: Profile[];
  onShare: (userId, level) => Promise<void>; onClose: () => void;
}
```
KEEP the `ShareTarget` export and this shape — the panel imports both. Read the
current level per user with `shareLevelOf(target.notebook|page, userId)`.

## Lane ownership

| Lane | Owns (create/edit only these) |
|---|---|
| Editor | `src/components/notebook/NoteEditor.tsx` |
| Notebook panel | `src/components/notebook/NotebookPanel.tsx` (new), `src/pages/OnboardingPropertiesPage.tsx` (add a Checklist/Notebook sub-tab) |
| Sharing | `src/components/notebook/ShareNotebookDialog.tsx` |

Shared/contract files (foundation-owned, everyone else read-only): `src/types.ts`,
`src/lib/notebooks.ts`, `src/lib/onboarding.ts`, `firestore.rules`,
`firestore.indexes.json`, `package.json`, this file.

## Existing patterns to reuse
- `useAuth()` → `{ user }`; `user.id` is the uid.
- `Modal` / `ConfirmModal` in `src/components/`, `PageSpinner`.
- Optimistic update + rollback + an `actionError` banner — see
  `src/pages/OnboardingPropertiesPage.tsx` and `TeamPage.tsx`.
- Brand tokens: `brand-dark` (#064923), `brand-gold`, `font-serif`.

## Change requests
_(append here, then return BLOCKED)_
