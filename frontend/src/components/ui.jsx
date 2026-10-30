// Small shared building blocks, matching the Phase 1 styles (slate palette, rounded-md).
import { cloneElement, isValidElement, useId } from 'react';

export const inputClass =
  'block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 disabled:bg-slate-50';

const BUTTON = {
  primary: 'bg-slate-900 text-white hover:bg-slate-800',
  secondary: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
  danger: 'border border-red-200 bg-white text-red-700 hover:bg-red-50',
  link: 'text-slate-700 underline-offset-2 hover:underline',
};

export function Button({ variant = 'primary', className = '', ...props }) {
  const base = variant === 'link' ? 'text-sm' : 'rounded-md px-3 py-2 text-sm font-medium';
  return <button type="button" className={`${base} ${BUTTON[variant]} disabled:opacity-60 ${className}`} {...props} />;
}

// The label names the control; hint/error are linked with aria-describedby so they don't
// become part of the control's accessible name.
export function Field({ label, error, hint, children }) {
  const baseId = useId();
  const control = isValidElement(children) ? children : null;
  const inputId = control?.props.id ?? `${baseId}-input`;
  const descId = `${baseId}-desc`;
  const message = error || hint;
  return (
    <div>
      <label htmlFor={inputId} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      <div className="mt-1">
        {control
          ? cloneElement(control, {
              id: inputId,
              'aria-describedby': message ? descId : undefined,
              'aria-invalid': error ? true : undefined,
            })
          : children}
      </div>
      {message && (
        <p id={descId} className={`mt-1 text-xs ${error ? 'text-red-600' : 'text-slate-500'}`}>
          {message}
        </p>
      )}
    </div>
  );
}

export function ErrorAlert({ error, className = '' }) {
  if (!error) return null;
  return (
    <div role="alert" className={`rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 ${className}`}>
      {typeof error === 'string' || isValidElement(error) ? error : error.message}
    </div>
  );
}

export function SuccessAlert({ children }) {
  if (!children) return null;
  return (
    <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading…' }) {
  return <div className="py-10 text-center text-sm text-slate-500">{label}</div>;
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          {actions}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

const STATUS_STYLES = {
  draft: 'bg-slate-100 text-slate-700',
  transcript_ready: 'bg-sky-100 text-sky-800',
  failed: 'bg-red-100 text-red-700',
  approved: 'bg-emerald-100 text-emerald-800',
  emails_sent: 'bg-emerald-100 text-emerald-800',
  // Project statuses (Phase 2)
  planning: 'bg-sky-100 text-sky-800',
  active: 'bg-emerald-100 text-emerald-800',
  on_hold: 'bg-amber-100 text-amber-800',
  completed: 'bg-slate-200 text-slate-800',
  archived: 'bg-slate-100 text-slate-500',
};

export function StatusBadge({ status }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? 'bg-amber-100 text-amber-800'}`}>
      {status.replaceAll('_', ' ')}
    </span>
  );
}
