import { useEffect, useState } from 'react';
import { listProjects } from '../api/projects.js';
import { inputClass } from './ui.jsx';

// Optional project for a meeting. Chosen manually by an admin; never guessed. Archived projects
// can't be picked, but a meeting already in one keeps showing it.
export function ProjectSelect({ value, current, onChange, disabled, id, ...rest }) {
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    listProjects()
      .then((d) => setProjects(d.projects))
      .catch(setError);
  }, []);

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
