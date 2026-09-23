/**
 * Team Tasks — Phase 4 of docs/CLICKUP_MIGRATION_PLAN.md.
 *
 * Stub. The route, the sidebar entry, and every shared type this page consumes
 * are already live, so the rest of the app compiles and navigates against it;
 * the Views lane lane replaces this body. Do not widen the export name — App.tsx
 * lazy-imports it by name and no lane owns App.tsx.
 */
import { ListTodo } from 'lucide-react';

export function TeamTasksPage() {
  return (
    <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center">
      <ListTodo className="h-10 w-10 mx-auto text-gray-300" aria-hidden="true" />
      <h2 className="mt-4 text-lg font-serif font-semibold text-gray-900">Team Tasks</h2>
      <p className="mt-1 text-sm text-gray-500 max-w-md mx-auto">The whole team's work, with filters, grouping, and saved views.</p>
    </div>
  );
}
