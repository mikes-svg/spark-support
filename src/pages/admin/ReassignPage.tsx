/**
 * Reassign Work — Phase 7 of docs/CLICKUP_MIGRATION_PLAN.md.
 *
 * Stub. The route, the sidebar entry, and every shared type this page consumes
 * are already live, so the rest of the app compiles and navigates against it;
 * the Admin lane lane replaces this body. Do not widen the export name — App.tsx
 * lazy-imports it by name and no lane owns App.tsx.
 */
import { UserMinus } from 'lucide-react';

export function ReassignPage() {
  return (
    <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center">
      <UserMinus className="h-10 w-10 mx-auto text-gray-300" aria-hidden="true" />
      <h2 className="mt-4 text-lg font-serif font-semibold text-gray-900">Reassign Work</h2>
      <p className="mt-1 text-sm text-gray-500 max-w-md mx-auto">Move everything assigned to a departing person onto whoever picks it up.</p>
    </div>
  );
}
