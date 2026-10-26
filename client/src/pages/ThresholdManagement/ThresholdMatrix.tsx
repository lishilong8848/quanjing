import { memo, useMemo, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import type { ThresholdRecord } from '@shared/threshold-management.interface';
import {
  buildThresholdMatrix,
  matrixSectionLabel,
  type MatrixRow,
  type MatrixColumn,
} from './matrix-model';

const PAGE_SIZE = 40;
const CAMPUS_BUILDINGS = ['A楼', 'B楼', 'C楼', 'D楼', 'E楼'];

function MatrixCell({
  record,
  column,
  row,
  hidden,
  buildingStart,
  pending,
  onDetail,
}: {
  record?: ThresholdRecord;
  column: MatrixColumn;
  row: MatrixRow;
  hidden: boolean;
  buildingStart: boolean;
  pending: Set<string>;
  onDetail: (record: ThresholdRecord) => void;
}) {
  const responsive = hidden ? 'matrix-hidden-mobile' : '';
  if (!record)
    return (
      <td
        className={`threshold-matrix-cell is-absent ${responsive}`}
        data-building={column.building}
        data-building-start={buildingStart || undefined}
      >
        <span className="sr-only">原表无此参数</span>
      </td>
    );
  const syncing = pending.has(record.id);
  const empty = record.value === '' || record.value === '/';
  const label = `${column.building}${column.location ? ' · ' + column.location : ''} · ${row.parameter}`;
  const longValue = record.value.length > 14 || record.value.includes('\n');
  const valueButton = (
    <button
      className={`threshold-cell-value ${/^-?[\d.,]+\s*%?$/.test(record.value.trim()) ? 'is-numeric' : ''}`}
      aria-label={`查看${label}`}
      disabled={syncing}
      title={longValue ? undefined : record.value || '空白'}
      onClick={() => onDetail(record)}
    >
      <span>{record.value}</span>
      {record.value !== '' &&
        record.value !== '/' &&
        record.unit &&
        !row.parameter.includes(record.unit) &&
        !record.value.includes(record.unit) && <small>{record.unit}</small>}
    </button>
  );
  return (
    <td
      className={`threshold-matrix-cell ${responsive} ${syncing ? 'is-syncing' : empty ? 'is-empty' : row.emphasizedIds.includes(record.id) ? 'is-different' : ''}`}
      data-building={column.building}
      data-building-start={buildingStart || undefined}
    >
      <div className="threshold-cell-body">
        {longValue ? (
          <Tooltip delayDuration={250}>
            <TooltipTrigger asChild>{valueButton}</TooltipTrigger>
            <TooltipContent className="threshold-value-tooltip" sideOffset={6}>
              {record.value}
            </TooltipContent>
          </Tooltip>
        ) : (
          valueButton
        )}
        {syncing && (
          <span className="threshold-sync" role="status">
            同步中
          </span>
        )}
      </div>
    </td>
  );
}
export const ThresholdMatrix = memo(function ThresholdMatrix({
  records,
  query,
  onlyDifferences,
  pending,
  onDetail,
  building,
}: {
  records: ThresholdRecord[];
  building?: string;
  query: string;
  onlyDifferences: boolean;
  pending: Set<string>;
  onDetail: (record: ThresholdRecord) => void;
}) {
  const model = useMemo(
    () =>
      buildThresholdMatrix(records, building ? [building] : CAMPUS_BUILDINGS),
    [records, building],
  );
  const showColumnLabels = model.columns.some((column) => column.location);
  const rows = useMemo(
    () =>
      model.rows.filter(
        (row) =>
          (!onlyDifferences || row.different) &&
          (!query ||
            Object.values(row.cells).some((record) =>
              [
                record.device,
                record.parameter,
                record.section,
                record.location,
                record.model,
                record.brand,
                record.building,
                record.value,
                record.range,
                record.note,
              ]
                .join(' ')
                .toLowerCase()
                .includes(query),
            )),
      ),
    [model, onlyDifferences, query],
  );
  const recordCount = useMemo(
    () => rows.reduce((total, row) => total + Object.keys(row.cells).length, 0),
    [rows],
  );
  const groups = useMemo(
    () =>
      [...new Set(model.columns.map((c) => c.building))].map((building) => ({
        building,
        columns: model.columns.filter((c) => c.building === building),
      })),
    [model],
  );
  const [mobileBuilding, setMobileBuilding] = useState('');
  const firstPopulatedColumn = model.columns.find((column) =>
    model.rows.some((row) => row.cells[column.key]),
  );
  const selectedMobile = groups.some((g) => g.building === mobileBuilding)
    ? mobileBuilding
    : firstPopulatedColumn?.building || groups[0]?.building || '';
  const [mobileColumn, setMobileColumn] = useState('');
  const mobileColumns =
    groups.find((g) => g.building === selectedMobile)?.columns || [];
  const selectedColumn =
    mobileColumns.find((c) => c.key === mobileColumn) || mobileColumns[0];
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const visible = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  return (
    <>
      <div className="threshold-matrix-mobile">
        <NativeSelect
          aria-label="手机楼栋"
          value={selectedMobile}
          onChange={(e) => setMobileBuilding(e.target.value)}
        >
          {groups.map((g) => (
            <NativeSelectOption key={g.building}>
              {g.building}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {mobileColumns.length > 1 && (
          <NativeSelect
            aria-label="手机位置或型号"
            value={selectedColumn?.key || ''}
            onChange={(e) => setMobileColumn(e.target.value)}
          >
            {mobileColumns.map((c) => (
              <NativeSelectOption key={c.key} value={c.key}>
                {c.location || '设定值'}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </div>
      {visible.length ? (
        <div
          className="threshold-matrix-scroll"
          tabIndex={0}
          role="region"
          aria-label="参数对照表"
        >
          <table
            className={`threshold-matrix-table ${model.columns.length > 7 ? 'is-dense' : ''}`}
          >
            <caption className="sr-only">各楼栋设备参数对照</caption>
            <thead className="matrix-desktop-head">
              <tr>
                <th
                  className="threshold-matrix-parameter"
                  rowSpan={showColumnLabels ? 2 : 1}
                  scope="col"
                >
                  参数
                </th>
                {groups.map((g) => (
                  <th
                    key={g.building}
                    colSpan={g.columns.length}
                    scope="colgroup"
                    data-building={g.building}
                  >
                    <span className="threshold-building-name">
                      {g.building}
                    </span>
                  </th>
                ))}
              </tr>
              {showColumnLabels && (
                <tr>
                  {model.columns.map((c, index) => (
                    <th
                      key={c.key}
                      scope="col"
                      title={c.location || '设定值'}
                      data-building-start={
                        index === 0 ||
                        model.columns[index - 1].building !== c.building ||
                        undefined
                      }
                    >
                      {c.location || '设定值'}
                    </th>
                  ))}
                </tr>
              )}
            </thead>
            <thead className="matrix-mobile-head">
              <tr>
                <th className="threshold-matrix-parameter" scope="col">
                  参数
                </th>
                <th scope="col">
                  {selectedMobile}
                  {selectedColumn?.location && (
                    <small>{selectedColumn.location}</small>
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row, index) => (
                <MatrixRowView
                  key={row.key}
                  row={row}
                  columns={model.columns}
                  showSection={
                    index === 0 ||
                    matrixSectionLabel(row) !==
                      matrixSectionLabel(visible[index - 1])
                  }
                  selectedMobileColumn={selectedColumn?.key || ''}
                  pending={pending}
                  onDetail={onDetail}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="threshold-empty">
          <ArrowLeftRight size={28} />
          <strong>{onlyDifferences ? '暂无不同设定值' : '暂无匹配参数'}</strong>
        </div>
      )}
      <div className="threshold-pagination">
        <span>
          {rows.length} 项参数 · {recordCount} 个设定值
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={current <= 1}
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
});
function MatrixRowView({
  row,
  columns,
  showSection,
  selectedMobileColumn,
  ...props
}: {
  row: MatrixRow;
  columns: MatrixColumn[];
  showSection: boolean;
  selectedMobileColumn: string;
  pending: Set<string>;
  onDetail: (r: ThresholdRecord) => void;
}) {
  return (
    <>
      {showSection && (
        <tr className="threshold-matrix-section">
          <th scope="row" className="threshold-matrix-parameter">
            <span>{matrixSectionLabel(row) || '设备参数'}</span>
          </th>
          {columns.map((c, index) => (
            <td
              key={c.key}
              data-building-start={
                index === 0 ||
                columns[index - 1].building !== c.building ||
                undefined
              }
              className={
                c.key === selectedMobileColumn ? '' : 'matrix-hidden-mobile'
              }
            />
          ))}
        </tr>
      )}
      <tr className="threshold-matrix-row">
        <th scope="row" className="threshold-matrix-parameter">
          <strong>{row.parameter}</strong>
          {row.different && (
            <span className="threshold-difference-tag">差异</span>
          )}
        </th>
        {columns.map((c, index) => (
          <MatrixCell
            key={c.key}
            hidden={c.key !== selectedMobileColumn}
            buildingStart={
              index === 0 || columns[index - 1].building !== c.building
            }
            row={row}
            column={c}
            record={row.cells[c.key]}
            {...props}
          />
        ))}
      </tr>
    </>
  );
}
