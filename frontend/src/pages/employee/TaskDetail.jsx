import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { getMyTask } from '../../api/tasks.js';
import { RelatedRecords } from '../../components/RelatedRecords.jsx';
import { PRIORITY_STYLE, STATUS_LABEL, TaskStatusBadge, TaskStatusControl } from '../../components/tasks/TaskStatus.jsx';
import { Card, ErrorAlert, Loading, SuccessAlert } from '../../components/ui.jsx';
import { formatDate, formatDateTime, formatTimestamp } from '../../utils/format.js';

function historyText(e) {
  if (e.type === 'approved') return 'Task approved';
  if (e.type === 'emailed') return 'Notification email sent to you';
  return `${STATUS_LABEL[e.from] ?? e.from} → ${STATUS_LABEL[e.to] ?? e.to}${e.by ? ` by ${e.by}` : ''}`;
}

export function TaskDetail() {
  const { id } = useParams();
  const [task, setTask] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    setTask(null);
    setError(null);
    getMyTask(id)
      .then((d) => setTask(d.task))
      .catch(setError);
  }, [id]);

  async function handleUpdated(updated) {
    // Re-read so history and overdue state come from the server.
    const { task: fresh } = await getMyTask(updated.id);
    setTask(fresh);
    setNotice(`Status changed to ${STATUS_LABEL[fresh.taskStatus].toLowerCase()}.`);
  }

  const back = (
    <Link to="/my/tasks" className="text-sm text-slate-500 hover:underline">
      ← My tasks
    </Link>
  );

  if (error) {
    return (
      <div className="space-y-4">
        {back}
        <ErrorAlert error={error.status === 404 ? 'Task not found. It may not be assigned to you.' : `Could not load this task: ${error.message}`} />
      </div>
    );
  }
  if (!task) return <Loading label="Loading task…" />;

  return (
    <div className="space-y-6">
      <div>
        {back}
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="break-words text-2xl font-semibold">{task.title}</h1>
          <TaskStatusBadge status={task.taskStatus} />
        </div>
      </div>
      <SuccessAlert>{notice}</SuccessAlert>

      <Card title="Details">
        <div className="space-y-4">
          {task.description && <p className="whitespace-pre-wrap break-words text-sm text-slate-700">{task.description}</p>}
          <dl className="grid gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Due</dt>
              <dd className={`mt-1 ${task.overdue ? 'font-medium text-red-700' : 'text-slate-900'}`}>
                {task.dueDate ? `${formatDate(task.dueDate)}${task.overdue ? ' · Overdue' : ''}` : 'No due date'}
                {task.dueDateRaw && <span className="block text-xs font-normal text-slate-500">Said in the meeting: “{task.dueDateRaw}”</span>}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Priority</dt>
              <dd className="mt-1">
                <span className={`rounded-full px-2 py-0.5 text-xs capitalize ${PRIORITY_STYLE[task.priority]}`}>{task.priority}</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Meeting</dt>
              <dd className="mt-1 break-words text-slate-900">
                {task.meeting.title}
                {task.meeting.scheduledAt && <span className="block text-xs text-slate-500">{formatDateTime(task.meeting.scheduledAt)}</span>}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Project</dt>
              <dd className="mt-1 break-words text-slate-900">{task.project ? task.project.name : <span className="text-slate-500">None</span>}</dd>
            </div>
          </dl>
          <div className="border-t border-slate-100 pt-4">
            <TaskStatusControl task={task} onUpdated={handleUpdated} />
          </div>
        </div>
      </Card>

      <Card title="From the meeting">
        {task.evidence.length === 0 ? (
          <p className="text-sm text-slate-500">No transcript excerpt is attached to this task.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">Where this task came up in the meeting. It’s context, not a guarantee the task was summarised exactly right — ask your organiser if something looks off.</p>
            {task.evidence.map((e, i) => (
              <figure key={i} className="rounded-md border-l-2 border-slate-300 bg-slate-50 px-3 py-2">
                <blockquote className="break-words text-sm italic text-slate-800">“{e.excerpt}”</blockquote>
                <figcaption className="mt-1 text-xs text-slate-500">
                  {e.speaker ?? 'Unknown speaker'}
                  {e.startSec !== null && <span className="ml-2 font-mono">{formatTimestamp(e.startSec)}</span>}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </Card>

      <Card title="History">
        {task.history.length === 0 ? (
          <p className="text-sm text-slate-500">No history yet.</p>
        ) : (
          <ol className="space-y-2" aria-label="Task history">
            {task.history.map((e, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-2 text-sm">
                <span className="text-slate-800">{historyText(e)}</span>
                <span className="text-xs text-slate-500">{formatDateTime(e.at)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <RelatedRecords type="action_item" id={task.id} />
    </div>
  );
}
