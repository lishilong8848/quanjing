import { useEffect, useId, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import type { PurchaseApplicationApplicant } from '@shared/purchase-application.interface';

export type StocktakePeopleSearch = (
  query: string,
) => Promise<PurchaseApplicationApplicant[]>;
export function StocktakeEmployeePicker({
  value,
  onChange,
  search,
  disabled,
  label,
}: {
  value: PurchaseApplicationApplicant | null;
  onChange: (person: PurchaseApplicationApplicant | null) => void;
  search: StocktakePeopleSearch;
  disabled: boolean;
  label: string;
}) {
  const [query, setQuery] = useState(value?.name || '');
  const [results, setResults] = useState<PurchaseApplicationApplicant[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0),
    id = useId();
  useEffect(() => {
    if (value) {
      setQuery(value.name);
      setOpen(false);
    }
  }, [value]);
  useEffect(() => {
    const current = ++sequence.current;
    if (!open || value || !query.trim()) {
      setState('idle');
      return;
    }
    setState('loading');
    setResults([]);
    const timer = window.setTimeout(() => {
      search(query.trim())
        .then((people) => {
          if (sequence.current === current) {
            setResults(people);
            setState('ready');
          }
        })
        .catch(() => {
          if (sequence.current === current) setState('error');
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      if (sequence.current === current) sequence.current++;
    };
  }, [query, open, value, search, retry]);
  return (
    <div
      className="stocktake-person"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      <Input
        aria-label={label}
        role="combobox"
        aria-expanded={open && !value && Boolean(query.trim())}
        aria-controls={id}
        aria-autocomplete="list"
        value={query}
        disabled={disabled}
        placeholder="姓名 / 工号"
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
        onChange={(event) => {
          sequence.current++;
          setQuery(event.target.value);
          setOpen(true);
          onChange(null);
        }}
      />
      {open && !value && query.trim() && (
        <div
          id={id}
          className="stocktake-person-results"
          role="listbox"
          aria-label="在职员工"
        >
          {state === 'loading' && <p role="status">查找中…</p>}
          {state === 'error' && (
            <button type="button" onClick={() => setRetry((n) => n + 1)}>
              搜索失败，重试
            </button>
          )}
          {state === 'ready' &&
            (results.length ? (
              results.map((person) => (
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  key={`${person.recordId}:${person.openId}`}
                  onClick={() => {
                    sequence.current++;
                    onChange(person);
                    setQuery(person.name);
                    setOpen(false);
                  }}
                >
                  <span>{person.name}</span>
                  <small>
                    {[person.employeeNo, person.building, person.position]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </button>
              ))
            ) : (
              <p>无匹配在职员工</p>
            ))}
        </div>
      )}
    </div>
  );
}
