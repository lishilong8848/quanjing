import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WeatherWarningSnapshot } from '../shared/api.interface';
import {
  buildWeatherWarningCard,
  buildWeatherWarningResolvedCard,
} from '../server/modules/weather-warning/weather-warning-card';

const outputDirectory = resolve(process.cwd(), 'docs', 'qa');
const warning = {
  id: 'weather-warning-template-typhoon-blue',
  title: '南通市气象台发布台风蓝色预警',
  type: '台风',
  color: 'blue',
  guardLevel: '三级戒备',
  startTime: '2026-08-12T08:00:00+08:00',
  pubTime: '2026-08-12T08:05:00+08:00',
} as const;

const snapshot: WeatherWarningSnapshot = {
  status: 'active',
  sourceState: 'fresh',
  snapshotAt: '2026-08-12T08:10:00+08:00',
  lastSuccessAt: '2026-08-12T08:10:00+08:00',
  guardLevel: '三级戒备',
  guardDecisionState: 'fresh',
  matchedWarnings: [warning],
  unmatchedWarnings: [],
  actions: [
    '相关人员7*24 On call，通知相关设备供应商7*24 On call；',
    '现场团队进行内部预警通报；',
    '明确戒备期间相关人员，填写《重保戒备检查表-重保联络清单》，启动重保戒备检查并排查问题清零；',
    '明确戒备期间现场7*24岗值班人员排班信息，无特殊情况不得随意调换班或请假；',
    '清点应急储备物资，检查可用性并将问题清零；',
  ],
  weather: {
    temperature: '31',
    feelsLike: '34',
    humidity: '75',
    windDirection: '东风',
    windScale: '3级',
    observedAt: '2026-08-12T08:10:00+08:00',
  },
  checkSummary: {
    device: 'not_started',
    environment: 'not_required',
    disaster: 'not_started',
    materials: 'not_started',
    contacts: 'not_started',
    managerConfirmation: 'not_started',
    abnormalSummaries: [],
  },
  requiredCheckKeys: [
    'device',
    'disaster',
    'materials',
    'contacts',
    'managerConfirmation',
  ],
  checkSyncState: 'not_applicable',
  canSendTest: false,
};

const templates = [
  {
    fileName: 'weather-warning-feishu-initial-card.template.json',
    card: buildWeatherWarningCard({
      snapshot,
      testMessage: false,
      showProgress: false,
    }),
  },
  {
    fileName: 'weather-warning-feishu-resolved-card.template.json',
    card: buildWeatherWarningResolvedCard({
      warning,
      firstNotifiedAt: '2026-08-12T08:10:00+08:00',
      closedAt: '2026-08-12T14:20:00+08:00',
      highestGuardLevel: '三级戒备',
      testMessage: false,
    }),
  },
] as const;

mkdirSync(outputDirectory, { recursive: true });
for (const template of templates) {
  writeFileSync(
    resolve(outputDirectory, template.fileName),
    `${JSON.stringify(template.card, null, 2)}\n`,
    'utf8',
  );
}

process.stdout.write(
  `${templates.map((template) => template.fileName).join('\n')}\n`,
);
