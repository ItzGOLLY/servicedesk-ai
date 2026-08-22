import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth, homePathFor } from './context/AuthContext';
import AppShell from './components/layout/AppShell';
import { LoadingBlock } from './components/ui';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Register from './pages/Register';
import CustomerDashboard from './pages/customer/CustomerDashboard';
import CreateTicket from './pages/customer/CreateTicket';
import TicketList from './pages/TicketList';
import TicketDetail from './pages/TicketDetail';
import AgentDashboard from './pages/agent/AgentDashboard';
import AdminDashboard from './pages/admin/AdminDashboard';
import UserManagement from './pages/admin/UserManagement';
import CategoryManagement from './pages/admin/CategoryManagement';
import Reports from './pages/admin/Reports';
import ActivityLog from './pages/admin/ActivityLog';
import WhatsAppConsole from './pages/admin/WhatsAppConsole';
import Notifications from './pages/Notifications';
import Profile from './pages/Profile';
import type { UserRole } from './lib/types';

/**
 * Route guarding.
 *
 * This is convenience, not security. The API independently rejects any request
 * the role is not entitled to make, so bypassing this guard in the browser
 * gains nothing.
 */
function Protected({ roles }: { roles?: UserRole[] }) {
  const { user, loading } = useAuth();

  if (loading) return <LoadingBlock label="Restoring your session…" />;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homePathFor(user.role)} replace />;

  return <AppShell />;
}

/** Sends an already-signed-in visitor to their own home instead of the landing page. */
function PublicOnly({ children }: { children: JSX.Element }) {
  const { user, loading } = useAuth();

  if (loading) return <LoadingBlock />;
  if (user) return <Navigate to={homePathFor(user.role)} replace />;

  return children;
}

function NotFound() {
  const { user } = useAuth();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-bold uppercase tracking-wide text-brand-600">404</p>
      <h1 className="mt-2 text-2xl font-bold text-ink">Page not found</h1>
      <p className="mt-2 max-w-sm text-sm text-slate-500">
        The page you are looking for does not exist or you do not have access to it.
      </p>
      <a href={user ? homePathFor(user.role) : '/'} className="btn-primary mt-6">
        Go back
      </a>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Public */}
        <Route
          path="/"
          element={
            <PublicOnly>
              <Landing />
            </PublicOnly>
          }
        />
        <Route
          path="/login"
          element={
            <PublicOnly>
              <Login />
            </PublicOnly>
          }
        />
        <Route
          path="/register"
          element={
            <PublicOnly>
              <Register />
            </PublicOnly>
          }
        />

        {/* Customer */}
        <Route element={<Protected roles={['CUSTOMER']} />}>
          <Route path="/dashboard" element={<CustomerDashboard />} />
          <Route path="/tickets/new" element={<CreateTicket />} />
          <Route
            path="/tickets"
            element={
              <TicketList
                title="My tickets"
                subtitle="Every request you have raised, and where it stands."
                variant="customer"
              />
            }
          />
        </Route>

        {/* Agent */}
        <Route element={<Protected roles={['AGENT']} />}>
          <Route path="/agent" element={<AgentDashboard />} />
          <Route
            path="/agent/queue"
            element={
              <TicketList
                title="Ticket queue"
                subtitle="Every ticket across all customers, filterable and searchable."
                variant="staff"
              />
            }
          />
        </Route>

        {/* Admin */}
        <Route element={<Protected roles={['ADMIN']} />}>
          <Route path="/admin" element={<AdminDashboard />} />
          <Route
            path="/admin/tickets"
            element={
              <TicketList
                title="All tickets"
                subtitle="Every ticket in the system."
                variant="staff"
              />
            }
          />
          <Route path="/admin/users" element={<UserManagement />} />
          <Route path="/admin/categories" element={<CategoryManagement />} />
          <Route path="/admin/whatsapp" element={<WhatsAppConsole />} />
          <Route path="/admin/reports" element={<Reports />} />
          <Route path="/admin/activity" element={<ActivityLog />} />
        </Route>

        {/* Shared, for every signed-in role */}
        <Route element={<Protected />}>
          <Route path="/tickets/:id" element={<TicketDetail />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/profile" element={<Profile />} />
        </Route>

        <Route path="*" element={<NotFound />} />
      </Routes>
    </AuthProvider>
  );
}
