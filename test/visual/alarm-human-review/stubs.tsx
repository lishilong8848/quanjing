export function useAccess() { return { role: new URLSearchParams(location.search).get('role') || 'editor' }; }
export const snapshot = {
  window: { timeZone: 'Asia/Shanghai', startDate: '2026-09-27', endDateExclusive: '2026-10-04', yesterdayDate: '2026-10-02' },
  summary: { sevenDayTotal: 3, tagAnomalyTotal: 3, tagAnomalyByBuilding: [{ building: 'A楼', total: 3, byType: { missing: 1, vague: 2 } }], tagAnomalyByType: { missing: 1, format: 0, pending: 0, vague: 2, nonOfficial: 0, semantic: 0 } },
  options: { buildings: ['A楼', 'B楼'] },
  tagReview: { state: 'ready', connection: 'online', reviewed: 3, total: 3 },
  page: { page: 1, pageSize: 50, total: 3, totalPages: 1,
    items: ['recTESTA', 'recTESTB', 'recTESTC'].map((id, index) => ({ id, description: ['电池内阻过高报警（仅测试）', '蜂鸣器告警（仅测试）', '漏水检测告警（仅测试）'][index], building: index ? 'B楼' : 'A楼', level: '次要', expectation: 'unexpected', occurredAt: '2026-10-02T13:08:00+08:00', acceptedAt: '', handlingDescription: '现场查看', owner: '测试责任人', confirmationStatus: '已确认', handlingStatus: '已关闭', processingStatus: '已处理', recoveryStatus: '已恢复', createdAt: '2026-10-02T13:08:00+08:00', location: '测试电池室', alarmCategory: '测试', monitorObject: 'TEST-LEAK', acceptanceDescription: '人员已前往现场查看', confirmationDescription: '现场恢复', tagIssues: [{ code: index ? 'vague' : 'missing', side: 'acceptance', label: index ? '设备故障未说明原因' : '描述漏填', reason: '测试异常说明', source: 'rule' }] })) },
  sourceStatus: 'fresh', warnings: [],
};
export async function getTodayOperationsAlarmDashboard() { return snapshot; }
let loseFirstSubmit = new URLSearchParams(location.search).get('mode') === 'lost-response';
export async function axiosForBackend(config: { url: string; method: string; data?: unknown }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (loseFirstSubmit && config.method.toUpperCase() === 'POST' && config.url === '/api/bitable/alarm-human-reviews') {
    headers['x-fixture-response-lost'] = '1'; loseFirstSubmit = false;
  }
  const response = await fetch(config.url, { method: config.method, headers, body: config.data ? JSON.stringify(config.data) : undefined });
  const data = await response.json();
  if (!response.ok) throw { response: { data, status: response.status } };
  return { data };
}
