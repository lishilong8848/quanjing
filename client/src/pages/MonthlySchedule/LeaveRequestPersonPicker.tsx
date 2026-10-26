import React, {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Check } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface LeaveRequestPersonPickerProps {
  selectedName: string;
  options: readonly string[];
  disabled: boolean;
  readOnly?: boolean;
  matches: (name: string, search: string) => boolean;
  onSelect: (name: string) => void;
}

export const LeaveRequestPersonPicker = React.memo(
  function LeaveRequestPersonPicker({
    selectedName,
    options,
    disabled,
    readOnly = false,
    matches,
    onSelect,
  }: LeaveRequestPersonPickerProps) {
    const [search, setSearch] = useState(selectedName);
    const [pickerOpen, setPickerOpen] = useState(false);
    const previousSelectedNameRef = useRef(selectedName);
    const selectionClearPendingRef = useRef(false);
    const pickerRef = useRef<HTMLDivElement>(null);
    const blurTimeoutRef = useRef<number | null>(null);
    const cancelPendingBlur = useCallback(() => {
      if (blurTimeoutRef.current !== null) {
        window.clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = null;
      }
    }, []);

    useEffect(() => cancelPendingBlur, [cancelPendingBlur]);

    useEffect(() => {
      const previousSelectedName = previousSelectedNameRef.current;
      setSearch((current) =>
        selectedName || current === previousSelectedName
          ? selectedName
          : current,
      );
      previousSelectedNameRef.current = selectedName;
      selectionClearPendingRef.current = false;
    }, [selectedName]);

    const filteredOptions = useMemo(
      () => options.filter((name) => matches(name, search)).slice(0, 30),
      [matches, options, search],
    );

    if (readOnly) {
      return (
        <Input
          id="leave-staff-name"
          value={selectedName}
          readOnly
          aria-readonly="true"
          className="h-9 border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
        />
      );
    }

    return (
      <div ref={pickerRef} className="relative">
        <Input
          id="leave-staff-name"
          value={search}
          disabled={disabled}
          onChange={(event) => {
            cancelPendingBlur();
            const value = event.target.value;
            setSearch(value);
            setPickerOpen(true);
            if (
              selectedName &&
              value.trim() !== selectedName &&
              !selectionClearPendingRef.current
            ) {
              selectionClearPendingRef.current = true;
              startTransition(() => onSelect(''));
            }
          }}
          onFocus={() => {
            cancelPendingBlur();
            setPickerOpen(true);
          }}
          onBlur={() => {
            cancelPendingBlur();
            blurTimeoutRef.current = window.setTimeout(() => {
              blurTimeoutRef.current = null;
              if (
                pickerRef.current &&
                !pickerRef.current.contains(document.activeElement)
              ) {
                setPickerOpen(false);
              }
            }, 120);
          }}
          placeholder="输入姓名快速匹配"
          autoComplete="off"
          className="h-9 border-slate-200 bg-slate-50 focus-visible:ring-blue-200"
        />
        {!disabled && pickerOpen && filteredOptions.length > 0 ? (
          <div className="absolute z-20 mt-1 max-h-44 w-full overflow-auto rounded-lg border border-blue-100 bg-white p-1 shadow-lg">
            {filteredOptions.map((name) => (
              <button
                key={name}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  cancelPendingBlur();
                  setSearch(name);
                  setPickerOpen(false);
                  startTransition(() => onSelect(name));
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-blue-50 hover:text-blue-700',
                  selectedName === name
                    ? 'bg-blue-50 font-semibold text-blue-700'
                    : 'text-slate-700',
                )}
              >
                <span>{name}</span>
                {selectedName === name ? (
                  <Check className="h-3.5 w-3.5" />
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  },
);
