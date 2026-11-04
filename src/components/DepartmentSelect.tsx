import { Building2 } from 'lucide-react';
import type { Department } from '../types';

interface Props {
  value: string | null;
  onChange: (departmentId: string | null) => void;
  departments: Department[];
  disabled?: boolean;
  /** The label of the empty choice. */
  noneLabel?: string;
  className?: string;
  'aria-label'?: string;
}

/**
 * Picks the department a ticket is routed to. A plain select, deliberately: a
 * department is one choice (unlike assignees, which are many), and the list is
 * short enough that type-to-filter would be clutter.
 *
 * A department the ticket points at that no longer exists is still offered as
 * "Unknown department" so the control reflects what is stored rather than
 * silently showing "None" and then writing null on the first unrelated change.
 */
export function DepartmentSelect({
  value, onChange, departments, disabled, noneLabel = 'No department', className = '', ...rest
}: Props) {
  const current = value || '';
  const unknown = !!value && !departments.some((d) => d.id === value);
  return (
    <div className={`relative ${className}`}>
      <Building2 className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" aria-hidden="true" />
      <select
        value={current}
        disabled={disabled}
        aria-label={rest['aria-label'] ?? 'Department'}
        onChange={(e) => onChange(e.target.value || null)}
        onClick={(e) => e.stopPropagation()}
        className="block w-full pl-8 pr-8 py-1.5 text-sm border-gray-300 focus:outline-none focus:ring-brand-dark focus:border-brand-dark rounded-md border bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <option value="">{noneLabel}</option>
        {unknown && <option value={current}>Unknown department</option>}
        {departments.map((d) => (
          <option key={d.id} value={d.id}>{d.name}</option>
        ))}
      </select>
    </div>
  );
}
