import { Link, Navigate, createBrowserRouter } from 'react-router';
import { homePathFor, useAuth } from './auth/AuthContext.jsx';
import { ProtectedRoute } from './auth/ProtectedRoute.jsx';
import { AppShell } from './components/AppShell.jsx';
import { AcceptInvitationPage } from './pages/AcceptInvitation.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { AdminDashboard } from './pages/admin/Dashboard.jsx';
import { MeetingDetailPage } from './pages/admin/MeetingDetail.jsx';
import { MeetingNewPage } from './pages/admin/MeetingNew.jsx';
import { MeetingsPage } from './pages/admin/Meetings.jsx';
import { UsersPage } from './pages/admin/Users.jsx';
import { MyTasks } from './pages/employee/MyTasks.jsx';
import { TaskDetail } from './pages/employee/TaskDetail.jsx';
import { ProjectDetailPage } from './pages/projects/ProjectDetail.jsx';
import { ProjectsPage } from './pages/projects/Projects.jsx';
import { TeamsPage } from './pages/teams/Teams.jsx';

function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={homePathFor(user)} replace />;
}

function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3">
      <p className="text-slate-600">Page not found.</p>
      <Link to="/" className="text-sm font-medium text-slate-900 underline">
        Go home
      </Link>
    </div>
  );
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  // Public: the invitation link from the email (token in the URL fragment).
  { path: '/accept-invitation', element: <AcceptInvitationPage /> },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <HomeRedirect /> },
          {
            element: <ProtectedRoute roles={['admin']} />,
            children: [
              { path: '/admin', element: <AdminDashboard /> },
              { path: '/admin/meetings', element: <MeetingsPage /> },
              { path: '/admin/meetings/new', element: <MeetingNewPage /> },
              { path: '/admin/meetings/:id', element: <MeetingDetailPage /> },
              { path: '/admin/users', element: <UsersPage /> },
            ],
          },
          {
            element: <ProtectedRoute roles={['employee', 'manager']} />,
            children: [
              { path: '/my/tasks', element: <MyTasks /> },
              { path: '/my/tasks/:id', element: <TaskDetail /> },
            ],
          },
          // Every role; the API decides which projects and teams each person can see or change.
          { path: '/projects', element: <ProjectsPage /> },
          { path: '/projects/:id', element: <ProjectDetailPage /> },
          { path: '/teams', element: <TeamsPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
