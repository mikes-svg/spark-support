import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  PlusCircle,
  Settings,
  Users,
  Ticket as TicketIcon,
  LogOut,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

function SidebarContent({ onClose }: { onClose: () => void }) {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';

  const navItems = [
    { to: '/', icon: LayoutDashboard, label: 'My Tickets', exact: true },
    { to: '/submit', icon: PlusCircle, label: 'Submit Request' },
  ];

  const adminItems = [
    { to: '/admin', icon: TicketIcon, label: 'All Tickets', exact: true },
    { to: '/admin/settings', icon: Settings, label: 'Settings' },
  ];

  return (
    <div className="w-64 bg-brand-dark text-white flex flex-col h-full">
      <div className="p-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <img src="/spark-logo.png" alt="Spark Management" className="h-10 brightness-0 invert" />
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-widest text-brand-gold font-semibold leading-none">Support</span>
            <span className="text-[10px] uppercase tracking-widest text-gray-400 mt-1 leading-none">Portal</span>
          </div>
        </div>
        <button onClick={onClose} className="md:hidden p-1 text-gray-400 hover:text-white">
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        <div className="mb-4 px-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">User</p>
        </div>
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.exact}
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
        ))}

        {isAdmin && (
          <>
            <div className="mt-8 mb-4 px-3">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Admin</p>
            </div>
            {adminItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.exact}
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
            ))}
          </>
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
              <p className="text-xs font-medium text-gray-400 capitalize">{user?.role}</p>
            </div>
          </div>
          <button onClick={logout} title="Sign out" className="ml-2 p-1.5 text-gray-400 hover:text-white transition-colors flex-shrink-0">
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
