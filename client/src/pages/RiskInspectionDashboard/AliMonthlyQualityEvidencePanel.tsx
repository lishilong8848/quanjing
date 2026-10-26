import { canAccessBuilding } from '@shared/building-access';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  FileSearch,
  Image as ImageIcon,
  Paperclip,
  RefreshCw,
  UserRound,
} from 'lucide-react';

import type { AliMonthlyQualityIssue } from '@shared/risk-inspection.interface';
import { getAliMonthlyQualitySupplementalTask, updateAliMonthlyQualitySupplemental } from '@/api';
import { useAccess } from '@/access/AccessProvider';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
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

import type {
  AliMonthlyQualityViewModel,
  MonthlyQualitySelection,
} from './monthly-quality-model';
import { AliMonthlyQualityImagePreviewDialog } from './AliMonthlyQualityImagePreviewDialog';
import { formatMonthlyQualityImageTitle } from './monthly-quality-image';

const TABLE_PAGE_SIZE = 6;

interface AliMonthlyQualityEvidencePanelProps {
  view: AliMonthlyQualityViewModel;
  isRefreshing: boolean;
  onOpenIssues: (
    selection: MonthlyQualitySelection,
    title: string,
    description: string,
  ) => void;
  onOpenIssue: (issue: AliMonthlyQualityIssue) => void;
  onSupplementalUpdated: (recordId: string, supplemental: string) => void;
}

export function AliMonthlyQualityEvidencePanel({
  view,
  isRefreshing,
  onOpenIssues,
  onOpenIssue,
  onSupplementalUpdated,
}: AliMonthlyQualityEvidencePanelProps) {
  const principal = useAccess();
  const { role } = principal;
  const [buildingFilter, setBuildingFilter] = useState(view.selectedBuilding);
  const [page, setPage] = useState(1);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [followUp, setFollowUp] = useState<{
    issue: AliMonthlyQualityIssue;
    draft: string;
    error: string;
    clientMutationId?: string;
  } | null>(null);
  const [pendingById, setPendingById] = useState<Record<string, string>>({});
  const pendingIds = useRef(new Set<string>());
  const [followUpStatus, setFollowUpStatus] = useState('');
  const canFollowUp = (issue: AliMonthlyQualityIssue) =>
    role === 'admin' || (role === 'professional_admin' || role === 'professional_engineer') || role === 'editor' ||
    (role === 'building_admin' && canAccessBuilding(principal, issue.building));
  const submitFollowUp = async () => {
    if (!followUp) return;
    const { issue } = followUp;
    const supplemental = followUp.draft.trim();
    if (!supplemental || supplemental.length > 3000) {
      setFollowUp({ ...followUp, error: '请填写 1–3000 字的问题跟进' });
      return;
    }
    if (pendingIds.current.has(issue.id)) return;
    const clientMutationId = followUp.clientMutationId || crypto.randomUUID();
    pendingIds.current.add(issue.id);
    setPendingById((current) => ({ ...current, [issue.id]: supplemental }));
    setFollowUpStatus('问题跟进同步中');
    setFollowUp(null);
    let accepted = false;
    let terminal = false;
    try {
      const task = await updateAliMonthlyQualitySupplemental(issue.id, {
        supplemental,
        expectedSupplemental: issue.supplemental,
        clientMutationId,
      });
      if (task.recordId !== issue.id || task.clientMutationId !== clientMutationId ||
        task.supplemental !== supplemental || !task.taskId) {
        throw new Error('服务器返回的问题跟进任务不一致');
      }
      accepted = true;
      let result = task;
      const startedAt = Date.now();
      while (result.syncStatus === 'pending' || result.syncStatus === 'running') {
        if (Date.now() - startedAt > 180_000) break;
        if (Date.now() - startedAt > 15_000) {
          setFollowUpStatus('后台处理中，可安全离开');
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        result = await getAliMonthlyQualitySupplementalTask(task.taskId);
        if (result.taskId !== task.taskId || result.clientMutationId !== clientMutationId) {
          throw new Error('问题跟进任务状态不一致');
        }
      }
      if (result.syncStatus === 'error') {
        terminal = true;
        throw new Error(result.message || '问题跟进同步失败');
      }
      if (result.syncStatus !== 'success') {
        setFollowUpStatus('后台处理中，可安全离开');
        return;
      }
      terminal = true;
      onSupplementalUpdated(issue.id, result.supplemental);
      setFollowUpStatus('问题跟进已同步');
    } catch (error) {
      if (accepted && !terminal) {
        setFollowUpStatus('后台处理中，可稍后刷新查看');
        return;
      }
      setFollowUp({
        issue,
        draft: supplemental,
        error: error instanceof Error ? error.message : '同步失败，请重试',
        ...(!terminal ? { clientMutationId } : {}),
      });
      setFollowUpStatus('问题跟进同步失败');
    } finally {
      if (!accepted || terminal) {
        pendingIds.current.delete(issue.id);
        setPendingById((current) => {
          const next = { ...current };
          delete next[issue.id];
          return next;
        });
      }
    }
  };
  const issueState = view.sourceStates.issues;
  const itemCounts = useMemo(
    () =>
      view.items.map((item) => ({
        item,
        value: view.issues.filter((issue) => issue.item === item).length,
      })),
    [view.issues, view.items],
  );
  const maxItemCount = Math.max(1, ...itemCounts.map(({ value }) => value));
  const maxBuildingCount = Math.max(
    1,
    ...view.buildings.map(({ issueCount }) => issueCount),
  );
  const tableIssues =
    buildingFilter === 'all'
      ? view.issues
      : view.issues.filter(({ building }) => building === buildingFilter);
  const totalPages = Math.max(
    1,
    Math.ceil(tableIssues.length / TABLE_PAGE_SIZE),
  );
  const currentPage = Math.min(page, totalPages);
  const visibleIssues = tableIssues.slice(
    (currentPage - 1) * TABLE_PAGE_SIZE,
    currentPage * TABLE_PAGE_SIZE,
  ).map((issue) => pendingById[issue.id]
    ? { ...issue, supplemental: pendingById[issue.id] }
    : issue);
  const imageEvidence = useMemo(
    () =>
      view.issues.flatMap((issue) =>
        [...issue.images, ...issue.attachments]
          .filter(({ mimeType }) => mimeType.startsWith('image/'))
          .map((evidence) => ({
            evidence,
            issue,
            title: formatMonthlyQualityImageTitle(issue),
          })),
      ),
    [view.issues],
  );

  useEffect(() => {
    setBuildingFilter(view.selectedBuilding || 'all');
    setPage(1);
  }, [view.selectedBuilding, view.selectedItem, view.selectedMonth]);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  return (
    <section
      className="quality-evidence-overview"
      aria-labelledby="quality-evidence-title"
    >
      <div className="quality-section-heading quality-evidence-heading">
        <div>
          <span>问题依据</span>
          <h2 id="quality-evidence-title">
            {view.selectedMonth} · 评级关联问题记录
          </h2>
        </div>
        <div className="quality-evidence-status">
          <span>{view.summary.monthlyIssues} 条问题记录</span>
          {isRefreshing ? (
            <Badge className="quality-refreshing-badge">
              <RefreshCw aria-hidden="true" />
              同步中
            </Badge>
          ) : issueState.status !== 'fresh' ? (
            <Badge className={`quality-source-badge is-${issueState.status}`}>
              {issueState.status === 'stale' ? '问题缓存' : '问题源异常'}
            </Badge>
          ) : null}
        </div>
      </div>

      {view.evidenceYearAmbiguous ? (
        <div className="quality-source-callout is-warning" role="status">
          <AlertTriangle aria-hidden="true" />
          问题表缺少年份，存在多个评级年份时不自动关联问题。
        </div>
      ) : issueState.status === 'error' && view.issues.length === 0 ? (
        <div className="quality-source-callout is-error" role="alert">
          <AlertTriangle aria-hidden="true" />
          问题清单暂时不可用，月度评级仍可正常查看。
        </div>
      ) : null}

      <div className="quality-evidence-insights">
        <Card className="quality-evidence-card quality-item-composition-card">
          <CardContent>
            <div className="quality-panel-heading">
              <div>
                <span>检查项目构成</span>
                <h3>问题集中在哪类检查</h3>
              </div>
              <BarChart3 aria-hidden="true" />
            </div>
            <div className="quality-item-bars">
              {itemCounts.map(({ item, value }) => (
                <div key={item}>
                  <span>
                    <strong>{item}</strong>
                    <em>{value} 条</em>
                  </span>
                  <i>
                    <b style={{ width: `${(value / maxItemCount) * 100}%` }} />
                  </i>
                </div>
              ))}
              {itemCounts.length === 0 ? (
                <p className="quality-compact-empty">暂无检查项目问题</p>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card className="quality-evidence-card quality-building-evidence-card">
          <CardContent>
            <div className="quality-panel-heading">
              <div>
                <span>楼栋问题记录</span>
                <h3>评级之外的问题数量对照</h3>
              </div>
              <FileSearch aria-hidden="true" />
            </div>
            <div className="quality-building-evidence-list">
              {view.buildings.map((building) => (
                <button
                  type="button"
                  key={building.building}
                  aria-label={`查看${building.building}问题记录，共${building.issueCount}条`}
                  onClick={() =>
                    onOpenIssues(
                      { kind: 'building', building: building.building },
                      `${view.selectedMonth} · ${building.building}问题依据`,
                      '问题记录用于辅助观察评级差异',
                    )
                  }
                >
                  <strong>{building.building}</strong>
                  <i>
                    <b
                      style={{
                        width: `${
                          building.issueCount === 0
                            ? 0
                            : Math.max(
                                10,
                                (building.issueCount / maxBuildingCount) * 100,
                              )
                        }%`,
                      }}
                    />
                  </i>
                  <span>
                    {building.issueCount === 0
                      ? '0条记录'
                      : `${building.issueCount}条`}
                  </span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="quality-evidence-card quality-site-gallery-card">
        <CardContent>
          <div className="quality-panel-heading">
            <div>
              <span>现场影像</span>
              <h3>源表问题图片与影像附件</h3>
            </div>
            <ImageIcon aria-hidden="true" />
          </div>
          {imageEvidence.length > 0 ? (
            <div className="quality-site-gallery">
              {imageEvidence.map(({ evidence, issue, title }, index) => (
                <button
                  type="button"
                  key={`${issue.id}-${evidence.url}-${index}`}
                  aria-label={`预览现场影像：${title}`}
                  onClick={() => setPreviewIndex(index)}
                >
                  <span className="quality-gallery-image">
                    <img
                      src={evidence.url}
                      alt={title}
                      width={320}
                      height={180}
                      loading="lazy"
                      onError={(event) => {
                        event.currentTarget.hidden = true;
                        event.currentTarget.nextElementSibling?.removeAttribute(
                          'hidden',
                        );
                      }}
                    />
                    <span className="quality-image-fallback" hidden>
                      <ImageIcon aria-hidden="true" />
                      影像加载失败
                    </span>
                    <em>{issue.building}</em>
                  </span>
                  <span className="quality-gallery-caption">
                    <strong title={title}>{title}</strong>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="quality-gallery-empty">当前月份暂无现场影像</p>
          )}
        </CardContent>
      </Card>

      <Card className="quality-evidence-card quality-evidence-table-card">
        <CardContent>
          <div className="quality-table-header">
            <div className="quality-panel-heading">
              <div>
                <span>完整问题清单</span>
                <h3>
                  {buildingFilter === 'all' ? '全部楼栋' : buildingFilter}
                </h3>
              </div>
              <p>点击记录查看补充描述、附件和问题图片</p>
            </div>
            <Select
              value={buildingFilter}
              onValueChange={(value) => {
                setBuildingFilter(value);
                setPage(1);
              }}
            >
              <SelectTrigger aria-label="问题清单楼栋筛选">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部楼栋</SelectItem>
                {view.buildings.map(({ building }) => (
                  <SelectItem value={building} key={building}>
                    {building}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="quality-table-wrap">
            <Table className="quality-table">
              <TableHeader>
                <TableRow>
                  <TableHead>楼栋</TableHead>
                  <TableHead>检查项目</TableHead>
                  <TableHead>问题</TableHead>
                  <TableHead>问题补充描述</TableHead>
                  <TableHead>涉及人员</TableHead>
                  <TableHead>附件</TableHead>
                  <TableHead>图片</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleIssues.length > 0 ? (
                  visibleIssues.map((issue) => (
                    <TableRow
                      className="quality-table-row"
                      key={issue.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`查看问题详情：${issue.issue}`}
                      onClick={() => onOpenIssue(issue)}
                      onKeyDown={(event) => {
                        if (event.target === event.currentTarget) {
                          openOnKeyboard(event, () => onOpenIssue(issue));
                        }
                      }}
                    >
                      <TableCell>
                        <span className="quality-building-pill">
                          {issue.building}
                        </span>
                      </TableCell>
                      <TableCell>{issue.item}</TableCell>
                      <TableCell
                        className="quality-issue-cell"
                        title={issue.issue}
                      >
                        {issue.issue}
                      </TableCell>
                      <TableCell
                        className="quality-supplement-cell"
                        title={issue.supplemental || '未填写'}
                      >
                        {issue.supplemental || '未填写'}
                        {pendingById[issue.id] ? (
                          <span className="ml-2 text-blue-600" role="status">同步中</span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {issue.responsiblePersons.length > 0 ? (
                          <span className="quality-person-list">
                            <UserRound aria-hidden="true" />
                            {issue.responsiblePersons
                              .map(({ name }) => name)
                              .join('、')}
                          </span>
                        ) : issue.personMatchStatus === 'ambiguous' ? (
                          <span className="quality-person-pending">
                            待人工确认
                          </span>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="quality-evidence-count">
                          <Paperclip aria-hidden="true" />
                          {issue.attachments.length}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="quality-evidence-count">
                          <ImageIcon aria-hidden="true" />
                          {issue.images.length}
                        </span>
                      </TableCell>
                      <TableCell>
                        {canFollowUp(issue) ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={Boolean(pendingById[issue.id])}
                            onClick={(event) => {
                              event.stopPropagation();
                              setFollowUp({ issue, draft: issue.supplemental, error: '' });
                            }}
                          >
                            问题跟进
                          </Button>
                        ) : '—'}
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={8} className="quality-empty-cell">
                      当前筛选结果暂无问题
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="quality-table-pagination">
            <span>共 {tableIssues.length} 条</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={currentPage === 1}
              aria-label="上一页"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft />
            </Button>
            <strong>{currentPage}</strong>
            <span>/ {totalPages}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={currentPage === totalPages}
              aria-label="下一页"
              onClick={() =>
                setPage((current) => Math.min(totalPages, current + 1))
              }
            >
              <ChevronRight />
            </Button>
          </div>
        </CardContent>
      </Card>

      <AliMonthlyQualityImagePreviewDialog
        items={imageEvidence}
        selectedIndex={previewIndex}
        onSelectedIndexChange={setPreviewIndex}
        onClose={() => setPreviewIndex(null)}
      />
      <span className="sr-only" role="status" aria-live="polite">{followUpStatus}</span>
      <Dialog open={Boolean(followUp)} onOpenChange={(open) => {
        if (!open) setFollowUp(null);
      }}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>问题跟进</DialogTitle>
            <DialogDescription className="sr-only">填写并同步问题补充描述</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-slate-700">
              {followUp?.issue.building} · {followUp?.issue.item} · {followUp?.issue.issue}
            </p>
            <label className="block space-y-2 text-sm font-medium">
              <span>问题补充描述</span>
              <Textarea
                value={followUp?.draft || ''}
                maxLength={3000}
                rows={6}
                onChange={(event) => setFollowUp((current) => current
                  ? { ...current, draft: event.target.value, error: '', clientMutationId: undefined }
                  : current)}
              />
            </label>
            {followUp?.error ? <p className="text-sm text-red-700" role="alert">{followUp.error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setFollowUp(null)}>取消</Button>
            <Button type="button" onClick={() => void submitFollowUp()}>提交</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function openOnKeyboard(event: KeyboardEvent, callback: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  callback();
}
