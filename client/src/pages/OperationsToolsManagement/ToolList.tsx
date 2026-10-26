import { memo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { OperationsTool } from '@shared/operations-tools.interface';
import { dueLabel } from './model';
import { useIsMobile } from '@/hooks/use-mobile';

export const ToolList = memo(function ToolList({
  tools,
  today,
  onSelect,
  pageSize = 20,
}: {
  tools: OperationsTool[];
  today: string;
  onSelect: (id: string) => void;
  pageSize?: number;
}) {
  const mobile = useIsMobile();
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(tools.length / pageSize)),
    current = Math.min(page, totalPages);
  const rows = tools.slice((current - 1) * pageSize, current * pageSize);
  if (!tools.length) return <p className="tools-empty">暂无匹配工具</p>;
  return (
    <>
      {!mobile && (
        <div className="tools-table-wrap">
          <table className="tools-table">
            <thead>
              <tr>
                <th>工具 / 型号</th>
                <th>楼栋 / 放置区域</th>
                <th className="tools-number">在册数量</th>
                <th>检查结论</th>
                <th>维护 / 送检</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>
                    <button
                      className="tools-link"
                      onClick={() => onSelect(t.id)}
                    >
                      {t.name}
                    </button>
                    <small>{t.model || '型号未维护'}</small>
                  </td>
                  <td>
                    {t.building || '楼栋未配置'}
                    <small>{t.place || '位置未维护'}</small>
                  </td>
                  <td className="tools-number">
                    {t.quantity === null
                      ? '未维护'
                      : `${t.quantity} ${t.unit || '单位待完善'}`}
                  </td>
                  <td>
                    <Badge
                      variant="outline"
                      className={
                        t.scrapStatus || t.conclusion === '不合格'
                          ? 'tools-status-danger'
                          : t.conclusion === '合格'
                            ? 'tools-status-success'
                            : 'tools-status-warning'
                      }
                    >
                      {t.scrapStatus || t.conclusion || '待检查'}
                    </Badge>
                  </td>
                  <td>
                    {dueLabel(t.maintenanceDue, today)}
                    <small>
                      送检：
                      {t.inspectionDue
                        ? dueLabel(t.inspectionDue, today)
                        : '要求待核实'}
                    </small>
                  </td>
                  <td>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onSelect(t.id)}
                    >
                      详情
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mobile && (
        <div className="tools-mobile-list">
          {rows.map((t) => (
            <article key={t.id}>
              <button className="tools-link" onClick={() => onSelect(t.id)}>
                {t.name}
              </button>
              <Badge
                variant="outline"
                className={
                  t.scrapStatus || t.conclusion === '不合格'
                    ? 'tools-status-danger'
                    : t.conclusion === '合格'
                      ? 'tools-status-success'
                      : 'tools-status-warning'
                }
              >
                {t.scrapStatus || t.conclusion || '待检查'}
              </Badge>
              <p>
                {t.building || '楼栋未配置'} · {t.place || '位置未维护'}
              </p>
              <p>
                {t.model || '型号未维护'} · 在册 {t.quantity ?? '未维护'}{' '}
                {t.unit}
              </p>
              <p>维护：{dueLabel(t.maintenanceDue, today)}</p>
            </article>
          ))}
        </div>
      )}
      <div className="tools-pagination">
        <span>共 {tools.length} 条</span>
        <Button
          variant="outline"
          size="sm"
          disabled={current === 1}
          onClick={() => setPage(current - 1)}
        >
          上一页
        </Button>
        <span>
          {current} / {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={current >= totalPages}
          onClick={() => setPage(current + 1)}
        >
          下一页
        </Button>
      </div>
    </>
  );
});
