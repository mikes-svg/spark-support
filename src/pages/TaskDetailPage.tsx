/**
 * Task detail — Phase 1 of docs/CLICKUP_MIGRATION_PLAN.md.
 *
 * Stub. Model the real page on src/pages/TicketDetailPage.tsx: inline edit with
 * optimistic update + rollback + an actionError banner, comments and activity
 * in the right rail, attachments below. The comments, activity, attachments,
 * editor, and subtask components already exist as typed stubs under
 * src/components/tasks/ — wire those rather than inlining their markup.
 */
import { useParams, Link } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';

export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="bg-white shadow-sm rounded-xl border border-gray-200 px-6 py-16 text-center">
      <ClipboardList className="h-10 w-10 mx-auto text-gray-300" aria-hidden="true" />
      <h2 className="mt-4 text-lg font-serif font-semibold text-gray-900">Task detail</h2>
      <p className="mt-1 text-sm text-gray-500">
        Coming soon{id ? ` — task ${id}` : ''}.
      </p>
      <Link
        to="/tasks"
        className="mt-5 inline-flex items-center px-5 py-2 text-sm font-medium rounded-lg bg-brand-dark text-white hover:bg-[#05391B] transition-colors"
      >
        Back to My Tasks
      </Link>
    </div>
  );
}
