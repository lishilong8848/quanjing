import React, { useEffect, useMemo, useState } from 'react';
import { logger } from '@lark-apaas/client-toolkit/logger';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Loader2,
  RefreshCw,
  Search,
  Wrench,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  repairDutyProgramModifiedIssues,
  scanDutyProgramModifiedIssues,
} from '@/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import type {
  DutyStaffActualRepairCandidate,
  DutyStaffActualRepairScanResponse,
} from '@shared/api.interface';

type StatCardProps = {
  label: string;
  value: string | number;
  helper: string;
  icon: React.ElementType;
  tone: 'blue' | 'amber' | 'green';
};

const toneClassMap = {
  blue: 'bg-blue-50 text-blue-700 border-blue-100',
  amber: 'bg-amber-50 text-amber-700 border-amber-100',
  green: 'bg-emerald-50 text-emerald-700 border-emerald-100',
};

const StatCard: React.FC<StatCardProps> = ({
  label,
  value,
  helper,
  icon: Icon,
  tone,
}) => (
  <Card className="rounded-lg border-border bg-card shadow-sm">
    <CardContent className="p-5">
      <div className="flex items-center gap-3">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-lg border ${toneClassMap[tone]}`}
        >
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className="mt-1 truncate text-2xl font-semibold text-foreground">
            {value}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{helper}</p>
        </div>
      </div>
    </CardContent>
  </Card>
);

const FieldText: React.FC<{ value: string; muted?: boolean }> = ({
  value,
  muted,
}) => (
  <div
    className={`max-h-24 min-w-48 overflow-auto whitespace-pre-wrap rounded-md border px-3 py-2 text-sm leading-5 ${
      muted
        ? 'border-border bg-muted text-muted-foreground'
        : 'border-blue-100 bg-blue-50/70 text-foreground'
    }`}
  >
    {value || '空'}
  </div>
);

const CandidateRow: React.FC<{
  candidate: DutyStaffActualRepairCandidate;
  repairing: boolean;
  onRepair: (recordId: string) => void;
}> = ({ candidate, repairing, onRepair }) => (
  <TableRow>
    <TableCell className="whitespace-nowrap font-medium text-foreground">
      {candidate.scheduleDate || '—'}
    </TableCell>
    <TableCell className="whitespace-nowrap text-muted-foreground">
      {candidate.building || '—'}
    </TableCell>
    <TableCell className="whitespace-nowrap text-muted-foreground">
      {candidate.team || '—'}
    </TableCell>
    <TableCell className="whitespace-normal">
      <FieldText value={candidate.currentValue} muted />
    </TableCell>
    <TableCell className="whitespace-normal">
      <FieldText value={candidate.suggestedValue} />
    </TableCell>
    <TableCell className="whitespace-normal">
      <Badge className="rounded-md border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-50">
        {candidate.reason}
      </Badge>
    </TableCell>
    <TableCell className="whitespace-nowrap text-right">
      <Button
        type="button"
        size="sm"
        disabled={!candidate.canRepair || repairing}
        onClick={() => onRepair(candidate.recordId)}
      >
        {repairing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Wrench className="h-4 w-4" />
        )}
        修正
      </Button>
    </TableCell>
  </TableRow>
);

const DutyStaffRepairPage: React.FC = () => {
  const [scanData, setScanData] =
    useState<DutyStaffActualRepairScanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [bulkRepairing, setBulkRepairing] = useState(false);
  const [repairingIds, setRepairingIds] = useState<Set<string>>(new Set());
  const [manualRecordId, setManualRecordId] = useState('');
  const [manualValue, setManualValue] = useState('');
  const [manualRepairing, setManualRepairing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const repairableCount = useMemo(
    () => scanData?.candidates.filter((item) => item.canRepair).length || 0,
    [scanData],
  );

  const loadData = async (silent = false, refreshRemote = false) => {
    try {
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      const data = await scanDutyProgramModifiedIssues(500, refreshRemote);
      setScanData(data);
    } catch (err) {
      logger.error('加载值班人员修正数据失败', err);
      setError('扫描失败，请检查飞书多维表权限或稍后重试');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const handleRepairOne = async (recordId: string) => {
    setRepairingIds((prev) => new Set(prev).add(recordId));
    try {
      const result = await repairDutyProgramModifiedIssues({ recordIds: [recordId] });
      if (result.failed > 0) {
        toast.error(result.message);
      } else {
        toast.success(result.message);
      }
      await loadData(true, true);
    } catch (err) {
      logger.error('修正单条记录失败', err);
      toast.error('修正失败，请稍后重试');
    } finally {
      setRepairingIds((prev) => {
        const next = new Set(prev);
        next.delete(recordId);
        return next;
      });
    }
  };

  const handleRepairAll = async () => {
    setBulkRepairing(true);
    try {
      const result = await repairDutyProgramModifiedIssues();
      if (result.failed > 0) {
        toast.error(result.message);
      } else {
        toast.success(result.message);
      }
      await loadData(true, true);
    } catch (err) {
      logger.error('批量修正失败', err);
      toast.error('批量修正失败，请稍后重试');
    } finally {
      setBulkRepairing(false);
    }
  };

  const handleManualRepair = async () => {
    const recordId = manualRecordId.trim();
    if (!recordId) {
      toast.error('请输入记录 ID');
      return;
    }

    setManualRepairing(true);
    try {
      const result = await repairDutyProgramModifiedIssues({
        recordId,
        replacementValue: manualValue,
      });
      if (result.failed > 0) {
        toast.error(result.message);
      } else {
        toast.success(result.message);
        setManualRecordId('');
        setManualValue('');
      }
      await loadData(true, true);
    } catch (err) {
      logger.error('手动修正失败', err);
      toast.error('手动修正失败，请稍后重试');
    } finally {
      setManualRepairing(false);
    }
  };

  if (loading) {
    return (
      <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 md:py-8 lg:px-6">
        <div className="grid gap-4 md:grid-cols-3">
          {[1, 2, 3].map((item) => (
            <Skeleton key={item} className="h-28 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-96 rounded-lg" />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 md:py-8 lg:px-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">
            值班人员修正
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {scanData
              ? `${scanData.sourceField} → ${scanData.targetField}`
              : '飞书多维表字段校验'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={refreshing || bulkRepairing}
            onClick={() => void loadData(true, true)}
          >
            {refreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            重新扫描
          </Button>
          <Button
            type="button"
            disabled={repairableCount === 0 || bulkRepairing || refreshing}
            onClick={() => void handleRepairAll()}
          >
            {bulkRepairing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Wrench className="h-4 w-4" />
            )}
            一键修正
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>扫描异常</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="异常记录"
          value={scanData?.totalCandidates ?? 0}
          helper={`${repairableCount} 条可直接修正`}
          icon={AlertTriangle}
          tone="amber"
        />
        <StatCard
          label="扫描记录"
          value={scanData?.totalScanned ?? 0}
          helper="来自值班排班基础表"
          icon={Database}
          tone="blue"
        />
        <StatCard
          label="目标字段"
          value={scanData?.targetField || '—'}
          helper={scanData?.targetFieldId || '字段 ID 未返回'}
          icon={CheckCircle2}
          tone="green"
        />
      </section>

      <Card className="rounded-lg border-border bg-card shadow-sm">
        <CardHeader className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-lg">异常候选</CardTitle>
              <CardDescription>
                当前值包含占位符、规则说明或明显非姓名文本时进入列表
              </CardDescription>
            </div>
            <Badge className="rounded-md bg-blue-50 text-blue-700 hover:bg-blue-50">
              {scanData?.returnedCandidates || 0} 条
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {scanData && scanData.candidates.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead>机楼</TableHead>
                  <TableHead>班组</TableHead>
                  <TableHead>当前值</TableHead>
                  <TableHead>修正为</TableHead>
                  <TableHead>原因</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scanData.candidates.map((candidate) => (
                  <CandidateRow
                    key={candidate.recordId}
                    candidate={candidate}
                    repairing={repairingIds.has(candidate.recordId)}
                    onRepair={handleRepairOne}
                  />
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="flex min-h-56 flex-col items-center justify-center px-6 py-12 text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg border border-emerald-100 bg-emerald-50 text-emerald-600">
                <Search className="h-6 w-6" />
              </div>
              <p className="font-medium text-foreground">未发现异常记录</p>
              <p className="mt-1 text-sm text-muted-foreground">
                最近扫描时间：{scanData?.checkedAt || '—'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-lg border-border bg-card shadow-sm">
        <CardHeader className="p-5">
          <CardTitle className="text-lg">手动修正</CardTitle>
          <CardDescription>
            指定记录 ID 后直接写入目标字段，留空可清空该字段
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 p-5 pt-0 md:grid-cols-[minmax(16rem,24rem)_1fr_auto] md:items-end">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground" htmlFor="repair-record-id">
              记录 ID
            </label>
            <Input
              id="repair-record-id"
              value={manualRecordId}
              onChange={(event) => setManualRecordId(event.target.value)}
              placeholder="rec..."
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground" htmlFor="repair-value">
              修正值
            </label>
            <Textarea
              id="repair-value"
              value={manualValue}
              onChange={(event) => setManualValue(event.target.value)}
              placeholder="输入人员姓名；留空表示清空"
              className="min-h-20"
            />
          </div>
          <Button
            type="button"
            className="min-h-10"
            disabled={manualRepairing}
            onClick={() => void handleManualRepair()}
          >
            {manualRepairing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Wrench className="h-4 w-4" />
            )}
            写入
          </Button>
        </CardContent>
      </Card>
    </main>
  );
};

export default DutyStaffRepairPage;
