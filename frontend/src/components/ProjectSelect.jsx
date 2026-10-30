import { useEffect, useState } from 'react';
import { listProjects } from '../api/projects.js';
import { inputClass } from './ui.jsx';

// Optional project for a meeting or action item. Chosen manually by an admin; never guessed.
// Archived projects can't be picked, but a record already in one keeps showing it.
// Pass `projects` when a page renders many selects, so the list is loaded once (null = still
// loading); leave it undefined to let the select load the list itself.
export function ProjectSelect({ value, current, onChange, disabled, id, projects: provided, ...rest }) {
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState(null);
  const projects = provided !== undefined ? provided : loaded;

  useEffect(() => {
    if (provided !== undefined) return;
    listProjects()
      .then((d) => setLoaded(d.projects))
      .catch(setError);
  }, [provided]);

  const options = projects ?? [];
  const keepCurrent = current && !options.some((p) => p.id === current.id);
  return (
    <select
      id={id}
      {...rest}
      className={inputClass}
      value={value ?? ''}
      disabled={disabled || !projects}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">{error ? 'Could not load projects' : projects ? 'No project' : 'Loading projects…'}</option>
      {keepCurrent && <option value={current.id}>{current.name}</option>}
      {options.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
