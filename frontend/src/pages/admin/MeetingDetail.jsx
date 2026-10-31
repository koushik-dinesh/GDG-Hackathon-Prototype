import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { getMeeting, getTranscript, updateMeeting } from '../../api/meetings.js';
import { MeetingBotPanel } from '../../components/MeetingBotPanel.jsx';
import { MeetingForm } from '../../components/MeetingForm.jsx';
import { RelatedRecords } from '../../components/RelatedRecords.jsx';
import { TranscriptUpload } from '../../components/TranscriptUpload.jsx';
import { TranscriptViewer } from '../../components/TranscriptViewer.jsx';
import { Button, Card, ErrorAlert, Loading, StatusBadge, SuccessAlert } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';
import { MeetingEmails } from './MeetingEmails.jsx';
import { ReviewActionItems } from './ReviewActionItems.jsx';

// Must match REPLACEABLE_STATUSES in the backend transcriptsController.
const UPLOADABLE = ['draft', 'ended', 'transcript_ready', 'failed'];
const POLL_MS = 3000;

export function MeetingDetailPage() {
  const { id } = useParams();
  const [meeting, setMeeting] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState('');

  const [segments, setSegments] = useState(null);
  const [transcriptError, setTranscriptError] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [highlight, setHighlight] = useState(null); // { segmentId, nonce } from evidence links
  const [pollError, setPollError] = useState(null);

  const loadTranscript = useCallback(() => {
    setSegments(null);
    setTranscriptError(null);
    getTranscript(id)
      .then((d) => setSegments(d.segments))
      .catch(setTranscriptError);
  }, [id]);

  useEffect(() => {
    setMeeting(null);
    setError(null);
    getMeeting(id)
      .then(({ meeting: m }) => setMeeting(m))
      .catch(setError);
  }, [id]);

  // (Re)load segments whenever the meeting gets a new transcript: upload, bot import or replace.
  const transcriptKey = meeting?.transcript ? `${meeting.transcript.id}:${meeting.transcript.fetchedAt}` : null;
  useEffect(() => {
    if (transcriptKey) loadTranscript();
  }, [transcriptKey, loadTranscript]);

  const refreshMeeting = useCallback(async () => {
    const { meeting: m } = await getMeeting(id);
    setMeeting(m);
    return m;
  }, [id]);

  // While extraction is queued/running, poll the meeting (the backend is the source of truth).
  // Stops when the status changes, on unmount, or on an auth/not-found error.
  const extracting = meeting?.status === 'extracting';
  useEffect(() => {
    if (!extracting) return undefined;
    let cancelled = false;
    let timer;
    const tick = async () => {
      try {
        await refreshMeeting();
        if (!cancelled) setPollError(null);
      } catch (err) {
        if (cancelled) return;
        setPollError(err);
        if ([401, 403, 404].includes(err.status)) return;
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [extracting, refreshMeeting]);

  if (error) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorAlert error={error.status === 404 ? 'Meeting not found.' : `Could not load meeting: ${error.message}`} />
      </div>
    );
  }
  if (!meeting) return <Loading />;

  async function save(values) {
    const { meeting: updated } = await updateMeeting(id, values);
    setMeeting(updated);
    setEditing(false);
    setNotice('Meeting saved.');
  }

  async function handleUploaded() {
    const { meeting: updated } = await getMeeting(id);
    setMeeting(updated);
    setShowUpload(false);
    setNotice(`Transcript saved: ${updated.transcript.segmentCount} segments.`);
  }

  const canUpload = UPLOADABLE.includes(meeting.status);

  return (
    <div className="space-y-6">
      <div>
        <BackLink />
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{meeting.title}</h1>
          <StatusBadge status={meeting.status} />
        </div>
      </div>
      <SuccessAlert>{notice}</SuccessAlert>

      <Card
        title="Details"
        actions={
          !editing && (
            <Button variant="secondary" onClick={() => { setNotice(''); setEditing(true); }}>
              Edit
            </Button>
          )
        }
      >
        {editing ? (
          <MeetingForm initial={meeting} submitLabel="Save changes" onSubmit={save} onCancel={() => setEditing(false)} />
        ) : (
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <Detail label="Meeting link">
              <a href={meeting.meetingUrl} target="_blank" rel="noopener noreferrer" className="break-all text-slate-900 underline">
                {meeting.meetingUrl}
              </a>
            </Detail>
            <Detail label="Scheduled for">{formatDateTime(meeting.scheduledAt)}</Detail>
            <Detail label="Language">{meeting.languageHint ?? 'Auto-detect'}</Detail>
            <Detail label="Project">
              {meeting.project ? (
                <Link to={`/projects/${meeting.project.id}`} className="text-slate-900 underline">
                  {meeting.project.name}
                </Link>
              ) : (
                <span className="text-slate-500">None</span>
              )}
            </Detail>
            <Detail label="Created">{formatDateTime(meeting.createdAt)}</Detail>
            <Detail label="Participants" wide>
              {meeting.participants.length === 0 ? (
                <span className="text-slate-500">None selected</span>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {meeting.participants.map((p) => (
                    <li key={p.id} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                      {p.fullName}
                      {!p.isActive && ' (inactive)'}
                    </li>
                  ))}
                </ul>
              )}
            </Detail>
          </dl>
        )}
      </Card>

      <Card title="Meeting bot">
        <MeetingBotPanel meetingId={meeting.id} onMeetingChanged={refreshMeeting} />
      </Card>

      <div className="space-y-6 xl:grid xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] xl:items-start xl:gap-6 xl:space-y-0">
      <Card
        className="xl:sticky xl:top-4"
        title="Transcript"
        actions={
          meeting.transcript &&
          canUpload &&
          !showUpload && (
            <Button variant="secondary" onClick={() => { setNotice(''); setShowUpload(true); }}>
              Replace
            </Button>
          )
        }
      >
        {meeting.transcript && (
          <p className="mb-4 text-xs text-slate-500">
            {meeting.transcript.segmentCount} segments · {meeting.transcript.source === 'vexa' ? 'from the meeting bot' : meeting.transcript.format}
            {meeting.transcript.filename && ` · ${meeting.transcript.filename}`}
            {meeting.transcript.detectedLanguages.length > 0 && ` · ${meeting.transcript.detectedLanguages.join(', ')}`}
            {' · saved '}
            {formatDateTime(meeting.transcript.fetchedAt)}
          </p>
        )}

        {(!meeting.transcript || showUpload) &&
          (canUpload ? (
            <div className="space-y-3">
              <TranscriptUpload meetingId={meeting.id} hasTranscript={Boolean(meeting.transcript)} onUploaded={handleUploaded} />
              {showUpload && (
                <Button variant="link" onClick={() => setShowUpload(false)}>
                  Cancel
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              Transcripts can't be uploaded while the meeting is {meeting.status.replaceAll('_', ' ')}.
            </p>
          ))}

        {meeting.transcript && !showUpload && (
          <>
            {transcriptError && <ErrorAlert error={`Could not load transcript: ${transcriptError.message}`} />}
            {!segments && !transcriptError && <Loading label="Loading transcript…" />}
            {segments && <TranscriptViewer segments={segments} highlight={highlight} />}
          </>
        )}
      </Card>

      <Card title="Action items">
        {pollError && <ErrorAlert className="mb-3" error={`Lost contact with the server while checking progress: ${pollError.message}`} />}
        <ReviewActionItems
          meeting={meeting}
          onMeetingChanged={refreshMeeting}
          onShowEvidence={(segmentId) => setHighlight({ segmentId, nonce: Date.now() })}
        />
      </Card>
      </div>

      {['approved', 'emails_sent'].includes(meeting.status) && (
        <Card title="Email notifications">
          <MeetingEmails meeting={meeting} onMeetingChanged={refreshMeeting} />
        </Card>
      )}

      <RelatedRecords type="meeting" id={meeting.id} />
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/admin/meetings" className="text-sm text-slate-500 hover:underline">
      ← Meetings
    </Link>
  );
}

function Detail({ label, wide, children }) {
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-1 text-slate-900">{children}</dd>
    </div>
  );
}
