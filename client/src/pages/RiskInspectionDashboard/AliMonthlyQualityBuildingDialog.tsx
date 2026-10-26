import { useMemo } from 'react';
import {
  Building2,
  ChevronRight,
  ClipboardList,
  Crown,
  History,
  ImageIcon,
  Minus,
  TrendingDown,
  TrendingUp,
  UserRound,
  X,
} from 'lucide-react';
import type { AliMonthlyQualityIssue } from '@shared/risk-inspection.interface';

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

import type { AliMonthlyQualityViewModel } from './monthly-quality-model';
import { buildMonthlyQualityTrendSummary } from './monthly-quality-trend';

const GRADE_AXIS = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-'];

interface AliMonthlyQualityBuildingDialogProps {
  view: AliMonthlyQualityViewModel;
  building: string | null;
  onClose: () => void;
  onOpenIssue: (issue: AliMonthlyQualityIssue) => void;
}

export function AliMonthlyQualityBuildingDialog({
  view,
  building,
  onClose,
  onOpenIssue,
}: AliMonthlyQualityBuildingDialogProps) {
  const detail = useMemo(() => {
    if (!building) return null;
    const current = view.buildings.find(
      (candidate) => candidate.building === building,
    );
    if (!current) return null;

    const ranked = [...view.buildings].sort(
      (left, right) =>
        gradeRank(left.grade) - gradeRank(right.grade) ||
        left.issueCount - right.issueCount ||
        view.buildings.indexOf(left) - view.buildings.indexOf(right),
    );
    const history = view.ratingMatrix.map((row) => {
      const rating = row.cells.find((cell) => cell.building === building);
      return {
        year: row.year,
        month: row.month,
        grade: rating?.grade || '',
        gradeRank: getNullableGradeRank(rating?.grade || ''),
      };
    });
    const issues = view.issues.filter(
      (issue) =>
        issue.building === building && issue.month === view.selectedMonth,
    );

    return {
      current,
      rank:
        ranked.findIndex((candidate) => candidate.building === building) + 1,
      history,
      issues,
      trend: buildMonthlyQualityTrendSummary(building, history),
    };
  }, [building, view]);

  const MovementIcon = detail ? movementIcon(detail.current.movement) : Minus;

  return (
    <Dialog
      open={Boolean(detail)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="quality-building-detail-dialog"
        showCloseButton={false}
      >
        <DialogHeader className="quality-dialog-header quality-building-dialog-header">
          <span className="quality-dialog-icon" aria-hidden="true">
            <Building2 />
          </span>
          <div>
            <DialogTitle>{building || '楼栋'} · 楼栋质量详情</DialogTitle>
            <DialogDescription>
              {view.selectedYear} · {view.selectedMonth}
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="quality-dialog-close"
              aria-label="关闭楼栋质量详情"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        {detail ? (
          <div className="quality-building-dialog-body">
            <section
              className="quality-building-dialog-hero"
              data-grade={gradeTone(detail.current.grade)}
            >
              <div className="quality-building-dialog-grade">
                <span>{detail.current.building}</span>
                <strong>{detail.current.grade || '待评'}</strong>
                {detail.current.benchmark ? (
                  <Badge className="quality-benchmark-badge">
                    <Crown aria-hidden="true" />
                    标杆楼栋
                  </Badge>
                ) : null}
              </div>
              <div className="quality-building-dialog-movement">
                <MovementIcon aria-hidden="true" />
                <span>{movementLabel(detail.current)}</span>
              </div>
              <div className="quality-building-dialog-metrics">
                <span>
                  <small>本月排名</small>
                  <strong>第 {detail.rank} 名</strong>
                </span>
                <span>
                  <small>问题记录</small>
                  <strong>{detail.current.issueCount} 条</strong>
                </span>
                <span>
                  <small>累计 A+</small>
                  <strong>{detail.current.cumulativeAPlus ?? '—'} 次</strong>
                </span>
                <span>
                  <small>主要问题</small>
                  <strong>{detail.current.primaryItem}</strong>
                </span>
              </div>
            </section>

            <section className="quality-building-dialog-section">
              <div className="quality-building-dialog-section-title">
                <History aria-hidden="true" />
                <div>
                  <h3>近月评级</h3>
                  <p>{detail.trend.headline}</p>
                </div>
              </div>
              <div className="quality-building-dialog-history">
                {detail.history.map((point) => (
                  <span
                    data-grade={gradeTone(point.grade)}
                    key={`${point.year}-${point.month}`}
                  >
                    <small>{point.month}</small>
                    <strong>{point.grade || '—'}</strong>
                  </span>
                ))}
              </div>
              <p className="quality-building-dialog-trend-copy">
                {detail.trend.description}
              </p>
            </section>

            <section className="quality-building-dialog-section quality-building-dialog-issues">
              <div className="quality-building-dialog-section-title">
                <ClipboardList aria-hidden="true" />
                <div>
                  <h3>当月问题记录</h3>
                  <p>{detail.issues.length} 条</p>
                </div>
              </div>
              {detail.issues.length > 0 ? (
                <div className="quality-building-dialog-issue-list">
                  {detail.issues.map((issue) => (
                    <button
                      type="button"
                      key={issue.id}
                      onClick={() => onOpenIssue(issue)}
                      aria-label={`查看${issue.item}问题详情：${issue.issue}`}
                    >
                      <span className="quality-building-dialog-issue-main">
                        <Badge variant="outline">{issue.item}</Badge>
                        <strong>{issue.issue}</strong>
                        <small>{issue.supplemental || '暂无补充描述'}</small>
                      </span>
                      <span className="quality-building-dialog-issue-meta">
                        <span>
                          <UserRound aria-hidden="true" />
                          {issue.responsiblePersons.length > 0
                            ? issue.responsiblePersons
                                .map(({ name }) => name)
                                .join('、')
                            : '未关联人员'}
                        </span>
                        <span>
                          <ImageIcon aria-hidden="true" />
                          {issue.images.length} 张影像
                        </span>
                      </span>
                      <ChevronRight aria-hidden="true" />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="quality-building-dialog-empty">
                  当前楼栋当月暂无问题记录
                </div>
              )}
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function gradeRank(grade: string): number {
  const rank = GRADE_AXIS.indexOf(grade);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

function getNullableGradeRank(grade: string): number | null {
  const rank = GRADE_AXIS.indexOf(grade);
  return rank === -1 ? null : rank;
}

function gradeTone(grade: string): string {
  return (
    grade.trim().toLowerCase().replace('+', 'plus').replace('-', 'minus') ||
    'pending'
  );
}

function movementIcon(
  movement: AliMonthlyQualityViewModel['buildings'][number]['movement'],
) {
  if (movement === 'up') return TrendingUp;
  if (movement === 'down') return TrendingDown;
  return Minus;
}

function movementLabel(
  building: AliMonthlyQualityViewModel['buildings'][number],
): string {
  if (building.movement === 'up') {
    return `较上一有效月份 ${building.previousGrade} 提升`;
  }
  if (building.movement === 'down') {
    return `较上一有效月份 ${building.previousGrade} 下降`;
  }
  if (building.movement === 'same') {
    return `较上一有效月份 ${building.previousGrade} 持平`;
  }
  return '暂无上一有效月份评级';
}
