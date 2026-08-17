import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { initials } from '../../lib/format';
import { useAuth } from '../../context/AuthContext';
import type { UserRole } from '../../lib/types';

interface NavItem {
  to: string;
  label: string;
  icon: JSX.Element;
  roles: UserRole[];
  end?: boolean;
}

const icon = (path: string) => (
  <svg className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
    <path strokeLinecap="round" strokeLinejoin="round" d={path} />
  </svg>
);

const NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', roles: ['CUSTOMER'], end: true, icon: icon('M3 12l9-9 9 9M5 10v10h14V10') },
  { to: '/tickets/new', label: 'New ticket', roles: ['CUSTOMER'], icon: icon('M12 5v14M5 12h14') },
  { to: '/tickets', label: 'My tickets', roles: ['CUSTOMER'], end: true, icon: icon('M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.6a1 1 0 01.7.3l5.4 5.4a1 1 0 01.3.7V19a2 2 0 01-2 2z') },

  { to: '/agent', label: 'Dashboard', roles: ['AGENT'], end: true, icon: icon('M3 12l9-9 9 9M5 10v10h14V10') },
  { to: '/agent/queue', label: 'Ticket queue', roles: ['AGENT'], icon: icon('M4 6h16M4 12h16M4 18h16') },

  { to: '/admin', label: 'Overview', roles: ['ADMIN'], end: true, icon: icon('M3 12l9-9 9 9M5 10v10h14V10') },
  { to: '/admin/tickets', label: 'Tickets', roles: ['ADMIN'], icon: icon('M4 6h16M4 12h16M4 18h16') },
  { to: '/admin/users', label: 'Users', roles: ['ADMIN'], icon: icon('M17 20h5v-2a3 3 0 00-5.4-1.8M9 20H4v-2a3 3 0 015.4-1.8M15 7a3 3 0 11-6 0 3 3 0 016 0z') },
  { to: '/admin/categories', label: 'Categories', roles: ['ADMIN'], icon: icon('M7 7h.01M7 3h5a2 2 0 011.4.6l7 7a2 2 0 010 2.8l-5 5a2 2 0 01-2.8 0l-7-7A2 2 0 013 10V5a2 2 0 012-2z') },
  { to: '/admin/reports', label: 'Reports', roles: ['ADMIN'], icon: icon('M9 17V9m4 8V5m4 12v-6M4 21h16a1 1 0 001-1V4a1 1 0 00-1-1H4a1 1 0 00-1 1v16a1 1 0 001 1z') },
  { to: '/admin/activity', label: 'Activity', roles: ['ADMIN'], icon: icon('M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z') },

  { to: '/notifications', label: 'Notifications', roles: ['CUSTOMER', 'AGENT', 'ADMIN'], icon: icon('M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1') },
  { to: '/profile', label: 'Profile', roles: ['CUSTOMER', 'AGENT', 'ADMIN'], icon: icon('M5.1 19a7 7 0 0113.8 0M15 8a3 3 0 11-6 0 3 3 0 016 0z') },
];

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold text-white">
        SD
      </div>
      {!compact && <span className="text-base font-bold text-white">ServiceDesk AI</span>}
    </div>
  );
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Poll so the badge stays roughly current without a websocket.
  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api.get<{ count: number }>('/notifications/unread-count'),
    refetchInterval: 30_000,
    enabled: Boolean(user),
  });

  if (!user) return null;

  const items = NAV.filter((item) => item.roles.includes(user.role));
  const unreadCount = unread?.data.count ?? 0;

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
      isActive ? 'bg-mint text-ink' : 'text-slate-300 hover:bg-ink-soft hover:text-white'
    }`;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Sidebar — fixed on desktop, slide-over on mobile */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 transform bg-ink transition-transform lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 items-center justify-between px-5">
          <Link to={items[0]?.to ?? '/'} onClick={() => setMobileOpen(false)}>
            <Logo />
          </Link>
          <button
            type="button"
            className="text-slate-400 lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <nav className="space-y-1 px-3 py-4">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={navLinkClass}
              onClick={() => setMobileOpen(false)}
            >
              {item.icon}
              <span className="flex-1">{item.label}</span>
              {item.to === '/notifications' && unreadCount > 0 && (
                <span className="rounded-full bg-rose-500 px-2 py-0.5 text-xs font-bold text-white">
                  {unreadCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="absolute inset-x-0 bottom-0 border-t border-ink-soft p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-500 text-sm font-semibold text-white">
              {initials(user.fullName)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-white">{user.fullName}</p>
              <p className="truncate text-xs text-slate-400">{user.role.toLowerCase()}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="mt-3 w-full rounded-lg border border-ink-soft px-3 py-2 text-sm font-medium text-slate-300 hover:bg-ink-soft hover:text-white"
          >
            Sign out
          </button>
        </div>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-ink/40 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-4 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
          <button
            type="button"
            className="text-slate-600 lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <div className="flex-1" />

          <Link to="/notifications" className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Notifications">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1" />
            </svg>
            {unreadCount > 0 && (
              <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </Link>
        </header>

        <main className="px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
