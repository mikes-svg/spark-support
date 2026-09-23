/**
 * My Tasks — Phase 1 of docs/CLICKUP_MIGRATION_PLAN.md.
 *
 * Stub. The route, the sidebar entry, and every shared type this page consumes
 * are already live, so the rest of the app compiles and navigates against it;
 * the Tasks lane lane replaces this body. Do not widen the export name — App.tsx
 * lazy-imports it by name and no lane owns App.tsx.
 */
import { ListChecks } from 'lucide-react';

export function TasksPage() {
  return (
    <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center">
      <ListChecks className="h-10 w-10 mx-auto text-gray-300" aria-hidden="true" />
      <h2 className="mt-4 text-lg font-serif font-semibold text-gray-900">My Tasks</h2>
      <p className="mt-1 text-sm text-gray-500 max-w-md mx-auto">Everything assigned to you, across every space and list, sorted by urgency.</p>
    </div>
  );
}
