import { NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';

const NAV = {
  admin: [
    { to: '/admin', label: 'Dashboard', end: true },
    { to: '/admin/meetings', label: 'Meetings' },
    { to: '/projects', label: 'Projects' },
    { to: '/teams', label: 'Teams' },
    { to: '/admin/users', label: 'Users' },
    { to: '/admin/integrations', label: 'Integrations' },
  ],
  manager: [
    { to: '/projects', label: 'Projects' },
    { to: '/teams', label: 'Teams' },
    { to: '/my/tasks', label: 'My tasks' },
  ],
  employee: [
    { to: '/my/tasks', label: 'My tasks' },
    { to: '/projects', label: 'Projects' },
  ],
};

export function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-6">
            <span className="font-semibold text-slate-900">Meeting to Action</span>
            <nav className="flex gap-1">
              {(NAV[user.role] ?? NAV.employee).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-slate-100 font-medium text-slate-900' : 'text-slate-600 hover:text-slate-900'}`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="hidden text-slate-600 sm:inline">
              {user.fullName} · <span className="capitalize">{user.role}</span>
            </span>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50"
            >
              Log out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
