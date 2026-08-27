import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, Share2, Pencil, BookOpen } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { PageSpinner } from '../PageSpinner';
import { ConfirmModal } from '../ConfirmModal';
import { NoteEditor } from './NoteEditor';
import { ShareNotebookDialog, type ShareTarget } from './ShareNotebookDialog';
import {
  getNotebook,
  createNotebook,
  fetchPages,
  createPage,
  updatePage,
  deletePage,
  reorderPages,
  shareNotebook,
  sharePage,
  fetchShareableUsers,
  parseBody,
  serializeBody,
  canEditNotebook,
  canManageShares,
  canViewPage,
  canEditPage,
  type TipTapDoc,
} from '../../lib/notebooks';
import type {
  OnboardingNotebook,
  OnboardingNotebookPage,
  NotebookShareLevel,
  Profile,
} from '../../types';

interface NotebookPanelProps {
  propertyId: string;
}

export function NotebookPanel({ propertyId }: NotebookPanelProps) {
  const { user } = useAuth();
  const uid = user?.id;

  const [loading, setLoading] = useState(true);
  const [notebook, setNotebook] = useState<OnboardingNotebook | null>(null);
  const [privateElsewhere, setPrivateElsewhere] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [creating, setCreating] = useState(false);

  const [pages, setPages] = useState<OnboardingNotebookPage[]>([]);
  const [people, setPeople] = useState<Profile[]>([]);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  const [addingPage, setAddingPage] = useState(false);
  const [newPageTitle, setNewPageTitle] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<OnboardingNotebookPage | null>(null);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);

  const loadNotebook = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    setPrivateElsewhere(false);
    try {
      const nb = await getNotebook(propertyId);
      setNotebook(nb);
      if (nb) {
        const [pgs, ppl] = await Promise.all([fetchPages(nb), fetchShareableUsers()]);
        setPages(pgs);
        setPeople(ppl);
      } else {
        setPages([]);
      }
    } catch (err) {
      if ((err as { code?: string })?.code === 'permission-denied') {
        setPrivateElsewhere(true);
      } else {
        console.error('Failed to load notebook:', err);
        setLoadError('Could not load this notebook. Please refresh.');
      }
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    loadNotebook();
  }, [loadNotebook]);

  // Keep a valid selection: fall back to the first page the user may view.
  useEffect(() => {
    if (!notebook || !uid) return;
    const viewable = pages.filter((p) => canViewPage(uid, notebook, p));
    if (selectedPageId && viewable.some((p) => p.id === selectedPageId)) return;
    setSelectedPageId(viewable[0]?.id ?? null);
  }, [pages, notebook, uid, selectedPageId]);

  useEffect(() => {
    setSaveState('idle');
  }, [selectedPageId]);

  const canEdit = !!notebook && canEditNotebook(uid, notebook);
  const canShare = !!notebook && canManageShares(uid, notebook);
  const visiblePages = notebook ? pages.filter((p) => canViewPage(uid, notebook, p)) : [];
  const selectedPage = visiblePages.find((p) => p.id === selectedPageId) ?? null;

  const handleStartNotebook = async () => {
    if (!uid) return;
    setCreating(true);
    setActionError('');
    try {
      const nb = await createNotebook(propertyId, uid);
      setNotebook(nb);
      const [pgs, ppl] = await Promise.all([fetchPages(nb), fetchShareableUsers()]);
      setPages(pgs);
      setPeople(ppl);
    } catch (err) {
      console.error('Failed to start notebook:', err);
      setActionError('Could not start the notebook. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  const handleCreatePage = async () => {
    if (!notebook || !uid) return;
    const title = newPageTitle.trim() || 'Untitled';
    setActionError('');
    try {
      const page = await createPage(notebook, title, uid);
      const nb = await getNotebook(propertyId);
      if (nb) {
        setNotebook(nb);
        setPages(await fetchPages(nb));
      }
      setSelectedPageId(page.id);
      setAddingPage(false);
      setNewPageTitle('');
    } catch (err) {
      console.error('Failed to create page:', err);
      setActionError('Could not add the page. Please try again.');
    }
  };

  const commitRename = async (page: OnboardingNotebookPage) => {
    const title = renameValue.trim() || 'Untitled';
    setRenamingId(null);
    if (title === page.title) return;
    setPages((prev) => prev.map((p) => (p.id === page.id ? { ...p, title } : p)));
    setActionError('');
    try {
      await updatePage(propertyId, page.id, { title });
    } catch (err) {
      console.error('Failed to rename page:', err);
      setPages((prev) => prev.map((p) => (p.id === page.id ? { ...p, title: page.title } : p)));
      setActionError('Could not rename the page. Please try again.');
    }
  };

  const confirmDeletePage = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target || !notebook) return;
    const previous = pages;
    setActionError('');
    setPages((prev) => prev.filter((p) => p.id !== target.id));
    if (selectedPageId === target.id) setSelectedPageId(null);
    try {
      await deletePage(notebook, target.id);
      const nb = await getNotebook(propertyId);
      if (nb) setNotebook(nb);
    } catch (err) {
      console.error('Failed to delete page:', err);
      setPages(previous);
      setActionError('Could not delete the page. Please try again.');
    }
  };

  const movePage = async (page: OnboardingNotebookPage, direction: -1 | 1) => {
    if (!notebook) return;
    const index = pages.findIndex((p) => p.id === page.id);
    const swapWith = index + direction;
    if (index < 0 || swapWith < 0 || swapWith >= pages.length) return;
    const next = [...pages];
    [next[index], next[swapWith]] = [next[swapWith], next[index]];
    const previous = pages;
    const order = next.map((p) => p.id);
    setActionError('');
    setPages(next);
    try {
      await reorderPages(propertyId, order);
      setNotebook({ ...notebook, pageOrder: order });
    } catch (err) {
      console.error('Failed to reorder pages:', err);
      setPages(previous);
      setActionError('Could not reorder the pages. Please try again.');
    }
  };

  const handleBodyChange = async (page: OnboardingNotebookPage, body: TipTapDoc) => {
    if (!notebook || !canEditPage(uid, notebook, page)) return;
    const previousBody = page.body;
    const serialized = serializeBody(body);
    if (serialized === previousBody) return;
    setPages((prev) => prev.map((p) => (p.id === page.id ? { ...p, body: serialized } : p)));
    setSaveState('saving');
    setActionError('');
    try {
      await updatePage(propertyId, page.id, { body });
      setSaveState('saved');
    } catch (err) {
      console.error('Failed to save the page:', err);
      setPages((prev) => prev.map((p) => (p.id === page.id ? { ...p, body: previousBody } : p)));
      setSaveState('idle');
      setActionError('Could not save your changes. Please try again.');
    }
  };

  const handleShare = async (userId: string, level: NotebookShareLevel) => {
    if (!shareTarget) return;
    if (shareTarget.kind === 'notebook') {
      await shareNotebook(propertyId, userId, level);
    } else {
      await sharePage(propertyId, shareTarget.page.id, userId, level);
    }
    const nb = await getNotebook(propertyId);
    if (!nb) return;
    setNotebook(nb);
    const pgs = await fetchPages(nb);
    setPages(pgs);
    if (shareTarget.kind === 'notebook') {
      setShareTarget({ kind: 'notebook', notebook: nb });
    } else {
      const updated = pgs.find((p) => p.id === shareTarget.page.id);
      if (updated) setShareTarget({ kind: 'page', notebook: nb, page: updated });
    }
  };

  if (loading) return <PageSpinner />;

  if (privateElsewhere) {
    return (
      <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center">
        <BookOpen className="h-10 w-10 mx-auto text-gray-300" />
        <h2 className="mt-4 text-lg font-serif font-semibold text-gray-900">Private notebook</h2>
        <p className="mt-1 text-sm text-gray-500">
          This property already has a private notebook. Ask its owner to share it with you.
        </p>
      </div>
    );
  }

  if (loadError) {
    return (
      <p className="text-sm text-red-700 bg-red-50 border border-red-200 px-4 py-3 rounded-md" role="alert">
        {loadError}
      </p>
    );
  }

  if (!notebook) {
    return (
      <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center">
        <BookOpen className="h-10 w-10 mx-auto text-gray-300" />
        <h2 className="mt-4 text-lg font-serif font-semibold text-gray-900">No notebook yet</h2>
        <p className="mt-1 text-sm text-gray-500">
          Start a shared notebook for this property. You'll own it, and it stays private until you share it.
        </p>
        {actionError && (
          <p className="mt-4 text-sm text-red-700" role="alert">{actionError}</p>
        )}
        <button
          onClick={handleStartNotebook}
          disabled={creating}
          className="mt-5 inline-flex items-center px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#05391B] disabled:opacity-50 transition-colors"
        >
          <Plus className="h-4 w-4 mr-2" />
          {creating ? 'Starting…' : 'Start a notebook'}
        </button>
      </div>
    );
  }

  return (
    <div className="bg-white shadow-sm rounded-xl border border-gray-200 overflow-hidden">
      {actionError && (
        <p className="text-sm text-red-700 bg-red-50 border-b border-red-200 px-4 py-3" role="alert">{actionError}</p>
      )}
      <div className="flex flex-col md:flex-row md:min-h-[28rem]">
        {/* Pages rail */}
        <div className="w-full md:w-64 shrink-0 border-b md:border-b-0 md:border-r border-gray-200 bg-gray-50/60 flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <h3 className="text-sm font-serif font-semibold text-gray-900">Pages</h3>
            {canShare && (
              <button
                onClick={() => setShareTarget({ kind: 'notebook', notebook })}
                className="inline-flex items-center text-xs font-medium text-gray-600 hover:text-brand-dark transition-colors"
              >
                <Share2 className="h-3.5 w-3.5 mr-1" />Share
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto py-2">
            {visiblePages.length === 0 ? (
              <p className="px-4 py-6 text-sm text-gray-500 text-center">No pages yet.</p>
            ) : (
              <ul className="space-y-0.5 px-2">
                {visiblePages.map((page, i) => {
                  const active = page.id === selectedPageId;
                  return (
                    <li key={page.id}>
                      {renamingId === page.id ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => commitRename(page)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(page);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark"
                        />
                      ) : (
                        <div
                          className={`group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors ${
                            active ? 'bg-brand-dark text-white' : 'text-gray-700 hover:bg-gray-100'
                          }`}
                        >
                          <button
                            onClick={() => setSelectedPageId(page.id)}
                            className="flex-1 min-w-0 text-left truncate"
                            title={page.title}
                          >
                            {page.title}
                          </button>
                          {canEdit && (
                            <span className={`flex items-center gap-0.5 shrink-0 ${active ? 'opacity-90' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
                              <button
                                onClick={() => movePage(page, -1)}
                                disabled={i === 0}
                                aria-label="Move page up"
                                className="p-0.5 disabled:opacity-30 hover:text-brand-gold"
                              >
                                <ChevronUp className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => movePage(page, 1)}
                                disabled={i === visiblePages.length - 1}
                                aria-label="Move page down"
                                className="p-0.5 disabled:opacity-30 hover:text-brand-gold"
                              >
                                <ChevronDown className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => { setRenamingId(page.id); setRenameValue(page.title); }}
                                aria-label="Rename page"
                                className="p-0.5 hover:text-brand-gold"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => setDeleteTarget(page)}
                                aria-label="Delete page"
                                className="p-0.5 hover:text-red-300"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </span>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {canEdit && (
            <div className="border-t border-gray-200 p-3">
              {addingPage ? (
                <div className="space-y-2">
                  <input
                    autoFocus
                    value={newPageTitle}
                    onChange={(e) => setNewPageTitle(e.target.value)}
                    placeholder="Page title"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreatePage();
                      if (e.key === 'Escape') { setAddingPage(false); setNewPageTitle(''); }
                    }}
                    className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-dark"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => { setAddingPage(false); setNewPageTitle(''); }}
                      className="px-2 py-1 text-xs font-medium text-gray-600 hover:text-gray-900"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreatePage}
                      className="px-3 py-1 text-xs font-medium rounded-md bg-brand-dark text-white hover:bg-[#05391B] transition-colors"
                    >
                      Add
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setAddingPage(true)}
                  className="w-full inline-flex items-center justify-center px-3 py-2 text-sm font-medium rounded-md border border-gray-300 text-gray-700 bg-white hover:bg-gray-50 transition-colors"
                >
                  <Plus className="h-4 w-4 mr-1.5" />New page
                </button>
              )}
            </div>
          )}
        </div>

        {/* Editor host */}
        <div className="flex-1 min-w-0 p-6">
          {!selectedPage ? (
            <div className="h-full flex items-center justify-center text-center">
              <p className="text-sm text-gray-500">
                {visiblePages.length === 0
                  ? canEdit
                    ? 'No pages yet — add your first page to start writing.'
                    : 'This notebook has no pages shared with you.'
                  : 'Select a page to read or edit it.'}
              </p>
            </div>
          ) : (
            (() => {
              const editablePage = canEditPage(uid, notebook, selectedPage);
              return (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 pb-3">
                    {editablePage ? (
                      <input
                        value={selectedPage.title}
                        onChange={(e) =>
                          setPages((prev) => prev.map((p) => (p.id === selectedPage.id ? { ...p, title: e.target.value } : p)))
                        }
                        onBlur={(e) => updatePage(propertyId, selectedPage.id, { title: e.target.value.trim() || 'Untitled' })}
                        className="flex-1 min-w-0 text-xl font-serif font-semibold text-gray-900 border-none focus:outline-none focus:ring-0 bg-transparent px-0"
                      />
                    ) : (
                      <h2 className="flex-1 min-w-0 text-xl font-serif font-semibold text-gray-900 truncate">{selectedPage.title}</h2>
                    )}
                    <div className="flex items-center gap-3 shrink-0">
                      {editablePage && saveState !== 'idle' && (
                        <span className="text-xs text-gray-400">{saveState === 'saving' ? 'Saving…' : 'Saved'}</span>
                      )}
                      {canShare && (
                        <button
                          onClick={() => setShareTarget({ kind: 'page', notebook, page: selectedPage })}
                          className="inline-flex items-center text-xs font-medium text-gray-600 hover:text-brand-dark transition-colors"
                        >
                          <Share2 className="h-3.5 w-3.5 mr-1" />Share page
                        </button>
                      )}
                    </div>
                  </div>
                  <NoteEditor
                    key={selectedPage.id}
                    initialBody={parseBody(selectedPage.body)}
                    editable={editablePage}
                    onChange={(body) => handleBodyChange(selectedPage, body)}
                  />
                </div>
              );
            })()
          )}
        </div>
      </div>

      <ConfirmModal
        open={!!deleteTarget}
        title="Delete Page"
        message={deleteTarget ? `Delete “${deleteTarget.title || 'this page'}”? This can't be undone.` : ''}
        confirmLabel="Delete"
        danger
        onConfirm={confirmDeletePage}
        onCancel={() => setDeleteTarget(null)}
      />

      {canShare && (
        <ShareNotebookDialog
          open={!!shareTarget}
          target={shareTarget}
          people={people}
          onShare={handleShare}
          onClose={() => setShareTarget(null)}
        />
      )}
    </div>
  );
}
