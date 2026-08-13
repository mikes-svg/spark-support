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
            aria-label="Open sidebar"
            className="md:hidden flex items-center justify-center min-h-[44px] min-w-[44px] p-2 -ml-2 mr-2 text-gray-500 hover:text-gray-700">
            <Menu className="h-6 w-6" aria-hidden="true" />
          </button>
          <h1 className="text-xl font-serif font-semibold text-gray-900">
            {title}
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            aria-label="View notifications"
            className="relative flex items-center justify-center min-h-[44px] min-w-[44px] p-2 text-gray-500 hover:text-gray-700 transition-colors">
            <Bell className="h-6 w-6" aria-hidden="true" />
            <span className="absolute top-2 right-2 block h-2.5 w-2.5 rounded-full bg-brand-gold ring-2 ring-white" />
          </button>
          <div className="hidden md:flex items-center gap-3 border-l border-gray-200 pl-4">
            <p className="text-sm font-medium text-gray-900">{user?.name}</p>
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
