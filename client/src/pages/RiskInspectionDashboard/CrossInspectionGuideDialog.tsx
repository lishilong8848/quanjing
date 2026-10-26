import { useEffect, useState, type FormEvent } from 'react';
import {
  BookOpenCheck,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type {
  CrossInspectionGuidePage,
  CrossInspectionGuideSource,
} from '@shared/risk-inspection.interface';

import { getRiskInspectionCrossGuides } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { getPaginationWindow } from './dashboard-model';

type GuideSourceFilter = 'all' | CrossInspectionGuideSource;

const GUIDE_SOURCE_OPTIONS: Array<{
  value: GuideSourceFilter;
  label: string;
}> = [
  { value: 'all', label: '全部标准' },
  { value: 'system', label: '风险排查标准-体系' },
  { value: 'ali', label: '风险排查标准-阿里' },
  { value: 'environment', label: '环境检查标准' },
];

const GUIDE_SOURCE_LABELS: Record<CrossInspectionGuideSource, string> = {
  system: '体系标准',
  ali: '阿里标准',
  environment: '环境标准',
};

export function CrossInspectionGuideDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [source, setSource] = useState<GuideSourceFilter>('all');
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [retryKey, setRetryKey] = useState(0);
  const [data, setData] = useState<CrossInspectionGuidePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setLoading(true);
    setError('');
    void getRiskInspectionCrossGuides({
      source,
      query,
      page,
      pageSize: 12,
    })
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setPage(response.page);
      })
      .catch(() => {
        if (cancelled) return;
        setError('标准与指引加载失败，请稍后重试。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, page, query, retryKey, source]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setQuery(queryInput.trim());
  };
  const pageNumbers = getPaginationWindow(
    data?.page || page,
    data?.totalPages || 1,
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        className="risk-cross-guide-dialog"
        showCloseButton={false}
      >
        <DialogHeader className="risk-metric-list-header">
          <span className="risk-metric-list-icon" aria-hidden="true">
            <BookOpenCheck />
          </span>
          <div>
            <DialogTitle>互查互纠标准与指引</DialogTitle>
            <DialogDescription>
              来源于多维表中的体系、阿里及环境检查标准
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="关闭互查互纠标准与指引"
              className="risk-metric-list-close"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        <form className="risk-cross-guide-toolbar" onSubmit={submitSearch}>
          <Select
            value={source}
            onValueChange={(value) => {
              setSource(value as GuideSourceFilter);
              setPage(1);
            }}
          >
            <SelectTrigger aria-label="标准来源">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GUIDE_SOURCE_OPTIONS.map((option) => (
                <SelectItem value={option.value} key={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="risk-cross-guide-search">
            <Search aria-hidden="true" />
            <span className="sr-only">搜索标准与指引</span>
            <Input
              value={queryInput}
              placeholder="搜索编号、分类、检查项、参考标准或方法"
              onChange={(event) => setQueryInput(event.currentTarget.value)}
            />
          </label>
          <Button type="submit" variant="outline" size="sm">
            查询
          </Button>
          <span className="risk-cross-guide-result-count">
            {data ? `共 ${data.total} 条` : '正在读取标准'}
          </span>
        </form>

        <div className="risk-cross-guide-table-wrap">
          {loading && !data ? (
            <div className="risk-cross-guide-state">
              <RefreshCw className="risk-cross-guide-loading" />
              <strong>正在读取标准与指引</strong>
              <span>首次加载会读取三张多维表，请稍候。</span>
            </div>
          ) : error ? (
            <div className="risk-cross-guide-state">
              <strong>{error}</strong>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRetryKey((current) => current + 1)}
              >
                重新加载
              </Button>
            </div>
          ) : data?.items.length ? (
            <Table className="risk-cross-guide-table">
              <TableHeader>
                <TableRow>
                  <TableHead>来源</TableHead>
                  <TableHead>编号</TableHead>
                  <TableHead>分类</TableHead>
                  <TableHead>检查项目</TableHead>
                  <TableHead>参考标准</TableHead>
                  <TableHead>方法 / 周期</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((guide) => (
                  <TableRow key={guide.id}>
                    <TableCell>
                      <Badge
                        className={`risk-cross-guide-source risk-cross-guide-source-${guide.source}`}
                      >
                        {GUIDE_SOURCE_LABELS[guide.source]}
                      </Badge>
                    </TableCell>
                    <TableCell title={guide.code}>{guide.code}</TableCell>
                    <TableCell
                      title={[guide.category, guide.subcategory]
                        .filter(Boolean)
                        .join(' / ')}
                    >
                      <strong>{guide.category}</strong>
                      {guide.subcategory ? (
                        <span>{guide.subcategory}</span>
                      ) : null}
                    </TableCell>
                    <TableCell title={guide.item}>{guide.item}</TableCell>
                    <TableCell title={guide.standard || guide.item}>
                      {guide.standard || '按检查项目执行'}
                    </TableCell>
                    <TableCell>
                      <strong>{guide.method || '现场检查'}</strong>
                      {guide.cycle || guide.level ? (
                        <span>
                          {[guide.cycle, guide.level && `${guide.level}风险`]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="risk-cross-guide-state">
              <strong>未找到匹配的标准</strong>
              <span>请调整标准来源或搜索关键词。</span>
            </div>
          )}
        </div>

        <div className="risk-cross-guide-pagination">
          <span>
            第 {data?.page || 1} / {data?.totalPages || 1} 页
            {data?.sourceStatus === 'stale' ? ' · 当前显示缓存数据' : ''}
          </span>
          <div>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label="标准上一页"
              disabled={!data || data.page <= 1 || loading}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            {pageNumbers.map((pageNumber) => (
              <Button
                type="button"
                key={pageNumber}
                variant={pageNumber === data?.page ? 'default' : 'ghost'}
                size="icon-xs"
                aria-label={`标准第 ${pageNumber} 页`}
                aria-current={pageNumber === data?.page ? 'page' : undefined}
                disabled={loading}
                onClick={() => setPage(pageNumber)}
              >
                {pageNumber}
              </Button>
            ))}
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              aria-label="标准下一页"
              disabled={!data || data.page >= data.totalPages || loading}
              onClick={() =>
                setPage((current) =>
                  Math.min(data?.totalPages || current, current + 1),
                )
              }
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
