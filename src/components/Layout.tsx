import { useState, Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { PageSpinner } from './PageSpinner';

export function Layout() {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const getPageTitle = (pathname: string) => {
    if (pathname === '/') return 'My Tickets';
    if (pathname === '/submit') return 'Submit Request';
    if (pathname.startsWith('/tickets/')) return 'Ticket Details';
    if (pathname === '/admin') return 'All Tickets';
    if (pathname === '/admin/team') return 'Team';
    if (pathname === '/admin/analytics') return 'Analytics';
    if (pathname === '/admin/settings') return 'Settings';
    if (pathname === '/admin/workload') return 'Workload';
    if (pathname === '/admin/tasks') return 'Task Settings';
    if (pathname === '/admin/reassign') return 'Reassign Work';
    // The three /tasks/<literal> routes are matched BEFORE the /tasks/:id
    // prefix below, or a detail-page test would swallow them.
    if (pathname === '/tasks') return 'My Tasks';
    if (pathname === '/tasks/all') return 'Team Tasks';
    if (pathname === '/tasks/calendar') return 'Calendar';
    if (pathname === '/tasks/templates') return 'Task Templates';
    if (pathname.startsWith('/tasks/')) return 'Task Details';
    if (pathname === '/settings/calendar') return 'Calendar Sync';
    // Mirrors the sidebar label, which is "Onboarding Tasks" now that the
    // task section owns the plain "My Tasks" name.
    if (pathname === '/onboarding') return 'Onboarding Tasks';
    if (pathname.startsWith('/onboarding/properties')) return 'Property Onboarding';
    if (pathname === '/onboarding/template') return 'Checklist Template';
    return 'Portal';
  };

  const buildDate = new Date(__BUILD_TIME__);
  const buildLabel = `v ${buildDate.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;

  return (
    <div className="flex h-screen bg-brand-cream overflow-hidden">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header
          title={getPageTitle(location.pathname)}
          onMenuClick={() => setSidebarOpen(true)}
        />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 pb-12 sm:pb-14">
          {/* key changes on navigation, replaying the CSS fade-in animation */}
          <div key={location.pathname} className="h-full max-w-7xl mx-auto animate-fade-in-up">
            <Suspense fallback={<PageSpinner />}>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
      <div
        title={`Last build: ${buildDate.toISOString()}`}
        className="pointer-events-none fixed bottom-2 right-3 text-[12px] text-gray-600 font-mono select-none z-20 bg-brand-cream border border-gray-200 rounded px-1.5 py-0.5 shadow-sm"
      >
        {buildLabel}
      </div>
    </div>
  );
}
