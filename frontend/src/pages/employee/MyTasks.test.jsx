import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as authApi from '../../api/auth.js';
import * as tasksApi from '../../api/tasks.js';
import { AuthProvider } from '../../auth/AuthContext.jsx';
import { ProtectedRoute } from '../../auth/ProtectedRoute.jsx';
import { MyTasks } from './MyTasks.jsx';
import { TaskDetail } from './TaskDetail.jsx';

vi.mock('../../api/tasks.js');
vi.mock('../../api/auth.js');

const employee = { id: 5, email: 'ana@example.test', fullName: 'Ana Garcia', role: 'employee', isActive: true };

const task = (o = {}) => ({
  id: 1,
  title: 'Send the deck',
  description: 'Final version to sales.',
  priority: 'medium',
  taskStatus: 'todo',
  dueDate: '2026-11-06',
  dueDateRaw: 'by Friday',
  overdue: false,
  allowedStatuses: ['in_progress', 'blocked', 'done'],
  meeting: { id: 9, title: 'Launch sync', scheduledAt: '2026-11-04T10:00:00Z' },
  ...o,
});
const TASKS = [
  task(),
  task({ id: 2, title: 'Book the venue', project: { id: 3, name: 'Launch' }, priority: 'high', dueDate: '2026-11-20', taskStatus: 'in_progress', allowedStatuses: ['todo', 'blocked', 'done'], meeting: { id: 10, title: 'Ops weekly', scheduledAt: '2026-11-05T10:00:00Z' } }),
  task({ id: 3, title: 'Write notes', priority: 'low', dueDate: '2026-10-01', overdue: true, meeting: { id: 9, title: 'Launch sync', scheduledAt: '2026-11-04T10:00:00Z' } }),
  task({ id: 4, title: 'Old thing', taskStatus: 'done', dueDate: null, allowedStatuses: ['in_progress', 'todo'] }),
];
const listResponse = (tasks = TASKS) => ({
  tasks,
  summary: { total: tasks.length, todo: 2, inProgress: 1, blocked: 0, done: 1, overdue: 1 },
  today: '2026-10-23',
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

function renderAt(path) {
  authApi.me.mockResolvedValue({ user: employee });
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {/* Same guard as the app's router: pages render only once the session is known. */}
          <Route element={<ProtectedRoute roles={['employee']} />}>
            <Route path="/my/tasks" element={<MyTasks />} />
            <Route path="/my/tasks/:id" element={<TaskDetail />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
  return userEvent.setup();
}
const titles = () => screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('employee dashboard', () => {
  it('shows a loading state, then summary cards and open tasks', async () => {
    const pending = deferred();
    tasksApi.listMyTasks.mockReturnValue(pending.promise);
    renderAt('/my/tasks');
    expect(await screen.findByText('Loading your tasks…')).toBeTruthy();
    await act(async () => pending.resolve(listResponse()));

    const total = screen.getByText('Total').closest('div');
    expect(within(total).getByText('4')).toBeTruthy();
    expect(within(screen.getByText('Overdue', { selector: 'dt' }).closest('div')).getByText('1')).toBeTruthy();
    // Default filter: open tasks, sorted by due date (soonest first).
    expect(titles()).toEqual(['Write notes', 'Send the deck', 'Book the venue']);
    const late = screen.getByRole('article', { name: 'Write notes' });
    expect(within(late).getByText(/Overdue/)).toBeTruthy();
    expect(within(late).getByText('From “Launch sync”')).toBeTruthy();
    expect(within(screen.getByRole('article', { name: 'Book the venue' })).getByText('From “Ops weekly” · Project: Launch')).toBeTruthy();
  });

  it('shows empty and error states', async () => {
    tasksApi.listMyTasks.mockResolvedValue(listResponse([]));
    renderAt('/my/tasks');
    expect(await screen.findByText('No tasks assigned')).toBeTruthy();
    cleanup();

    tasksApi.listMyTasks.mockRejectedValue(new Error('Cannot reach the server. Is the backend running?'));
    renderAt('/my/tasks');
    expect(await screen.findByText(/Could not load your tasks: Cannot reach the server/)).toBeTruthy();
  });

  it('filters by status, priority, overdue and search, and sorts', async () => {
    tasksApi.listMyTasks.mockResolvedValue(listResponse());
    const user = renderAt('/my/tasks');
    await screen.findAllByRole('article');

    await user.selectOptions(screen.getByLabelText('Status'), 'all');
    expect(titles()).toHaveLength(4);
    await user.selectOptions(screen.getByLabelText('Status'), 'done');
    expect(titles()).toEqual(['Old thing']);
    await user.selectOptions(screen.getByLabelText('Status'), 'open');

    await user.selectOptions(screen.getByLabelText('Priority'), 'high');
    expect(titles()).toEqual(['Book the venue']);
    await user.selectOptions(screen.getByLabelText('Priority'), '');

    await user.click(screen.getByLabelText('Overdue only'));
    expect(titles()).toEqual(['Write notes']);
    await user.click(screen.getByLabelText('Overdue only'));

    await user.type(screen.getByLabelText('Search'), 'ops weekly');
    expect(titles()).toEqual(['Book the venue']);
    await user.clear(screen.getByLabelText('Search'));
    await user.type(screen.getByLabelText('Search'), 'nothing like this');
    expect(screen.getByText('No tasks match these filters.')).toBeTruthy();
    await user.clear(screen.getByLabelText('Search'));

    await user.selectOptions(screen.getByLabelText('Sort by'), 'priority');
    expect(titles()).toEqual(['Book the venue', 'Send the deck', 'Write notes']);
  });

  it('updates a status once, then reloads from the server', async () => {
    tasksApi.listMyTasks.mockResolvedValueOnce(listResponse()).mockResolvedValue(listResponse([task({ taskStatus: 'in_progress', allowedStatuses: ['todo', 'blocked', 'done'] }), ...TASKS.slice(1)]));
    const pending = deferred();
    tasksApi.updateMyTaskStatus.mockReturnValue(pending.promise);
    const user = renderAt('/my/tasks');
    const card = await screen.findByRole('article', { name: 'Send the deck' });

    await user.click(within(card).getByRole('button', { name: 'Start' }));
    await user.click(within(card).getByRole('button', { name: 'Start' }));
    expect(tasksApi.updateMyTaskStatus).toHaveBeenCalledTimes(1);
    expect(tasksApi.updateMyTaskStatus).toHaveBeenCalledWith(1, 'in_progress', 'todo');
    expect(within(card).getByText('Not started')).toBeTruthy(); // not optimistic

    await act(async () => pending.resolve({ task: task({ taskStatus: 'in_progress' }) }));
    expect(await screen.findByText('“Send the deck” is now in progress.')).toBeTruthy();
    expect(within(screen.getByRole('article', { name: 'Send the deck' })).getByText('In progress')).toBeTruthy();
    expect(tasksApi.listMyTasks).toHaveBeenCalledTimes(2);
  });

  it('shows a conflict when the task changed elsewhere', async () => {
    tasksApi.listMyTasks.mockResolvedValue(listResponse());
    tasksApi.updateMyTaskStatus.mockRejectedValue(Object.assign(new Error('This task was updated elsewhere. Refresh to see its current status.'), { status: 409, code: 'STALE_STATUS' }));
    const user = renderAt('/my/tasks');
    const card = await screen.findByRole('article', { name: 'Send the deck' });
    await user.click(within(card).getByRole('button', { name: 'Mark complete' }));
    expect(await within(card).findByText(/updated elsewhere/)).toBeTruthy();
  });
});

describe('task detail', () => {
  it('shows details, evidence with a caveat, history, and updates status', async () => {
    tasksApi.getMyTask
      .mockResolvedValueOnce({ task: { ...task(), evidence: [{ excerpt: "I'll send the deck by Friday", speaker: 'Ana', startSec: 20 }], history: [{ type: 'approved', at: '2026-11-04T12:00:00Z' }, { type: 'emailed', at: '2026-11-04T12:05:00Z' }] } })
      .mockResolvedValue({ task: { ...task({ taskStatus: 'done', allowedStatuses: ['in_progress', 'todo'] }), evidence: [], history: [{ type: 'status_changed', from: 'todo', to: 'done', by: 'Ana Garcia', at: '2026-11-05T09:00:00Z' }] } });
    tasksApi.updateMyTaskStatus.mockResolvedValue({ task: task({ taskStatus: 'done' }) });
    const user = renderAt('/my/tasks/1');

    expect(await screen.findByRole('heading', { name: 'Send the deck' })).toBeTruthy();
    expect(screen.getByText('Said in the meeting: “by Friday”')).toBeTruthy();
    expect(screen.getByText('Launch sync')).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy(); // no project
    expect(screen.getByText('“I\'ll send the deck by Friday”')).toBeTruthy();
    expect(screen.getByText(/not a guarantee/)).toBeTruthy();
    expect(screen.getByText('Notification email sent to you')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Mark complete' }));
    expect(await screen.findByText('Status changed to completed.')).toBeTruthy();
    expect(screen.getByText('Not started → Completed by Ana Garcia')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeTruthy();
  });

  it('shows a not-found message for tasks that are not yours', async () => {
    tasksApi.getMyTask.mockRejectedValue(Object.assign(new Error('Task not found'), { status: 404 }));
    renderAt('/my/tasks/99');
    expect(await screen.findByText('Task not found. It may not be assigned to you.')).toBeTruthy();
  });
});

describe('navigation', () => {
  it('sends an employee who opens an admin URL back to their tasks', async () => {
    authApi.me.mockResolvedValue({ user: employee });
    tasksApi.listMyTasks.mockResolvedValue(listResponse([]));
    const router = createMemoryRouter(
      [
        {
          element: <ProtectedRoute />,
          children: [
            { element: <ProtectedRoute roles={['admin']} />, children: [{ path: '/admin/meetings/:id', element: <p>Admin review page</p> }] },
            { element: <ProtectedRoute roles={['employee']} />, children: [{ path: '/my/tasks', element: <MyTasks /> }] },
          ],
        },
        { path: '/login', element: <p>Login page</p> },
      ],
      { initialEntries: ['/admin/meetings/2'] },
    );
    render(
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'My tasks' })).toBeTruthy();
    expect(screen.queryByText('Admin review page')).toBeNull();
    expect(router.state.location.pathname).toBe('/my/tasks');
  });

  it('sends a signed-out visitor to the login page', async () => {
    authApi.me.mockRejectedValue(Object.assign(new Error('Authentication required'), { status: 401 }));
    const router = createMemoryRouter(
      [
        { element: <ProtectedRoute roles={['employee']} />, children: [{ path: '/my/tasks', element: <MyTasks /> }] },
        { path: '/login', element: <p>Login page</p> },
      ],
      { initialEntries: ['/my/tasks'] },
    );
    render(
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>,
    );
    expect(await screen.findByText('Login page')).toBeTruthy();
    expect(tasksApi.listMyTasks).not.toHaveBeenCalled();
  });
});
