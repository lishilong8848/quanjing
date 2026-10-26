import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type {
  OperationsTool,
  OperationsToolFlow,
} from '@shared/operations-tools.interface';
import { flowToolName } from './model';

export function FlowList({
  flows,
  tools,
  onSelect,
}: {
  flows: OperationsToolFlow[];
  tools: OperationsTool[];
  onSelect: (id: string) => void;
}) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(flows.length / 20)),
    current = Math.min(page, pages);
  if (!flows.length) return <p className="tools-empty">暂无匹配记录</p>;
  return (
    <>
      <div className="tools-flow-list">
        {flows.slice((current - 1) * 20, current * 20).map((f) => (
          <button
            key={`${f.kind}:${f.id}`}
            className="tools-flow-row"
            onClick={() => onSelect(f.id)}
          >
            <span>
              <strong>{flowToolName(f, tools)}</strong>
              <small>
                {f.code || f.id} · {f.building || '关联楼栋'} ·{' '}
                {f.date || '日期未维护'}
              </small>
            </span>
            <Badge
              variant="outline"
              className={
                ['已归还', '检修完成', '报废完成', '完成', '通过'].includes(
                  f.status,
                )
                  ? 'tools-status-success'
                  : ['退回', '已终止', '检修转报废'].includes(f.status)
                    ? 'tools-status-danger'
                    : f.status === '待完善'
                      ? 'tools-status-warning'
                      : 'tools-status-info'
              }
            >
              {f.status}
            </Badge>
          </button>
        ))}
      </div>
      <div className="tools-pagination">
        <span>共 {flows.length} 单</span>
        <Button
          variant="outline"
          size="sm"
          disabled={current === 1}
          onClick={() => setPage(current - 1)}
        >
          上一页
        </Button>
        <span>
          {current} / {pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={current >= pages}
          onClick={() => setPage(current + 1)}
        >
          下一页
        </Button>
      </div>
    </>
  );
}
