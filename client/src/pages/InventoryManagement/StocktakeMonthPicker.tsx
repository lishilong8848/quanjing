import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  resolveStocktakeMonth,
  shiftStocktakeMonth,
  stocktakeCurrentMonth,
} from './inventory-stocktake.logic';

export function StocktakeMonthPicker({
  month,
  onChange,
  label,
  disabled = false,
}: {
  month: string;
  onChange: (month: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const current = stocktakeCurrentMonth();
  return (
    <div
      role="group"
      aria-label={`${label}切换`}
      className="inline-flex shrink-0 items-center gap-1"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`${label}上个月`}
        disabled={disabled || month <= '2000-01'}
        onClick={() => onChange(shiftStocktakeMonth(month, -1))}
      >
        <ChevronLeft />
      </Button>
      <Input
        aria-label={label}
        type="month"
        value={month}
        min="2000-01"
        max={current}
        disabled={disabled}
        className="h-9 w-36 border-blue-100 bg-white text-sm"
        onChange={(event) => {
          const value = event.target.value;
          if (value && resolveStocktakeMonth(value, current) === value)
            onChange(value);
        }}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`${label}下个月`}
        disabled={disabled || month >= current}
        onClick={() => onChange(shiftStocktakeMonth(month, 1))}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}
