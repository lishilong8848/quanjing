import { readFileSync } from 'node:fs';

import {
  formatRiskTrendPeriod,
  getOuterDonutLabelLayout,
  getStableDonutLabelIndex,
} from '../../client/src/pages/RiskInspectionDashboard/chart-layout';
import * as chartLayout from '../../client/src/pages/RiskInspectionDashboard/chart-layout';

type DonutColorResolver = (
  item: { key: string; label: string },
  index: number,
) => string;

interface RiskDonutGeometry {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  outerInnerRadius: number;
  outerRadius: number;
  innerRadius: number;
  innerOuterRadius: number;
}

interface InnerDonutLabelLayout {
  mode: 'full' | 'value-only' | 'hidden';
  x: number;
  y: number;
  width: number;
  height: number;
  valueTextLength?: number;
}

type RoutedOuterDonutLabelLayout = ReturnType<
  typeof getOuterDonutLabelLayout
> & {
  bendX: number;
  bendY: number;
  endY: number;
};

function distanceToSegment(
  cx: number,
  cy: number,
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) {
    return Math.hypot(start.x - cx, start.y - cy);
  }

  const projection = Math.max(
    0,
    Math.min(
      1,
      ((cx - start.x) * deltaX + (cy - start.y) * deltaY) / lengthSquared,
    ),
  );
  return Math.hypot(
    start.x + projection * deltaX - cx,
    start.y + projection * deltaY - cy,
  );
}

function getRechartsEquivalentMidAngles<T extends { value: number }>(
  items: readonly T[],
  startAngle = 90,
  endAngle = -270,
  paddingAngle = 0.6,
): Array<T & { midAngle: number }> {
  const deltaAngle =
    Math.sign(endAngle - startAngle) *
    Math.min(Math.abs(endAngle - startAngle), 360);
  const direction = Math.sign(deltaAngle);
  const nonZeroCount = items.filter(({ value }) => value !== 0).length;
  const totalPaddingAngle =
    (Math.abs(deltaAngle) >= 360 ? nonZeroCount : nonZeroCount - 1) *
    paddingAngle;
  const realTotalAngle = Math.abs(deltaAngle) - totalPaddingAngle;
  const total = items.reduce((sum, { value }) => sum + value, 0);
  let previousEndAngle = startAngle;

  return items.map((item, index) => {
    const itemStartAngle =
      index === 0
        ? startAngle
        : previousEndAngle +
          direction * paddingAngle * (item.value !== 0 ? 1 : 0);
    const itemEndAngle =
      itemStartAngle + direction * (item.value / total) * realTotalAngle;
    previousEndAngle = itemEndAngle;

    return {
      ...item,
      midAngle: (itemStartAngle + itemEndAngle) / 2,
    };
  });
}

function getColorResolver(
  name: 'getSeverityColor' | 'getStatusColor',
): DonutColorResolver | undefined {
  return Reflect.get(chartLayout, name) as DonutColorResolver | undefined;
}

function getTopClusterLayout(index: number) {
  const geometry = Reflect.get(chartLayout, 'RISK_DONUT_GEOMETRY') as
    | RiskDonutGeometry
    | undefined;
  return getOuterDonutLabelLayout({
    cx: geometry?.centerX ?? 176,
    cy: geometry?.centerY ?? 138,
    midAngle: index % 2 === 0 ? 88 : 92,
    outerRadius: geometry?.outerRadius ?? 106,
    index,
  });
}

const TOP_CLUSTER_INDEX_PAIRS = [
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [1, 2],
  [1, 3],
  [1, 4],
  [2, 3],
  [2, 4],
  [3, 4],
] as const;

describe('risk inspection donut label layout', () => {
  it('reserves enough geometry for external labels and an in-ring status label', () => {
    const geometry = Reflect.get(chartLayout, 'RISK_DONUT_GEOMETRY') as
      | RiskDonutGeometry
      | undefined;
    const getInnerDonutLabelLayout = Reflect.get(
      chartLayout,
      'getInnerDonutLabelLayout',
    ) as
      | ((input: {
          cx: number;
          cy: number;
          midAngle: number;
          percent: number;
          innerRadius: number;
          outerRadius: number;
        }) => InnerDonutLabelLayout)
      | undefined;

    expect(geometry).toEqual(expect.any(Object));
    expect(geometry).toMatchObject({
      width: 420,
      height: 276,
      centerX: 210,
      centerY: 138,
      outerInnerRadius: 80,
      outerRadius: 106,
      innerRadius: 22,
      innerOuterRadius: 70,
    });
    if (geometry) {
      expect(
        geometry.outerInnerRadius - geometry.innerOuterRadius,
      ).toBeGreaterThanOrEqual(8);
      expect(
        geometry.innerOuterRadius - geometry.innerRadius,
      ).toBeGreaterThanOrEqual(40);
    }
    expect(getInnerDonutLabelLayout).toEqual(expect.any(Function));
    if (!geometry || !getInnerDonutLabelLayout) return;

    const fullLabel = getInnerDonutLabelLayout({
      cx: geometry.centerX,
      cy: geometry.centerY,
      midAngle: 45,
      percent: 0.75,
      innerRadius: geometry.innerRadius,
      outerRadius: geometry.innerOuterRadius,
    });
    expect(fullLabel.mode).toBe('full');
    const expectLabelInsideRing = (label: InnerDonutLabelLayout) => {
      const centerDistanceX = Math.abs(label.x - geometry.centerX);
      const centerDistanceY = Math.abs(label.y - geometry.centerY);
      const nearestRadius = Math.hypot(
        Math.max(0, centerDistanceX - label.width / 2),
        Math.max(0, centerDistanceY - label.height / 2),
      );
      const farthestRadius = Math.hypot(
        centerDistanceX + label.width / 2,
        centerDistanceY + label.height / 2,
      );

      expect(nearestRadius).toBeGreaterThanOrEqual(geometry.innerRadius);
      expect(farthestRadius).toBeLessThanOrEqual(geometry.innerOuterRadius);
    };
    expectLabelInsideRing(fullLabel);

    const valueOnlyLabel = getInnerDonutLabelLayout({
      cx: geometry.centerX,
      cy: geometry.centerY,
      midAngle: 45,
      percent: 0.12,
      innerRadius: geometry.innerRadius,
      outerRadius: geometry.innerOuterRadius,
    });
    expect(valueOnlyLabel.mode).toBe('value-only');
    expectLabelInsideRing(valueOnlyLabel);
    expect(
      getInnerDonutLabelLayout({
        cx: geometry.centerX,
        cy: geometry.centerY,
        midAngle: 45,
        percent: 0.05,
        innerRadius: geometry.innerRadius,
        outerRadius: geometry.innerOuterRadius,
      }).mode,
    ).toBe('hidden');
  });

  it('compresses a long inner-ring count to the available pill width', () => {
    const geometry = Reflect.get(chartLayout, 'RISK_DONUT_GEOMETRY') as
      | RiskDonutGeometry
      | undefined;
    const getInnerDonutLabelLayout = Reflect.get(
      chartLayout,
      'getInnerDonutLabelLayout',
    ) as
      | ((input: {
          cx: number;
          cy: number;
          midAngle: number;
          percent: number;
          innerRadius: number;
          outerRadius: number;
          valueText: string;
        }) => InnerDonutLabelLayout)
      | undefined;

    expect(geometry).toEqual(expect.any(Object));
    expect(getInnerDonutLabelLayout).toEqual(expect.any(Function));
    if (!geometry || !getInnerDonutLabelLayout) return;

    const longCount = getInnerDonutLabelLayout({
      cx: geometry.centerX,
      cy: geometry.centerY,
      midAngle: 45,
      percent: 0.75,
      innerRadius: geometry.innerRadius,
      outerRadius: geometry.innerOuterRadius,
      valueText: '123456789012',
    });
    expect(longCount.valueTextLength).toEqual(expect.any(Number));
    expect(longCount.valueTextLength).toBeGreaterThan(0);
    expect(longCount.valueTextLength).toBeLessThanOrEqual(longCount.width - 8);

    const shortCount = getInnerDonutLabelLayout({
      cx: geometry.centerX,
      cy: geometry.centerY,
      midAngle: 45,
      percent: 0.75,
      innerRadius: geometry.innerRadius,
      outerRadius: geometry.innerOuterRadius,
      valueText: '7',
    });
    expect(shortCount.valueTextLength).toBeUndefined();
  });

  it('applies the inner-ring count compression in both rendered label modes', () => {
    const pageSource = readFileSync(
      'client/src/pages/RiskInspectionDashboard/index.tsx',
      'utf8',
    );

    expect(pageSource).toContain('valueText: String(item.value),');
    expect(
      pageSource.match(/textLength=\{layout\.valueTextLength\}/g) ?? [],
    ).toHaveLength(2);
  });

  it('derives a stable segment index from the risk key', () => {
    expect(getStableDonutLabelIndex('low', 9)).toBe(0);
    expect(getStableDonutLabelIndex('ultra-low', 9)).toBe(1);
    expect(getStableDonutLabelIndex('medium', 9)).toBe(2);
    expect(getStableDonutLabelIndex('high', 9)).toBe(3);
    expect(getStableDonutLabelIndex('unknown', 9)).toBe(4);
    expect(getStableDonutLabelIndex('低风险', 9)).toBe(0);
    expect(getStableDonutLabelIndex('超低风险', 9)).toBe(1);
    expect(getStableDonutLabelIndex('中风险', 9)).toBe(2);
    expect(getStableDonutLabelIndex('custom', 9)).toBe(9);
  });

  it.each([
    [0, 1],
    [1, 1],
    [2, 1],
    [3, -1],
    [4, 1],
  ] as const)(
    'assigns top semantic index %i to a safe side and label rail',
    (index, direction) => {
      const layout = getTopClusterLayout(index);
      const labelBounds = Reflect.get(layout, 'labelBounds') as
        | { left: number; right: number; top: number; bottom: number }
        | undefined;

      expect(layout.direction).toBe(direction);
      expect(layout.textX).toBeGreaterThanOrEqual(8);
      expect(layout.textX).toBeLessThanOrEqual(412);
      expect(layout.labelY).toBeGreaterThanOrEqual(8);
      expect(layout.labelY).toBeLessThanOrEqual(268);
      expect(
        Math.hypot(layout.startX - 210, layout.startY - 138),
      ).toBeGreaterThanOrEqual(110);
      expect(labelBounds).toEqual(expect.any(Object));
      if (labelBounds) {
        expect(labelBounds.left).toBeGreaterThanOrEqual(8);
        expect(labelBounds.right).toBeLessThanOrEqual(412);
        expect(labelBounds.top).toBeGreaterThanOrEqual(8);
        expect(labelBounds.bottom).toBeLessThanOrEqual(268);
      }
    },
  );

  it.each([
    [1, 4],
    [2, 4],
  ] as const)(
    'separates same-side top indices %i and %i by at least one label row',
    (firstIndex, secondIndex) => {
      const first = getTopClusterLayout(firstIndex);
      const second = getTopClusterLayout(secondIndex);

      expect(first.direction).toBe(second.direction);
      expect(Math.abs(first.labelY - second.labelY)).toBeGreaterThanOrEqual(16);
    },
  );

  it('separates low and medium labels when their top anchors share the same x', () => {
    const low = getOuterDonutLabelLayout({
      cx: 160,
      cy: 124,
      midAngle: 88,
      outerRadius: 110,
      index: 0,
    });
    const medium = getOuterDonutLabelLayout({
      cx: 160,
      cy: 124,
      midAngle: 88,
      outerRadius: 110,
      index: 2,
    });

    expect(low.startX).toBeCloseTo(medium.startX);
    expect(low.direction).toBe(medium.direction);
    expect(Math.abs(low.labelY - medium.labelY)).toBeGreaterThanOrEqual(16);
  });

  it.each(TOP_CLUSTER_INDEX_PAIRS)(
    'keeps top semantic indices %i and %i from sharing a label slot',
    (firstIndex, secondIndex) => {
      const first = getTopClusterLayout(firstIndex);
      const second = getTopClusterLayout(secondIndex);

      if (first.direction === second.direction) {
        expect(Math.abs(first.labelY - second.labelY)).toBeGreaterThanOrEqual(
          16,
        );
      } else {
        expect(Math.abs(first.textX - second.textX)).toBeGreaterThanOrEqual(80);
      }
    },
  );

  it('keeps real sorted severity labels from sharing a same-side rail', () => {
    const geometry = Reflect.get(chartLayout, 'RISK_DONUT_GEOMETRY') as
      | RiskDonutGeometry
      | undefined;
    expect(geometry).toEqual(expect.any(Object));
    if (!geometry) return;

    const realSeverityValues = [
      { key: 'low', label: '低风险', value: 54 },
      { key: 'ultra-low', label: '超低风险', value: 93 },
      { key: 'medium', label: '中风险', value: 9 },
      { key: 'high', label: '高风险', value: 41 },
      { key: 'unknown', label: '未知风险', value: 17 },
    ].sort((left, right) => right.value - left.value);
    const total = realSeverityValues.reduce((sum, { value }) => sum + value, 0);
    const layouts = getRechartsEquivalentMidAngles(realSeverityValues).map(
      (item) => ({
        item,
        layout: getOuterDonutLabelLayout({
          cx: geometry.centerX,
          cy: geometry.centerY,
          midAngle: item.midAngle,
          outerRadius: geometry.outerRadius,
          index: getStableDonutLabelIndex(item.key, 0),
          labelText: `${item.label} ${item.value} · ${(
            (item.value / total) *
            100
          ).toFixed(1)}%`,
        }),
      }),
    );
    const medium = layouts.find(({ item }) => item.key === 'medium');
    const high = layouts.find(({ item }) => item.key === 'high');

    expect(medium?.layout.direction).toBe(high?.layout.direction);
    expect(Math.sign((medium?.layout.labelY ?? 0) - geometry.centerY)).toBe(
      Math.sign((high?.layout.labelY ?? 0) - geometry.centerY),
    );

    for (let firstIndex = 0; firstIndex < layouts.length; firstIndex += 1) {
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < layouts.length;
        secondIndex += 1
      ) {
        const first = layouts[firstIndex].layout;
        const second = layouts[secondIndex].layout;
        if (first.direction !== second.direction) continue;

        const intersects =
          first.labelBounds.left < second.labelBounds.right + 4 &&
          first.labelBounds.right + 4 > second.labelBounds.left &&
          first.labelBounds.top < second.labelBounds.bottom + 4 &&
          first.labelBounds.bottom + 4 > second.labelBounds.top;
        expect(intersects).toBe(false);
      }
    }
  });

  it.each(TOP_CLUSTER_INDEX_PAIRS)(
    'keeps outer label bounds for indices %i and %i from intersecting',
    (firstIndex, secondIndex) => {
      const firstBounds = Reflect.get(
        getTopClusterLayout(firstIndex),
        'labelBounds',
      ) as { left: number; right: number; top: number; bottom: number };
      const secondBounds = Reflect.get(
        getTopClusterLayout(secondIndex),
        'labelBounds',
      ) as { left: number; right: number; top: number; bottom: number };

      expect(firstBounds).toEqual(expect.any(Object));
      expect(secondBounds).toEqual(expect.any(Object));
      if (!firstBounds || !secondBounds) return;

      const intersects =
        firstBounds.left < secondBounds.right + 4 &&
        firstBounds.right + 4 > secondBounds.left &&
        firstBounds.top < secondBounds.bottom + 4 &&
        firstBounds.bottom + 4 > secondBounds.top;
      expect(intersects).toBe(false);
    },
  );

  it.each([
    [30, 2, 1],
    [150, 0, -1],
  ] as const)(
    'uses real mid-angle %i to choose the side for ordinary semantic index %i',
    (midAngle, index, expectedDirection) => {
      const layout = getOuterDonutLabelLayout({
        cx: 176,
        cy: 138,
        midAngle,
        outerRadius: 106,
        index,
      });

      expect(layout.direction).toBe(expectedDirection);
    },
  );

  it('pins the ultra-low-risk semantic label to the upper-right rail', () => {
    const layout = getOuterDonutLabelLayout({
      cx: 176,
      cy: 138,
      midAngle: 30,
      outerRadius: 106,
      index: 1,
    });

    expect(layout.direction).toBe(1);
    expect(layout.labelBounds.left).toBeGreaterThan(176);
    expect(layout.labelY).toBeLessThan(138);
  });

  it.each([
    [30, 1],
    [-170, 0],
    [-92, 1],
    [-45, 2],
    [0, 3],
    [45, 4],
    [88, 4],
    [92, 4],
    [170, 0],
  ] as const)(
    'routes mid-angle %i leader orthogonally outside the outer ring',
    (midAngle, index) => {
      const geometry = Reflect.get(chartLayout, 'RISK_DONUT_GEOMETRY') as
        | RiskDonutGeometry
        | undefined;
      expect(geometry).toEqual(expect.any(Object));
      if (!geometry) return;

      const layout = getOuterDonutLabelLayout({
        cx: geometry.centerX,
        cy: geometry.centerY,
        midAngle,
        outerRadius: geometry.outerRadius,
        index,
        labelText: '超低风险 189 · 92.6%',
      }) as RoutedOuterDonutLabelLayout;
      const points = [
        { x: layout.startX, y: layout.startY },
        { x: layout.bendX, y: layout.bendY },
        { x: layout.middleX, y: layout.middleY },
        { x: layout.endX, y: layout.endY },
      ];

      for (const point of points) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
      }
      for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
        const start = points[pointIndex - 1];
        const end = points[pointIndex];

        expect(start.x === end.x || start.y === end.y).toBe(true);
        expect(
          distanceToSegment(geometry.centerX, geometry.centerY, start, end),
        ).toBeGreaterThan(geometry.outerRadius);
      }
      for (const point of points.slice(1)) {
        expect(
          Math.hypot(point.x - geometry.centerX, point.y - geometry.centerY),
        ).toBeGreaterThan(geometry.outerRadius);
      }
      expect(layout.labelBounds.left).toBeGreaterThanOrEqual(8);
      expect(layout.labelBounds.right).toBeLessThanOrEqual(geometry.width - 8);
      expect(layout.labelBounds.top).toBeGreaterThanOrEqual(8);
      expect(layout.labelBounds.bottom).toBeLessThanOrEqual(
        geometry.height - 8,
      );
    },
  );

  it('uses the rendered long-label width for its collision bounds', () => {
    const layoutFunction = Reflect.get(
      chartLayout,
      'getOuterDonutLabelLayout',
    ) as
      | ((input: {
          cx: number;
          cy: number;
          midAngle: number;
          outerRadius: number;
          index: number;
          labelText: string;
        }) => OuterDonutLabelLayout & { labelWidth: number })
      | undefined;

    expect(layoutFunction).toEqual(expect.any(Function));
    if (!layoutFunction) return;

    const layout = layoutFunction({
      cx: 210,
      cy: 138,
      midAngle: 88,
      outerRadius: 106,
      index: 2,
      labelText: '超低风险 189 · 92.6%',
    });

    expect(layout.labelWidth).toBeGreaterThan(76);
    expect(layout.labelWidth).toBeLessThanOrEqual(96);
    expect(layout.labelBounds.right - layout.labelBounds.left).toBe(
      layout.labelWidth,
    );
    expect(layout.labelBounds.left).toBeGreaterThanOrEqual(8);
    expect(layout.labelBounds.right).toBeLessThanOrEqual(412);
  });

  it('keeps ordinary side labels aligned with their natural direction', () => {
    const rightLabel = getOuterDonutLabelLayout({
      cx: 150,
      cy: 116,
      midAngle: -30,
      outerRadius: 106,
      index: 0,
    });

    expect(rightLabel.direction).toBe(1);
    expect(rightLabel.labelY).toBeGreaterThan(116);
  });

  it('formats a 2026 weekly trend as week number and date range', () => {
    expect(formatRiskTrendPeriod('6/15', '2026-07')).toEqual({
      yearLabel: '26年',
      weekLabel: '第25周',
      rangeLabel: '06/15–06/21',
    });
  });

  it('resolves a December period against a January dashboard month', () => {
    expect(formatRiskTrendPeriod('12/29', '2026-01')).toEqual({
      yearLabel: '26年',
      weekLabel: '第1周',
      rangeLabel: '12/29–01/04',
    });
  });
});

describe('risk inspection donut semantic colors', () => {
  it('maps every severity key to its stable semantic color', () => {
    const getSeverityColor = getColorResolver('getSeverityColor');
    const cases = [
      ['high', '#7c8cf8'],
      ['medium', '#b7d8ff'],
      ['low', '#1677ff'],
      ['ultra-low', '#69b1ff'],
      ['unknown', '#cbd5e1'],
    ] as const;

    expect(getSeverityColor).toEqual(expect.any(Function));
    for (const [key, expectedColor] of cases) {
      expect(getSeverityColor?.({ key, label: key }, 99)).toBe(expectedColor);
    }
  });

  it('maps every status key to its stable semantic color', () => {
    const getStatusColor = getColorResolver('getStatusColor');
    const cases = [
      ['completed', '#30c7a4'],
      ['rectifying', '#ffb84d'],
      ['suspended', '#5b8ff9'],
      ['unknown', '#9b8afb'],
    ] as const;

    expect(getStatusColor).toEqual(expect.any(Function));
    for (const [key, expectedColor] of cases) {
      expect(getStatusColor?.({ key, label: key }, 99)).toBe(expectedColor);
    }
  });

  it('preserves status colors after zero-value categories are filtered', () => {
    const getStatusColor = getColorResolver('getStatusColor');
    const statuses = [
      { key: 'completed', label: '已完成', value: 0 },
      { key: 'rectifying', label: '整改中', value: 5 },
      { key: 'suspended', label: '已挂起', value: 0 },
      { key: 'unknown', label: '状态未知', value: 2 },
    ];
    const visibleStatuses = statuses.filter((item) => item.value > 0);

    expect(getStatusColor).toEqual(expect.any(Function));
    expect(
      visibleStatuses.map((item, index) => getStatusColor?.(item, index)),
    ).toEqual(['#ffb84d', '#9b8afb']);
  });
});

describe('risk inspection trend point label layout', () => {
  it('maps SVG point coordinates to overlay percentages', () => {
    const getTrendPointLabelLayout = Reflect.get(
      chartLayout,
      'getTrendPointLabelLayout',
    ) as
      | ((
          x: number,
          y: number,
          width?: number,
          height?: number,
        ) => { leftPercent: number; topPercent: number })
      | undefined;

    expect(getTrendPointLabelLayout).toEqual(expect.any(Function));
    expect(getTrendPointLabelLayout?.(210, 90)).toEqual({
      leftPercent: 50,
      topPercent: 50,
    });
    expect(getTrendPointLabelLayout?.(100, 30, 200, 120)).toEqual({
      leftPercent: 50,
      topPercent: 25,
    });
  });
});
