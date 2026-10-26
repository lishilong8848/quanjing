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

import {
  selectCertificateExpiryEvents,
  type CertificateExpiryEventLike,
  type CertificatePersonLike,
} from './data';
import type { CertificateFilter } from './model';

interface CertificateExpiryDayDetailDialogProps {
  date: string | null;
  filter: CertificateFilter;
  events: readonly CertificateExpiryEventLike[];
  people: readonly CertificatePersonLike[];
  onOpenChange: (open: boolean) => void;
}

function formatDateTitle(date: string | null): string {
  if (!date) return '证书到期明细';
  const [year, month, day] = date.split('-');
  if (!day) return `${year}年${Number(month)}月到期明细`;
  return `${year}年${Number(month)}月${Number(day)}日到期明细`;
}

export function CertificateExpiryDayDetailDialog({
  date,
  filter,
  events,
  people,
  onOpenChange,
}: CertificateExpiryDayDetailDialogProps) {
  const selectedEvents = date
    ? date.length === 7
      ? events.filter((event) => event.date.startsWith(`${date}-`) &&
          (filter === 'all' || event.category === filter))
        .slice().sort((left, right) => left.date.localeCompare(right.date) ||
          left.personName.localeCompare(right.personName, 'zh-CN'))
      : selectCertificateExpiryEvents(events, date, filter)
    : [];
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const title = formatDateTitle(date);

  return (
    <Dialog open={date !== null} onOpenChange={onOpenChange}>
      <DialogContent className="certificate-detail-dialog certificate-expiry-day-detail-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            当前证书筛选条件下的到期人员与证件清单。
          </DialogDescription>
        </DialogHeader>

        <div className="certificate-detail-table-region">
          <Table aria-label={title}>
            <TableHeader>
              <TableRow>
                <TableHead>姓名</TableHead>
                <TableHead>楼栋/站点</TableHead>
                <TableHead>岗位</TableHead>
                <TableHead>班组</TableHead>
                <TableHead>证书</TableHead>
                <TableHead>到期日</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {selectedEvents.length > 0 ? (
                selectedEvents.map((event) => {
                  const person = peopleById.get(event.personId);
                  return (
                    <TableRow key={event.id}>
                      <TableCell>{event.personName}</TableCell>
                      <TableCell>{event.building || '未分配'}</TableCell>
                      <TableCell>{person?.position || '未登记'}</TableCell>
                      <TableCell>{person?.team || '未分组'}</TableCell>
                      <TableCell>{event.certificateName}</TableCell>
                      <TableCell>{event.date}</TableCell>
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="certificate-detail-empty">
                    暂无到期证件
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <p className="certificate-detail-count">
          共 {selectedEvents.length} 条
        </p>
      </DialogContent>
    </Dialog>
  );
}
