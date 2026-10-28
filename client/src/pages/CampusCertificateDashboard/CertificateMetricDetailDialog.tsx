import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  LoaderCircle,
  RotateCw,
  Send,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  CampusCertificateExpiryNotificationPreview,
  CampusCertificateExpiryNotificationResponse,
} from '@shared/api.interface';

import {
  getExpiringCertificateLabel,
  selectCertificateMetricPeople,
  type CertificateExpiryEventLike,
  type CertificateMetricDetailKey,
  type CertificatePersonLike,
} from './data';
import type { BuildingCompliance } from './model';

export type CertificateDetailKey = CertificateMetricDetailKey | 'average-rate';

interface CertificateMetricDetailDialogProps {
  detailKey: CertificateDetailKey | null;
  onOpenChange: (open: boolean) => void;
  people: readonly CertificatePersonLike[];
  buildings: readonly BuildingCompliance[];
  expiryEvents: readonly CertificateExpiryEventLike[];
  referenceDate: string;
  notificationState?: CertificateNotificationState;
  onNotifyExpiring?: () => void;
  onRetryNotificationPreview?: () => void;
}

export type CertificateNotificationState =
  | { status: 'idle' | 'loading' }
  | {
      status: 'ready' | 'sending';
      preview: CampusCertificateExpiryNotificationPreview;
    }
  | {
      status: 'success' | 'partial';
      preview: CampusCertificateExpiryNotificationPreview;
      result: CampusCertificateExpiryNotificationResponse;
    }
  | {
      status: 'error';
      message: string;
      preview?: CampusCertificateExpiryNotificationPreview;
    };

const EMPTY_NOTIFICATION_STATE: CertificateNotificationState = {
  status: 'idle',
};

const DETAIL_META: Record<
  CertificateDetailKey,
  { title: string; description: string }
> = {
  'high-voltage': {
    title: '高压电工资质持有人',
    description: '当前高压证有效人员清单。',
  },
  'low-voltage': {
    title: '低压电工资质持有人',
    description: '当前低压证有效人员清单。',
  },
  'height-work': {
    title: '高处作业资质持有人',
    description: '当前登高证有效人员清单。',
  },
  expiring: {
    title: '90天内到期证件',
    description: '按人员汇总的近期到期提醒。',
  },
  compliant: {
    title: '持证合规人员',
    description: '源表“证书是否合规”为合规的人员清单。',
  },
  'non-compliant': {
    title: '持证不合规人员',
    description: '源表“证书是否合规”为不合规的人员清单。',
  },
  'average-rate': {
    title: '各楼持证合规率',
    description: '各楼合规人数、不合规人数和合规率明细。',
  },
};

function getCertificateName(key: CertificateMetricDetailKey): string {
  switch (key) {
    case 'high-voltage':
      return '高压电工证';
    case 'low-voltage':
      return '低压电工证';
    case 'height-work':
      return '高处作业证';
    case 'expiring':
      return '临期证件';
    case 'compliant':
      return '持证合规';
    case 'non-compliant':
      return '缺少证书';
  }
}

function getCertificateDetail(
  person: CertificatePersonLike,
  key: CertificateMetricDetailKey,
): string {
  switch (key) {
    case 'high-voltage':
      return person.highVoltageExpiryDate || '未登记到期日';
    case 'low-voltage':
      return person.lowVoltageExpiryDate || '未登记到期日';
    case 'height-work':
      return person.heightWorkExpiryDate || '未登记到期日';
    case 'expiring':
      return person.expiryReminder || '临期';
    case 'compliant':
      return person.complianceStatus;
    case 'non-compliant':
      return person.missingCertificate || '待补充';
  }
}

export function CertificateMetricDetailDialog({
  detailKey,
  onOpenChange,
  people,
  buildings,
  expiryEvents,
  referenceDate,
  notificationState = EMPTY_NOTIFICATION_STATE,
  onNotifyExpiring,
  onRetryNotificationPreview,
}: CertificateMetricDetailDialogProps) {
  const isBuildingDetail = detailKey === 'average-rate';
  const meta = detailKey ? DETAIL_META[detailKey] : null;
  const selectedPeople =
    detailKey && !isBuildingDetail
      ? selectCertificateMetricPeople(people, detailKey)
      : [];
  const isExpiringDetail = detailKey === 'expiring';

  return (
    <Dialog
      open={detailKey !== null}
      onOpenChange={(open) => onOpenChange(open)}
    >
      <DialogContent
        className="certificate-detail-dialog"
        data-detail-key={detailKey ?? undefined}
      >
        <DialogHeader>
          <DialogTitle>{meta?.title ?? '持证明细'}</DialogTitle>
          <DialogDescription>
            {meta?.description ?? '查看对应指标的具体清单。'}
          </DialogDescription>
        </DialogHeader>

        {isExpiringDetail && (onNotifyExpiring || onRetryNotificationPreview) ? (
          <CertificateExpiryNotificationPanel
            state={notificationState}
            onNotify={onNotifyExpiring}
            onRetryPreview={onRetryNotificationPreview}
          />
        ) : null}

        <div className="certificate-detail-table-region">
          <Table aria-label={meta?.title ?? '持证明细'}>
            {isBuildingDetail ? (
              <>
                <TableHeader>
                  <TableRow>
                    <TableHead>楼栋/站点</TableHead>
                    <TableHead>合规人数</TableHead>
                    <TableHead>不合规人数</TableHead>
                    <TableHead>合规率</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {buildings.length > 0 ? (
                    buildings.map((building) => (
                      <TableRow key={building.building}>
                        <TableCell>{building.building}</TableCell>
                        <TableCell>{building.compliant}</TableCell>
                        <TableCell>{building.nonCompliant}</TableCell>
                        <TableCell>{building.rate}%</TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="certificate-detail-empty"
                      >
                        暂无楼栋合规明细
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </>
            ) : (
              <>
                <TableHeader>
                  <TableRow>
                    <TableHead>姓名</TableHead>
                    <TableHead>楼栋/站点</TableHead>
                    <TableHead>岗位</TableHead>
                    <TableHead>班组</TableHead>
                    <TableHead>证书/状态</TableHead>
                    <TableHead>到期日/说明</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detailKey &&
                  !isBuildingDetail &&
                  selectedPeople.length > 0 ? (
                    selectedPeople.map((person) => (
                      <TableRow key={person.id}>
                        <TableCell>{person.name}</TableCell>
                        <TableCell>{person.building || '未分配'}</TableCell>
                        <TableCell>{person.position || '未登记'}</TableCell>
                        <TableCell>{person.team || '未分组'}</TableCell>
                        <TableCell>
                          {detailKey === 'expiring'
                            ? getExpiringCertificateLabel(
                                person,
                                expiryEvents,
                                referenceDate,
                              )
                            : getCertificateName(detailKey)}
                        </TableCell>
                        <TableCell>
                          {getCertificateDetail(person, detailKey)}
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="certificate-detail-empty"
                      >
                        暂无符合该指标的人员明细
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </>
            )}
          </Table>
        </div>

        <p className="certificate-detail-count">
          共 {isBuildingDetail ? buildings.length : selectedPeople.length} 条
        </p>
      </DialogContent>
    </Dialog>
  );
}

function CertificateExpiryNotificationPanel({
  state,
  onNotify,
  onRetryPreview,
}: {
  state: CertificateNotificationState;
  onNotify?: () => void;
  onRetryPreview?: () => void;
}) {
  const preview =
    state.status === 'ready' ||
    state.status === 'sending' ||
    state.status === 'success' ||
    state.status === 'partial'
      ? state.preview
      : state.status === 'error'
        ? (state.preview ?? null)
        : null;
  const result =
    state.status === 'success' || state.status === 'partial'
      ? state.result
      : null;
  const isBusy = state.status === 'idle' || state.status === 'loading';
  const canNotify =
    state.status === 'ready' &&
    !state.preview.blocked &&
    state.preview.matchedCount > 0;
  const isSending = state.status === 'sending';
  const isCompleted = state.status === 'success' || state.status === 'partial';
  const statusMessage = getNotificationStatusMessage(state);
  const exceptionNames = preview
    ? [...preview.unmatchedNames, ...preview.ambiguousNames]
    : [];

  return (
    <section
      className="certificate-notification-panel"
      data-notification-status={state.status}
      aria-label="飞书到期提醒"
    >
      <span className="certificate-notification-icon" aria-hidden="true">
        {state.status === 'success' ? (
          <CheckCircle2 />
        ) : state.status === 'partial' || state.status === 'error' ? (
          <AlertTriangle />
        ) : isBusy || isSending ? (
          <LoaderCircle className="certificate-notification-spinner" />
        ) : (
          <BellRing />
        )}
      </span>
      <div className="certificate-notification-copy" aria-live="polite">
        <strong>飞书到期提醒</strong>
        <p>{statusMessage}</p>
        {exceptionNames.length > 0 ? (
          <small title={exceptionNames.join('、')}>
            未发送：{exceptionNames.join('、')}
          </small>
        ) : null}
        {result?.failures.length ? (
          <small title={result.failures.map((item) => item.name).join('、')}>
            发送失败：{result.failures.map((item) => item.name).join('、')}
          </small>
        ) : null}
      </div>

      {state.status === 'error' ? (
        <Button
          type="button"
          variant="outline"
          className="certificate-notification-button"
          onClick={state.preview ? onNotify : onRetryPreview}
        >
          <RotateCw aria-hidden="true" />
          {state.preview ? '安全重试' : '重新预检'}
        </Button>
      ) : (
        <Button
          type="button"
          className="certificate-notification-button"
          disabled={!canNotify || isBusy || isSending || isCompleted}
          aria-busy={isSending}
          onClick={onNotify}
        >
          {isSending ? (
            <LoaderCircle
              className="certificate-notification-spinner"
              aria-hidden="true"
            />
          ) : isCompleted ? (
            <CheckCircle2 aria-hidden="true" />
          ) : (
            <Send aria-hidden="true" />
          )}
          {getNotificationButtonLabel(state)}
        </Button>
      )}
    </section>
  );
}

function getNotificationStatusMessage(
  state: CertificateNotificationState,
): string {
  switch (state.status) {
    case 'idle':
    case 'loading':
      return '正在读取群成员并核对人员身份…';
    case 'ready':
      if (state.preview.blocked) {
        return state.preview.blockedReason || '当前数据不可发送提醒';
      }
      if (state.preview.matchedCount === 0) {
        return '预检完成，当前没有可安全发送的唯一匹配人员';
      }
      return `预检完成，${state.preview.matchedCount}/${state.preview.totalPeople} 人唯一匹配，可一次发送`;
    case 'sending':
      return `正在向 ${state.preview.matchedCount} 人发送飞书私信…`;
    case 'success':
      return `发送完成，已成功通知 ${state.result.sentCount} 人`;
    case 'partial':
      return `发送完成：成功 ${state.result.sentCount} 人，失败 ${state.result.failedCount} 人`;
    case 'error':
      return state.message;
  }
}

function getNotificationButtonLabel(
  state: CertificateNotificationState,
): string {
  switch (state.status) {
    case 'ready':
      return state.preview.blocked
        ? '暂不可发送'
        : `一键通知 ${state.preview.matchedCount} 人`;
    case 'sending':
      return '发送中';
    case 'success':
      return `已通知 ${state.result.sentCount} 人`;
    case 'partial':
      return `已发送 ${state.result.sentCount} 人`;
    case 'idle':
    case 'loading':
      return '预检中';
    case 'error':
      return '预检失败';
  }
}
