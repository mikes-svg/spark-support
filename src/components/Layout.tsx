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
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
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
        className="pointer-events-none fixed bottom-2 right-3 text-[10px] text-gray-400 font-mono select-none z-10"
      >
        {buildLabel}
      </div>
    </div>
  );
}
