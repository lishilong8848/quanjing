import type { EmergencyDutyPersonOption } from '@shared/emergency-duty.interface';

export interface EmergencyDutyOptionListProps {
  options: ReadonlyArray<EmergencyDutyPersonOption>;
  selectedKeys: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (key: string) => void;
}

export function EmergencyDutyOptionList({
  options,
  selectedKeys,
  disabled,
  onToggle,
}: EmergencyDutyOptionListProps) {
  return (
    <div className="grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
      {options.map((person) => {
        const selected = selectedKeys.has(person.key);
        return (
          <button
            key={person.key}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => onToggle(person.key)}
            style={{ contentVisibility: 'auto', containIntrinsicSize: '44px' }}
            className={`flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-70 ${
              selected
                ? 'border-blue-300 bg-blue-50 text-blue-800'
                : 'border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:bg-slate-50'
            }`}
          >
            <span
              aria-hidden="true"
              className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border text-xs font-bold ${
                selected
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-slate-300 bg-white text-transparent'
              }`}
            >
              ✓
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">
                {person.name}
              </span>
              <span className="block truncate text-xs text-slate-500">
                {person.role || '角色未维护'}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
