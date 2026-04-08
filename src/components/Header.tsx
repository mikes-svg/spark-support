import React from 'react';
import { Bell, Menu } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

interface HeaderProps {
  title: string;
  onMenuClick: () => void;
}

export function Header({ title, onMenuClick }: HeaderProps) {
  const { user } = useAuth();
  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
      <div className="flex items-center justify-between px-4 sm:px-6 lg:px-8 h-16">
        <div className="flex items-center">
          <button
            type="button"
            onClick={onMenuClick}
            className="md:hidden p-2 -ml-2 mr-2 text-gray-400 hover:text-gray-500">
            <span className="sr-only">Open sidebar</span>
            <Menu className="h-6 w-6" aria-hidden="true" />
          </button>
          <h1 className="text-xl font-serif font-semibold text-gray-900">
            {title}
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            className="relative p-2 text-gray-400 hover:text-gray-500 transition-colors">
            <span className="sr-only">View notifications</span>
            <Bell className="h-6 w-6" aria-hidden="true" />
            <span className="absolute top-1.5 right-1.5 block h-2.5 w-2.5 rounded-full bg-brand-gold ring-2 ring-white" />
          </button>
          <div className="hidden md:flex items-center gap-3 border-l border-gray-200 pl-4">
            <div className="text-right">
              <p className="text-sm font-medium text-gray-900">{user?.name}</p>
              <p className="text-xs text-gray-500">Standifer Capital</p>
            </div>
            <img
              className="h-8 w-8 rounded-full bg-gray-50"
              src={user?.photoURL}
              alt=""
            />
          </div>
        </div>
      </div>
    </header>
  );
}
