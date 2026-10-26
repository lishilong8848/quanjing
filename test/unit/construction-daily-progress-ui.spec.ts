import { readFileSync } from 'fs';
import { join } from 'path';

function sourceBlock(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  if (start === -1) return '';
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end === -1 ? source.length : end);
}

describe('construction daily progress UI stability', () => {
  const source = readFileSync(
    join(
      process.cwd(),
      'client/src/pages/ConstructionManagement/index.tsx',
    ),
    'utf8',
  );
  const pageSource = sourceBlock(
    source,
    'export default function ConstructionManagementPage()',
    '\nfunction DailyProgressBoard',
  );
  const boardSource = sourceBlock(
    source,
    'function DailyProgressBoard',
    '\nfunction ConstructionCalendar',
  );
  const cardSource = sourceBlock(
    source,
    'function DailyProgressStageCard',
    '\nfunction getDailyProgressToneStyle',
  );
  const toneSource = sourceBlock(
    source,
    'function getDailyProgressToneStyle',
    '\nfunction getDailyProgressWorkItemIcon',
  );
  const hintSource = sourceBlock(
    source,
    'function InfoHint',
    '\nfunction handleInteractiveCardKeyDown',
  );

  it('keeps the progress board wide enough before switching to the split layout', () => {
    expect(pageSource).toContain(
      'grid gap-6 min-[84rem]:grid-cols-[minmax(0,1fr)_31rem] min-[84rem]:items-stretch',
    );
    expect(pageSource).not.toContain(
      'xl:grid-cols-[minmax(0,1fr)_31rem]',
    );
    expect(boardSource).toContain(
      'grid min-h-0 flex-1 items-stretch gap-4 lg:grid-cols-3',
    );
    expect(boardSource).not.toContain(
      'items-start gap-4 md:grid-cols-3',
    );
    expect(boardSource).toContain(
      'className="relative h-full min-h-0 min-w-0"',
    );

    const connectorClass = boardSource.match(
      /className="([^"]*absolute -right-5[^"]*text-\[#7aa8ff\][^"]*)"/,
    )?.[1];
    expect(connectorClass).toContain('lg:flex');
    expect(connectorClass).not.toContain('md:flex');
  });

  it('uses stable card compositing and truncates constrained labels', () => {
    const stageCardClass = cardSource.match(
      /className=\{cn\(\s*'([^']*relative z-10 flex h-full[^']*)'/,
    )?.[1];
    expect(stageCardClass).toContain(
      'relative z-10 flex h-full min-h-[13.25rem] min-w-0',
    );
    expect(stageCardClass).not.toContain('backdrop-blur');
    expect(cardSource).toContain(
      'className="flex min-w-0 flex-1 items-center gap-3"',
    );
    expect(cardSource).toContain(
      'className="flex min-w-0 flex-1 items-center gap-1.5 text-base font-semibold text-slate-950"',
    );
    expect(cardSource).toContain(
      'className="min-w-0 flex-1 truncate"',
    );
    expect(cardSource).toContain(
      'className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-900"',
    );

    const previewCardClass = cardSource.match(
      /key=\{item\.recordId\}\s+className="([^"]+)"/,
    )?.[1];
    expect(previewCardClass).toContain('bg-white/[0.88]');
    expect(previewCardClass).not.toContain('backdrop-blur');

    const emptyStateClass = cardSource.match(
      /<div className="([^"]*h-\[4\.5rem\][^"]*border-dashed[^"]*)">/,
    )?.[1];
    expect(emptyStateClass).toContain('bg-white/[0.72]');
    expect(emptyStateClass).not.toContain('backdrop-blur');

    expect(
      toneSource.match(
        /rgba\(255,255,255,0\.88\)_58%,rgba\(255,255,255,0\.76\)/g,
      ),
    ).toHaveLength(3);
    expect(toneSource).not.toContain('rgba(255,255,255,0.72)_58%');
    expect(toneSource).not.toContain('rgba(255,255,255,0.50)');
  });

  it('renders progress hints through the shared portal tooltip', () => {
    expect(source).toContain("from '@/components/ui/tooltip';");
    expect(hintSource).toContain('<Tooltip>');
    expect(hintSource).toContain('<TooltipTrigger asChild>');
    expect(hintSource).toContain('<TooltipContent');
    expect(hintSource).not.toContain('absolute right-0 top-5');
  });

  it('exposes the daily progress rate to assistive technologies', () => {
    expect(cardSource).toContain('role="progressbar"');
    expect(cardSource).toContain('aria-valuemin={0}');
    expect(cardSource).toContain('aria-valuemax={100}');
    expect(cardSource).toContain('aria-valuenow={doneRate}');
    expect(cardSource).toContain('aria-label={`${stage.label}完成进度`}');
  });
});
