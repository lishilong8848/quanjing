import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useMemo,
  useState,
} from 'react';
import { Search, SlidersHorizontal, Zap, Fan, Network } from 'lucide-react';
import { toast } from 'sonner';
import { canAccessPage } from '@/access/access-policy';
import { useAccess } from '@/access/AccessProvider';
import { canUsePageAction } from '../business-action-access';
import { decideBusinessPermission } from '@shared/business-permissions';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Input } from '@/components/ui/input';
import {
  THRESHOLD_KINDS,
  type ThresholdRecord,
} from '@shared/threshold-management.interface';
import { ThresholdHeader } from './ThresholdHeader';
import { useThresholds } from './use-thresholds';
import { needsThresholdReview, ThresholdList } from './ThresholdList';
import {
  ThresholdDeviceRail,
  thresholdDeviceIcon,
} from './ThresholdDeviceRail';
import { ThresholdMatrix } from './ThresholdMatrix';
import { buildThresholdComparisonGroups } from './comparison-groups';
import './styles.css';

import { useThresholdAdjustments } from './use-threshold-adjustments';
import {
  ThresholdAdjustmentForm,
  ThresholdAdjustmentHistory,
} from './ThresholdAdjustment';

const ThresholdDetail = lazy(() =>
  import('./ThresholdDialogs').then((module) => ({
    default: module.ThresholdDetail,
  })),
);

export default function ThresholdManagement() {
  const { role, pagePaths, principalFingerprint } = useAccess();
  if (!canAccessPage(role, '/threshold-management', pagePaths))
    return (
      <p role="alert" className="p-6">
        当前账号无阈值管理权限
      </p>
    );
  return (
    <ThresholdPage
      key={`${role}:${principalFingerprint}`}
      identity={`${role}:${principalFingerprint}`}
      canDelegate={role === 'admin'}
    />
  );
}
export function ThresholdPage({
  identity,
  canDelegate,
}: {
  identity: string;
  canDelegate: boolean;
}) {
  const access = useAccess();
  const { readOnlyPage } = access;
  const canCreate = canUsePageAction(access, 'thresholds', 'create', !readOnlyPage);
  const canUpdate = canUsePageAction(access, 'thresholds', 'update', !readOnlyPage);
  const canRefresh = canUsePageAction(access, 'thresholds', 'refresh', !readOnlyPage);
  const data = useThresholds(identity);
  const adjustments = useThresholdAdjustments(identity, data.acceptAdjustment, canUsePageAction(access, 'thresholds', 'read', !readOnlyPage));
  const [adjusting, setAdjusting] = useState<ThresholdRecord | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [profession, setProfession] = useState('电气');
  const [building, setBuilding] = useState('');
  const [device, setDevice] = useState('电气关键设备参数表');
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const query = useDeferredValue(search.trim().toLowerCase());
  const [onlyDifferences, setOnlyDifferences] = useState(false);
  const [comparisonKey, setComparisonKey] = useState('');
  const [detail, setDetail] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const professions = useMemo(
    () => [
      ...new Set(['电气', '暖通', ...data.records.map((r) => r.profession)]),
    ],
    [data.records],
  );
  const devices = useMemo(
    () => [
      ...new Set(
        data.records
          .filter((r) => r.profession === profession)
          .map((r) => r.device),
      ),
    ],
    [data.records, profession],
  );
  const activeDevice = devices.includes(device) ? device : devices[0] || '';
  const DeviceIcon = thresholdDeviceIcon(activeDevice);
  const professionRecords = useMemo(
    () => data.records.filter((r) => r.profession === profession),
    [data.records, profession],
  );
  const comparisonGroups = useMemo(
    () =>
      buildThresholdComparisonGroups(
        data.records.filter(
          (r) => r.profession === profession && r.device === activeDevice,
        ),
      ),
    [data.records, profession, activeDevice],
  );
  const activeComparison =
    comparisonGroups.find((group) => group.key === comparisonKey) ||
    comparisonGroups[0];
  const base = useMemo(
    () =>
      (activeComparison?.records || []).filter(
        (r) =>
          !kind ||
          (kind === 'review' ? needsThresholdReview(r) : r.kind === kind),
      ),
    [activeComparison, kind],
  );
  const scoped = useMemo(
    () =>
      base.filter((r) => !building || (r.building || '待核对') === building),
    [base, building],
  );
  const pending = useMemo(
    () =>
      new Set([
        ...Object.keys(data.overlay),
        ...data.syncJobs.map((job) => job.id),
      ]),
    [data.overlay, data.syncJobs],
  );
  const openDetail = useCallback(
    (record: ThresholdRecord) => setDetail(record.id),
    [],
  );
  const openEdit = useCallback(
    (record: ThresholdRecord) => {
      if (!canCreate || (access.effectiveAuthorization && !decideBusinessPermission(access, { module: 'thresholds', action: 'create', building: record.building, specialty: record.profession }).allowed)) return;
      setDetail(null);
      if (
        adjustments.records.some(
          (a) =>
            a.before.id === record.id &&
            !['completed', 'rejected', 'conflict'].includes(a.state),
        )
      ) {
        setHistoryOpen(true);
        return;
      }
      setAdjusting(record);
    },
    [adjustments.records, canCreate, access],
  );
  const selectBuilding = useCallback((value: string) => {
    setBuilding(value);
  }, []);
  const selectDevice = useCallback((value: string) => {
    setComparisonKey('');
    setDevice(value);
    setBuilding('');
    setSearch('');
    setKind('');
    setOnlyDifferences(false);
  }, []);
  const available = Boolean(data.snapshot);
  return (
    <div className="threshold-page">
      {(data.syncJobs.length > 0 || data.syncError || data.sourceError) && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm"
        >
          {data.syncJobs.length > 0 && (
            <span>
              {data.syncJobs.filter((job) => job.sync?.state === 'pending')
                .length > 0
                ? `${data.syncJobs.filter((job) => job.sync?.state === 'pending').length} 项同步中`
                : '同步未完成'}
            </span>
          )}
          {data.syncJobs
            .filter((job) => job.sync?.state === 'error')
            .map((job) => (
              <span
                key={job.clientMutationId}
                className="flex items-center gap-2"
              >
                <span className="text-destructive">
                  {job.record?.parameter || '删除阈值'}：{job.sync?.error}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canUpdate}
                  onClick={() => { if (canUpdate) void data.retrySync(job.clientMutationId); }}
                >
                  重试同步
                </Button>
                {job.sync?.error?.startsWith('多维表记录已') && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canUpdate}
                    onClick={() => { if (canUpdate) void data.acceptCloud(job); }}
                  >
                    采用云端
                  </Button>
                )}
              </span>
            ))}
          {data.syncError && (
            <span className="text-destructive">{data.syncError}</span>
          )}
          {data.sourceError && (
            <span className="text-destructive">{data.sourceError}</span>
          )}
        </div>
      )}
      <ThresholdHeader
        updatedAt={
          data.snapshot?.updatedAt
            ? new Date(data.snapshot.updatedAt).toLocaleString('zh-CN', {
                hour12: false,
              })
            : '—'
        }
        refreshing={data.refreshing}
        refreshDisabled={pending.size > 0}
        onRefresh={() => void data.refresh(canRefresh)}
      >
        <Button className="threshold-add" onClick={() => setHistoryOpen(true)}>
          调整记录
          {adjustments.records.filter(
            (a) => !['completed', 'rejected', 'conflict'].includes(a.state),
          ).length > 0 && (
            <span>
              {
                adjustments.records.filter(
                  (a) =>
                    !['completed', 'rejected', 'conflict'].includes(a.state),
                ).length
              }
            </span>
          )}
        </Button>
      </ThresholdHeader>
      <main className="threshold-main">
        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
        {data.error && (
          <div role="alert" className="threshold-error">
            <span>
              {data.error}
              {available ? '。当前展示最近一次成功读取的数据' : ''}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={data.refreshing || pending.size > 0}
              onClick={() => void data.refresh()}
            >
              重试读取
            </Button>
          </div>
        )}
        {!available && data.status === 'loading' ? (
          <div className="threshold-loading" role="status">
            正在读取阈值…
          </div>
        ) : available ? (
          <>
            <div className="threshold-workspace">
              <ThresholdDeviceRail
                records={professionRecords}
                selected={activeDevice}
                onSelect={selectDevice}
                professionSwitch={
                  <nav className="threshold-professions" aria-label="专业">
                    {professions.map((value) => {
                      const ProfessionIcon =
                        value === '电气'
                          ? Zap
                          : value === '暖通'
                            ? Fan
                            : value === '弱电'
                              ? Network
                              : SlidersHorizontal;
                      return (
                        <button
                          key={value}
                          aria-pressed={profession === value}
                          className={profession === value ? 'is-selected' : ''}
                          onClick={() => {
                            setProfession(value);
                            setComparisonKey('');
                            setDevice('');
                            setKind('');
                            setBuilding('');
                            setSearch('');
                            setOnlyDifferences(false);
                          }}
                        >
                          <ProfessionIcon size={16} />
                          {value}
                        </button>
                      );
                    })}
                  </nav>
                }
              />
              <Card className="threshold-card threshold-records threshold-sheet">
                <CardHeader data-slot="card-header">
                  <div className="threshold-section-heading">
                    <CardTitle data-slot="card-title">
                      <DeviceIcon size={18} />
                      {activeDevice || profession}
                    </CardTitle>
                    <span className="threshold-count">
                      {scoped.length.toLocaleString()} 个设定值
                    </span>
                    {pending.size > 0 && (
                      <span role="status" className="threshold-sync">
                        {pending.size} 项同步中
                      </span>
                    )}
                  </div>
                  {comparisonGroups.length > 1 && (
                    <nav
                      className="threshold-comparison-groups"
                      aria-label="品牌与型号清单"
                    >
                      {comparisonGroups.map((group) => (
                        <button
                          key={group.key}
                          type="button"
                          aria-pressed={group.key === activeComparison?.key}
                          title={`${group.label} · ${group.buildings.join('、')} · ${group.records.length}个设定值`}
                          onClick={() => {
                            setComparisonKey(group.key);
                            setBuilding('');
                            setOnlyDifferences(false);
                          }}
                        >
                          <span>{group.label}</span>
                          <small>{group.records.length}</small>
                        </button>
                      ))}
                    </nav>
                  )}
                  <div className="threshold-filters">
                    <label className="threshold-search">
                      <Search size={16} />
                      <Input
                        aria-label="搜索设备、参数、位置或设定值"
                        placeholder="搜索设备、参数、位置或设定值"
                        value={search}
                        onChange={(event) => {
                          setSearch(event.target.value);
                        }}
                      />
                    </label>
                    <NativeSelect
                      aria-label="楼栋筛选"
                      value={building}
                      onChange={(event) => {
                        selectBuilding(event.target.value);
                      }}
                    >
                      <NativeSelectOption value="">全部楼栋</NativeSelectOption>
                      {[
                        ...new Set(
                          (activeComparison?.records || []).map(
                            (r) => r.building || '待核对',
                          ),
                        ),
                      ].map((value) => (
                        <NativeSelectOption key={value}>
                          {value}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <NativeSelect
                      aria-label="参数类型筛选"
                      value={kind}
                      onChange={(event) => {
                        setKind(event.target.value);
                      }}
                    >
                      <NativeSelectOption value="">全部类型</NativeSelectOption>
                      {THRESHOLD_KINDS.map((value) => (
                        <NativeSelectOption key={value}>
                          {value}
                        </NativeSelectOption>
                      ))}
                      <NativeSelectOption value="review">
                        全部待核对
                      </NativeSelectOption>
                    </NativeSelect>
                    <label className="threshold-difference-switch">
                      <input
                        type="checkbox"
                        checked={onlyDifferences}
                        onChange={(event) =>
                          setOnlyDifferences(event.target.checked)
                        }
                      />
                      仅差异
                    </label>
                  </div>
                </CardHeader>
                <CardContent data-slot="card-content">
                  {scoped.length ? (
                    activeComparison?.records.every(
                      (record) => !record.building,
                    ) ? (
                      <div className="threshold-matrix-scroll">
                        <ThresholdList
                          records={scoped.filter(
                            (record) =>
                              !query ||
                              [record.parameter, record.value, record.note]
                                .join(' ')
                                .toLowerCase()
                                .includes(query),
                          )}
                          pending={pending}
                          canDelete={false}
                          onDetail={openDetail}
                          onEdit={canCreate ? openEdit : undefined}
                          onDelete={() => undefined}
                        />
                      </div>
                    ) : (
                      <ThresholdMatrix
                        key={`${activeDevice}:${activeComparison?.key}:${query}:${kind}:${building}:${onlyDifferences}`}
                        records={scoped}
                        building={building}
                        query={query}
                        onlyDifferences={onlyDifferences}
                        pending={pending}
                        onDetail={openEdit}
                      />
                    )
                  ) : (
                    <div className="threshold-empty">
                      <SlidersHorizontal size={32} />
                      <strong>
                        {professionRecords.length
                          ? '暂无匹配阈值'
                          : `${profession}暂无阈值`}
                      </strong>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        ) : null}
      </main>
      <Suspense
        fallback={
          <div className="threshold-loading" role="status">
            正在打开…
          </div>
        }
      >
        {detail && (
          <ThresholdDetail
            record={data.records.find((r) => r.id === detail)}
            onClose={() => setDetail(null)}
            onEdit={openEdit}
            syncing={pending.has(detail)}
          />
        )}
      </Suspense>
      {adjusting && (
        <ThresholdAdjustmentForm
          record={adjusting}
          context={adjustments.context}
          canDelegate={canDelegate}
          onRefreshContext={() => void adjustments.refreshContext()}
          onClose={() => setAdjusting(null)}
          onSubmit={async (input) => {
            if (!canCreate || (access.effectiveAuthorization && !decideBusinessPermission(access, { module: 'thresholds', action: 'create', building: adjusting.building, specialty: adjusting.profession }).allowed)) throw new Error('当前权限不能提交该阈值调整');
            setAnnouncement('正在提交调整申请');
            const receipt = await adjustments.submit(input);
            setAnnouncement('调整申请已受理，原阈值保持不变');
            toast.message('调整申请已受理');
            return receipt;
          }}
        />
      )}
      {historyOpen && (
        <ThresholdAdjustmentHistory
          records={adjustments.records}
          error={adjustments.error}
          onClose={() => setHistoryOpen(false)}
          onRetry={(id) => { if (canUpdate) void adjustments.retry(id); }}
          canRetry={(item) => canUpdate && (!access.effectiveAuthorization || decideBusinessPermission(access, { module: 'thresholds', action: 'update', building: item.before.building, specialty: item.before.profession }).allowed)}
        />
      )}
    </div>
  );
}
