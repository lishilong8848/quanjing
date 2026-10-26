import { useMemo, useState } from 'react';
import { Loader2, RefreshCw, Search, UserRound } from 'lucide-react';
import type { SystemMonthlyReportIdentityOption } from '@shared/system-monthly-report.interface';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

export function PersonIdentityGate({
  identities,
  loading,
  acceptingId,
  error,
  onReload,
  onSelect,
}: {
  identities: SystemMonthlyReportIdentityOption[];
  loading: boolean;
  acceptingId: string;
  error: string;
  onReload: () => void;
  onSelect: (personId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    if (!normalized) return identities;
    return identities.filter((identity) =>
      identity.name.toLocaleLowerCase('zh-CN').includes(normalized),
    );
  }, [identities, query]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-[radial-gradient(circle_at_top_left,#edf4ff_0%,#f8fbff_48%,#eef3fb_100%)] px-4 py-10">
      <Card className="w-full max-w-xl overflow-hidden border-slate-200/80 bg-white/95 shadow-[0_24px_80px_rgba(51,78,124,0.14)]">
        <CardHeader className="border-b border-slate-100 px-6 py-5">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-500 text-white shadow-sm">
              <UserRound className="h-5 w-5" />
            </span>
            <div>
              <p className="text-xs font-medium tracking-[0.18em] text-blue-500">
                体系月报
              </p>
              <CardTitle className="mt-1 text-xl">选择人员</CardTitle>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 p-6">
          <label className="relative block">
            <span className="sr-only">搜索人员</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索姓名"
              className="h-11 pl-10"
              disabled={loading}
            />
          </label>

          {error ? (
            <Alert variant="destructive" className="py-3">
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>{error}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onReload}
                >
                  <RefreshCw className="h-4 w-4" />
                  重试
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid max-h-[360px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {loading ? (
              <div className="col-span-full flex h-32 items-center justify-center text-blue-600">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span className="sr-only">正在加载人员</span>
              </div>
            ) : visible.length ? (
              visible.map((identity) => (
                <Button
                  key={identity.id}
                  type="button"
                  variant="outline"
                  className="h-12 justify-between border-slate-200 bg-white px-4 text-slate-700 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
                  disabled={Boolean(acceptingId)}
                  onClick={() => onSelect(identity.id)}
                >
                  <span>{identity.name}</span>
                  {acceptingId === identity.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UserRound className="h-4 w-4 text-slate-400" />
                  )}
                </Button>
              ))
            ) : (
              <p className="col-span-full py-12 text-center text-sm text-slate-400">
                未找到人员
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
