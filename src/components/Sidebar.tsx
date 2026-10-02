import { useState, useCallback } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  PlusCircle,
  Settings,
  Users,
  Ticket as TicketIcon,
  BarChart3,
  LogOut,
  X,
  ClipboardList,
  Building2,
  LayoutTemplate,
  ListChecks,
  ListTodo,
  CalendarDays,
  Bell,
  ChevronDown,
  Gauge,
  SlidersHorizontal,
  UserMinus,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { roleLabel, isAdminRole, isSuperadminRole, hasOnboardingAccess, hasTasksAccess } from '../types';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

interface NavItem {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  exact?: boolean;
  /** Overrides the accessible name when the visible label collides with another control. */
  ariaLabel?: string;
}

function SidebarNavLink({ item, onClose }: { item: NavItem; onClose: () => void }) {
  return (
    <NavLink
      to={item.to}
      end={item.exact}
      aria-label={item.ariaLabel}
      onClick={onClose}
      className={({ isActive }) =>
        `group flex items-center px-3 py-2.5 text-sm font-medium rounded-md relative transition-colors ${
          isActive ? 'bg-white/10 text-white' : 'text-gray-300 hover:bg-white/5 hover:text-white'
        }`
      }>
      {({ isActive }) => (
        <>
          {isActive && <div className="absolute left-0 top-0 bottom-0 w-1 bg-brand-gold rounded-r-md" />}
          <item.icon className={`mr-3 flex-shrink-0 h-5 w-5 ${isActive ? 'text-brand-gold' : 'text-gray-400 group-hover:text-gray-300'}`} />
          {item.label}
        </>
      )}
    </NavLink>
  );
}

const COLLAPSED_KEY = 'sparkSidebarCollapsed';

/**
 * Which sections are collapsed, remembered per browser.
 *
 * localStorage is the right home for this: it is a per-viewer convenience, not
 * shared state, and it must not break the nav when it is unavailable — private
 * windows and blocked site data both make these calls throw, so every read and
 * write is guarded and the sidebar renders fully expanded if anything fails.
 */
function readCollapsed(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeCollapsed(next: Record<string, boolean>) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
  } catch {
    /* Non-fatal: the sidebar simply forgets between visits. */
  }
}

function NavSection({
  title, items, collapsed, onToggle, onClose, first = false,
}: {
  title: string;
  items: NavItem[];
  collapsed: boolean;
  onToggle: () => void;
  onClose: () => void;
  first?: boolean;
}) {
  const id = `sidebar-section-${title.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <div className={first ? '' : 'mt-6'}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={id}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-gray-300 uppercase tracking-wider hover:text-white transition-colors"
      >
        <span>{title}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`}
          aria-hidden="true"
        />
      </button>
      {!collapsed && (
        <div id={id} className="space-y-1 mt-1">
          {items.map((item) => (
            <SidebarNavLink key={item.to} item={item} onClose={onClose} />
          ))}
        </div>
      )}
    </div>
  );
}

function SidebarContent({ onClose }: { onClose: () => void }) {
  const { user, logout } = useAuth();
  const isAdmin = isAdminRole(user?.role);
  const isSuperadmin = isSuperadminRole(user?.role);
  const canOnboard = hasOnboardingAccess(user);
  const canUseTasks = hasTasksAccess(user);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const toggleSection = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      writeCollapsed(next);
      return next;
    });
  }, []);

  const navItems: NavItem[] = [
    { to: '/', icon: LayoutDashboard, label: 'My Tickets', exact: true },
    { to: '/submit', icon: PlusCircle, label: 'Submit Request', ariaLabel: 'Submit Request page' },
    // Tasks are granted per person from the Team page, the same way onboarding
    // is: Administrators always have them, everyone else needs the toggle. The
    // section replaces a tool not everyone used, so showing it to the whole
    // company would put empty screens in front of people who have no tasks.
    // 'My Tasks' is exact so /tasks/all and /tasks/calendar don't leave it
    // highlighted alongside their own entry.
    ...(canUseTasks ? [
      { to: '/tasks', icon: ListChecks, label: 'My Tasks', exact: true },
      { to: '/tasks/all', icon: ListTodo, label: 'Team Tasks' },
      { to: '/tasks/calendar', icon: CalendarDays, label: 'Calendar' },
      { to: '/settings/notifications', icon: Bell, label: 'Notifications' },
    ] : []),
  ];

  const adminItems: NavItem[] = [
    { to: '/admin', icon: TicketIcon, label: 'All Tickets', exact: true },
    { to: '/admin/workload', icon: Gauge, label: 'Workload' },
    ...(isSuperadmin ? [
      { to: '/admin/team', icon: Users, label: 'Team' },
      { to: '/admin/analytics', icon: BarChart3, label: 'Analytics' },
      { to: '/admin/settings', icon: Settings, label: 'Settings' },
      { to: '/admin/tasks', icon: SlidersHorizontal, label: 'Task Settings' },
      { to: '/admin/reassign', icon: UserMinus, label: 'Reassign Work' },
    ] : []),
  ];

  const onboardingItems: NavItem[] = [
    // Renamed from 'My Tasks' when the task tabs landed — the plain name now
    // belongs to /tasks. Label only: the route, page, and permissions are
    // unchanged, so existing links and bookmarks still work.
    { to: '/onboarding', icon: ClipboardList, label: 'Onboarding Tasks', exact: true },
    { to: '/onboarding/properties', icon: Building2, label: 'Properties' },
    ...(isSuperadmin ? [
      { to: '/onboarding/template', icon: LayoutTemplate, label: 'Template' },
    ] : []),
  ];

  return (
    <div className="w-64 bg-brand-dark text-white flex flex-col h-full">
      <div className="p-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/spark-logo.png" alt="Spark Management" className="h-10 brightness-0 invert" />
          <div className="flex flex-col">
            <span className="text-[12px] uppercase tracking-widest text-brand-gold font-semibold leading-none">Support</span>
            <span className="text-[12px] uppercase tracking-widest text-gray-300 mt-1 leading-none">Portal</span>
          </div>
        </div>
        <button onClick={onClose} aria-label="Close sidebar" className="md:hidden flex items-center justify-center min-h-[44px] min-w-[44px] -mr-2 p-1 text-gray-400 hover:text-white">
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Scrolls independently of the logo and the footer, which stay pinned —
          with three sections expanded the nav is taller than a laptop viewport,
          and without this the sign-out control fell off the bottom. */}
      <nav className="flex-1 min-h-0 overflow-y-auto px-3 py-4 sidebar-scroll">
        <NavSection
          first
          title="User"
          items={navItems}
          collapsed={!!collapsed.user}
          onToggle={() => toggleSection('user')}
          onClose={onClose}
        />

        {isAdmin && (
          <NavSection
            title="Admin"
            items={adminItems}
            collapsed={!!collapsed.admin}
            onToggle={() => toggleSection('admin')}
            onClose={onClose}
          />
        )}

        {canOnboard && (
          <NavSection
            title="Onboarding"
            items={onboardingItems}
            collapsed={!!collapsed.onboarding}
            onToggle={() => toggleSection('onboarding')}
            onClose={onClose}
          />
        )}
      </nav>

      <div className="p-4 border-t border-white/10">
        <div className="flex items-center justify-between">
          <div className="flex items-center min-w-0">
            <img
              className="inline-block h-9 w-9 rounded-full border-2 border-brand-gold/50 flex-shrink-0"
              src={user?.photoURL}
              alt=""
            />
            <div className="ml-3 min-w-0">
              <p className="text-sm font-medium text-white truncate">{user?.name}</p>
              <p className="text-xs font-medium text-gray-300">{roleLabel(user?.role)}</p>
            </div>
          </div>
          <button onClick={logout} title="Sign out" aria-label="Sign out" className="ml-2 flex items-center justify-center min-h-[44px] min-w-[44px] -mr-2 p-1.5 text-gray-400 hover:text-white transition-colors flex-shrink-0">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  return (
    <>
      {/* Desktop: always visible */}
      <div className="hidden md:flex flex-shrink-0">
        <SidebarContent onClose={onClose} />
      </div>

      {/* Mobile: overlay drawer */}
      {isOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div className="fixed inset-0 bg-black/50" onClick={onClose} />
          <div className="relative flex-shrink-0 z-50">
            <SidebarContent onClose={onClose} />
          </div>
        </div>
      )}
    </>
  );
}
