import React, { lazy } from 'react';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
} from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { isAdminRole, isSuperadminRole } from './types';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';

// Heavier / less-frequently-hit pages are code-split so regular users don't
// download the admin, team, analytics, and detail bundles up front. The
// Layout wraps <Outlet> in <Suspense>, so these resolve inside the content area.
const SubmitRequestPage = lazy(() => import('./pages/SubmitRequestPage').then((m) => ({ default: m.SubmitRequestPage })));
const TicketDetailPage = lazy(() => import('./pages/TicketDetailPage').then((m) => ({ default: m.TicketDetailPage })));
const AdminDashboardPage = lazy(() => import('./pages/AdminDashboardPage').then((m) => ({ default: m.AdminDashboardPage })));
const AdminSettingsPage = lazy(() => import('./pages/AdminSettingsPage').then((m) => ({ default: m.AdminSettingsPage })));
const TeamPage = lazy(() => import('./pages/TeamPage').then((m) => ({ default: m.TeamPage })));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage').then((m) => ({ default: m.AnalyticsPage })));

function ProtectedRoute({
  children,
  requireAdmin = false,
  requireSuperadmin = false,
}: {
  children: React.ReactNode;
  requireAdmin?: boolean;
  requireSuperadmin?: boolean;
}) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-brand-cream flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-dark" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (requireSuperadmin && !isSuperadminRole(user.role)) {
    return <Navigate to="/" replace />;
  }
  if (requireAdmin && !isAdminRole(user.role)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <AuthProvider>
      <Router>
        <Routes>
          <Route path="/login" element={<LoginPage />} />

          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="submit" element={<SubmitRequestPage />} />
            <Route path="tickets/:id" element={<TicketDetailPage />} />

            <Route
              path="admin"
              element={
                <ProtectedRoute requireAdmin>
                  <AdminDashboardPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="admin/team"
              element={
                <ProtectedRoute requireSuperadmin>
                  <TeamPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="admin/settings"
              element={
                <ProtectedRoute requireSuperadmin>
                  <AdminSettingsPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="admin/analytics"
              element={
                <ProtectedRoute requireSuperadmin>
                  <AnalyticsPage />
                </ProtectedRoute>
              }
            />
          </Route>
        </Routes>
      </Router>
    </AuthProvider>
  );
}
