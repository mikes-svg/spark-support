import { describe, expect, it } from 'vitest';

/**
 * App.tsx lazy-imports every task page BY NAMED EXPORT. A lane that renames its
 * export — or moves the file — breaks the route at runtime, in production, only
 * when someone navigates to it: `tsc` can't see through the dynamic import and
 * the build happily emits a chunk that throws on load.
 *
 * This walks the same import paths App.tsx uses and asserts the component is
 * still there, so a rename fails in CI instead of in the sidebar.
 */
const ROUTES: { path: string; component: string; load: () => Promise<Record<string, unknown>> }[] = [
  { path: '/tasks', component: 'TasksPage', load: () => import('./pages/TasksPage') },
  { path: '/tasks/all', component: 'TeamTasksPage', load: () => import('./pages/TeamTasksPage') },
  { path: '/tasks/calendar', component: 'TaskCalendarPage', load: () => import('./pages/TaskCalendarPage') },
  { path: '/tasks/templates', component: 'TaskTemplatesPage', load: () => import('./pages/TaskTemplatesPage') },
  { path: '/tasks/:id', component: 'TaskDetailPage', load: () => import('./pages/TaskDetailPage') },
  { path: '/admin/workload', component: 'WorkloadPage', load: () => import('./pages/WorkloadPage') },
  { path: '/admin/tasks', component: 'TaskSettingsPage', load: () => import('./pages/admin/TaskSettingsPage') },
  { path: '/admin/reassign', component: 'ReassignPage', load: () => import('./pages/admin/ReassignPage') },
  { path: '/settings/calendar', component: 'CalendarSyncSettingsPage', load: () => import('./pages/CalendarSyncSettingsPage') },
];

describe('task routes', () => {
  it.each(ROUTES)('$path resolves to $component', async ({ component, load }) => {
    const mod = await load();
    expect(typeof mod[component]).toBe('function');
  });
});
