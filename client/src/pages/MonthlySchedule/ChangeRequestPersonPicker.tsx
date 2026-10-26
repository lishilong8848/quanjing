import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeRequestPeopleResponse,
  ChangeRequestPerson,
} from '@shared/change-request';
import { getChangeRequestPeople } from '@/api/change-request-people';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  normalizeChangeRequestPeopleQuery,
  searchChangeRequestPeople,
} from './change-request-people';

const cache = new Map<
  string,
  { response: ChangeRequestPeopleResponse; fetchedAt: number }
>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export function ChangeRequestPersonPicker({
  value,
  name,
  disabled,
  error,
  inputRef,
  onChange,
}: {
  value?: string;
  name: string;
  disabled?: boolean;
  error?: string;
  inputRef: (element: HTMLElement | null) => void;
  onChange: (name: string, id?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [people, setPeople] = useState<ChangeRequestPerson[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [retry, setRetry] = useState(0);
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement | null>(null);
  const query = normalizeChangeRequestPeopleQuery(name);
  const matches = useMemo(
    () => searchChangeRequestPeople(people, name),
    [people, name],
  );

  useEffect(() => {
    setActive(-1);
    if (!expanded || !query || value) {
      setStatus('idle');
      setPeople([]);
      return;
    }
    const cached = cache.get(query);
    setPeople(cached?.response.people || []);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && !retry) {
      setStatus('ready');
      return;
    }
    setStatus('loading');
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        void getChangeRequestPeople(query, controller.signal)
          .then((response) => {
            if (controller.signal.aborted) return;
            if (!Array.isArray(response.people))
              throw new Error('人员数据格式无效');
            if (cache.size >= 100) cache.delete(cache.keys().next().value!);
            cache.set(query, { response, fetchedAt: Date.now() });
            setPeople(response.people);
            setStatus('ready');
          })
          .catch(() => {
            if (!controller.signal.aborted) setStatus('error');
          });
      },
      cached ? 0 : 120,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [expanded, query, value, retry]);

  const select = (person: ChangeRequestPerson) => {
    onChange(person.name, person.id);
    setExpanded(false);
    input.current?.focus();
  };

  return (
    <div
      className="relative space-y-2"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setExpanded(false);
      }}
    >
      <Input
        ref={(element) => {
          input.current = element;
          inputRef(element);
        }}
        id="change-request-submitter"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded && !value}
        aria-controls="change-request-person-results"
        aria-activedescendant={
          expanded && active >= 0 ? `change-person-${active}` : undefined
        }
        aria-invalid={Boolean(error)}
        aria-describedby="change-request-submitter-error change-request-person-status"
        value={name}
        placeholder="输入姓名快速匹配"
        autoComplete="off"
        maxLength={64}
        disabled={disabled}
        onFocus={() => setExpanded(true)}
        onChange={(event) => {
          onChange(event.target.value);
          setExpanded(true);
          setRetry(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setExpanded(false);
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setExpanded(true);
            if (matches.length)
              setActive(
                (current) =>
                  (current +
                    (event.key === 'ArrowDown' ? 1 : -1) +
                    matches.length) %
                  matches.length,
              );
          }
          if (event.key === 'Enter' && expanded) {
            event.preventDefault();
            if (matches[active]) select(matches[active]);
          }
        }}
      />
      {expanded && !value && (
        <div className="rounded-lg border bg-popover p-2 text-popover-foreground shadow-sm">
          <p
            id="change-request-person-status"
            className="px-2 py-1 text-sm text-muted-foreground"
            role="status"
          >
            {!query
              ? '输入姓名后显示匹配人员'
              : status === 'loading'
                ? '正在查找人员…'
                : status === 'error'
                  ? matches.length
                    ? '人员更新失败，当前展示最近一次结果'
                    : '人员加载失败，请重试'
                  : matches.length === 0
                    ? '未找到可提交的人员，请检查姓名'
                    : matches.length === 20
                      ? '最多显示 20 人，请补充姓名缩小范围'
                      : `匹配到 ${matches.length} 人`}
          </p>
          {status === 'error' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRetry((current) => current + 1)}
            >
              重新加载人员
            </Button>
          )}
          <div
            id="change-request-person-results"
            role="listbox"
            aria-label="匹配的提交人"
            className="max-h-48 overflow-y-auto"
          >
            {matches.map((person, index) => (
              <button
                key={person.id}
                type="button"
                role="option"
                id={`change-person-${index}`}
                aria-selected={index === active}
                className={`block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent ${index === active ? 'bg-accent' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(person)}
              >
                {person.name}
                {person.description && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {person.description}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      {value && (
        <p
          id="change-request-person-status"
          className="text-xs text-muted-foreground"
        >
          已选择：{name}
        </p>
      )}
    </div>
  );
}
