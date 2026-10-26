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
  selectCertificateBuildingRoster,
  summarizeCertificateBuildingPeople,
  type CertificatePersonLike,
} from './data';
import type { BuildingCompliance } from './model';

export interface CertificateBuildingSelection {
  building: string;
  series: 'compliant' | 'non-compliant' | 'rate';
}

interface CertificateBuildingDetailDialogProps {
  selection: CertificateBuildingSelection | null;
  buildings: readonly BuildingCompliance[];
  people: readonly CertificatePersonLike[];
  onOpenChange: (open: boolean) => void;
}

export function CertificateBuildingDetailDialog({
  selection,
  buildings,
  people,
  onOpenChange,
}: CertificateBuildingDetailDialogProps) {
  const building = buildings.find(
    (item) => item.building === selection?.building,
  );
  const selectedPeople = selection
    ? selectCertificateBuildingRoster(people, selection.building)
    : [];
  const rosterSummary = selection
    ? summarizeCertificateBuildingPeople(people, selection.building)
    : null;
  const title = selection ? `${selection.building}人员清单` : '楼栋持证明细';

  return (
    <Dialog open={selection !== null} onOpenChange={onOpenChange}>
      <DialogContent className="certificate-detail-dialog certificate-building-detail-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="certificate-sr-only">
            {title}，共 {selectedPeople.length} 人
          </DialogDescription>
        </DialogHeader>
        {building ? (
          <div className="certificate-building-detail-summary">
            <span>总人数 {rosterSummary?.total ?? 0} 人</span>
            <span data-active={selection?.series === 'compliant'}>
              合规 {building.compliant} 人
            </span>
            <span data-active={selection?.series === 'non-compliant'}>
              不合规 {building.nonCompliant} 人
            </span>
            <span>不涉及 {rosterSummary?.notApplicable ?? 0} 人</span>
            {rosterSummary?.unclassified ? (
              <span>待核对 {rosterSummary.unclassified} 人</span>
            ) : null}
            <span data-active={selection?.series === 'rate'}>
              合规率 {building.rate}%
            </span>
          </div>
        ) : null}
        <div className="certificate-detail-table-region">
          <Table aria-label={title}>
            <TableHeader>
              <TableRow>
                <TableHead>姓名</TableHead>
                <TableHead>岗位</TableHead>
                <TableHead>班组</TableHead>
                <TableHead>持证状态</TableHead>
                <TableHead>缺少证书</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {selectedPeople.length ? (
                selectedPeople.map((person) => (
                  <TableRow key={person.id}>
                    <TableCell>{person.name}</TableCell>
                    <TableCell>{person.position}</TableCell>
                    <TableCell>{person.team}</TableCell>
                    <TableCell>{person.complianceStatus}</TableCell>
                    <TableCell>{person.missingCertificate || '—'}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5} className="certificate-detail-empty">
                    暂无人员
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <p className="certificate-detail-count">
          共 {selectedPeople.length} 人
        </p>
      </DialogContent>
    </Dialog>
  );
}
