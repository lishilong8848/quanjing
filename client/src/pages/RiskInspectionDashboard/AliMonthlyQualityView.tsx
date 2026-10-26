import { useEffect, useMemo, useState } from 'react';

import type {
  AliMonthlyQualityDataset,
  AliMonthlyQualityIssue,
} from '@shared/risk-inspection.interface';

import { AliMonthlyQualityEvidencePanel } from './AliMonthlyQualityEvidencePanel';
import { AliMonthlyQualityBuildingDialog } from './AliMonthlyQualityBuildingDialog';
import { AliMonthlyQualityIssueDialog } from './AliMonthlyQualityIssueDialog';
import {
  AliMonthlyQualityListDialog,
  type MonthlyQualityIssueListSelection,
} from './AliMonthlyQualityListDialog';
import { AliMonthlyQualityRatingOverview } from './AliMonthlyQualityRatingOverview';
import {
  buildAliMonthlyQualityView,
  selectMonthlyQualityIssues,
  type MonthlyQualitySelection,
} from './monthly-quality-model';

import './ali-monthly-quality.css';

interface AliMonthlyQualityViewProps {
  dataset: AliMonthlyQualityDataset;
  year?: string;
  month: string;
  item: string;
  isRefreshing: boolean;
  onMonthChange?: (month: string) => void;
  onSupplementalUpdated: (recordId: string, supplemental: string) => void;
}

export function AliMonthlyQualityView({
  dataset,
  year,
  month,
  item,
  isRefreshing,
  onMonthChange,
  onSupplementalUpdated,
}: AliMonthlyQualityViewProps) {
  const [selectedBuilding, setSelectedBuilding] = useState('');
  const [detailBuilding, setDetailBuilding] = useState<string | null>(null);
  const [listSelection, setListSelection] =
    useState<MonthlyQualityIssueListSelection | null>(null);
  const [detail, setDetail] = useState<AliMonthlyQualityIssue | null>(null);
  const view = useMemo(
    () =>
      buildAliMonthlyQualityView(dataset, {
        year,
        month,
        item,
        building: selectedBuilding,
      }),
    [dataset, item, month, selectedBuilding, year],
  );

  useEffect(() => {
    if (view.selectedBuilding && view.selectedBuilding !== selectedBuilding) {
      setSelectedBuilding(view.selectedBuilding);
    }
  }, [selectedBuilding, view.selectedBuilding]);

  const openIssueList = (
    selection: MonthlyQualitySelection,
    title: string,
    description: string,
  ) => {
    setListSelection({
      title,
      description,
      issues: selectMonthlyQualityIssues(view, selection),
    });
  };

  const openBuildingGroup = (
    buildings: string[],
    title: string,
    description: string,
  ) => {
    const buildingSet = new Set(buildings);
    setListSelection({
      title,
      description,
      issues: view.issues.filter(({ building }) => buildingSet.has(building)),
    });
  };

  const selectRating = (ratingMonth: string, building: string) => {
    setSelectedBuilding(building);
    if (ratingMonth !== view.selectedMonth) {
      onMonthChange?.(ratingMonth);
    }
    openIssueList(
      { kind: 'rating', month: ratingMonth, building },
      `${view.selectedYear}${ratingMonth} · ${building}问题依据`,
      '评级来自月度评级表，问题记录仅用于关联观察',
    );
  };

  const openBuildingDetail = (building: string) => {
    setSelectedBuilding(building);
    setDetailBuilding(building);
  };

  return (
    <section
      className="quality-dashboard-body"
      aria-label="阿里月度质量评级看板"
    >
      <AliMonthlyQualityRatingOverview
        view={view}
        onSelectBuilding={setSelectedBuilding}
        onOpenBuilding={openBuildingDetail}
        onSelectRating={selectRating}
        onOpenIssues={openIssueList}
        onOpenBuildings={openBuildingGroup}
      />
      <AliMonthlyQualityEvidencePanel
        view={view}
        isRefreshing={isRefreshing}
        onOpenIssues={openIssueList}
        onOpenIssue={setDetail}
        onSupplementalUpdated={onSupplementalUpdated}
      />
      <AliMonthlyQualityBuildingDialog
        view={view}
        building={detailBuilding}
        onClose={() => setDetailBuilding(null)}
        onOpenIssue={(issue) => {
          setDetailBuilding(null);
          setDetail(issue);
        }}
      />
      <AliMonthlyQualityListDialog
        selection={listSelection}
        onClose={() => setListSelection(null)}
        onOpenIssue={(issue) => {
          setListSelection(null);
          setDetail(issue);
        }}
      />
      <AliMonthlyQualityIssueDialog
        issue={detail}
        onClose={() => setDetail(null)}
      />
    </section>
  );
}
