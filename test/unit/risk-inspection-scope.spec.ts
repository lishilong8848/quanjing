import { mapAliRiskInspectionDashboard } from '../../server/modules/risk-inspection/risk-inspection.mapper';

describe('risk inspection field-based scope', () => {
  it('excludes administrative on-site followers before every aggregate', () => {
    const names = ['姜嘉文','赵华','张建飞','苏峻荣','顾伟源','顾海鹏','尤新未'];
    const records = names.map((name, i) => ({record_id:String(i),fields:{'现场跟进人':name,'发现日期':'2026-10-01','风险状态':'整改中'}}));
    records.push({record_id:'keep',fields:{'现场跟进人':'示例人员009','发现日期':'2026-10-01','风险状态':'整改中'}});
    const result = mapAliRiskInspectionDashboard(records,{month:'2026-10',syncedAt:'2026-10-15',asOfDate:'2026-10-15'});
    expect(result.issues.map(x=>x.id)).toEqual(['keep']);
    expect(result.summary.historyTotal).toBe(1);
    expect(result.summary.monthlyAdded).toBe(1);
    expect(result.unresolvedIssues).toHaveLength(1);
    expect(result.severityDistribution.reduce((n,x)=>n+x.value,0)).toBe(1);
  });
  it('uses only on-site follower for exclusion, including multi-select, never substrings or other people fields', () => {
    const records = [
      {record_id:'multi',fields:{'现场跟进人':['示例人员009','赵华']}},
      {record_id:'other',fields:{'现场跟进人':'示例人员009','跟进人（飞书）':'赵华'}},
      {record_id:'partial',fields:{'现场跟进人':'赵华明'}},
      {record_id:'empty',fields:{'跟进人（飞书）':'赵华'}},
    ];
    const result=mapAliRiskInspectionDashboard(records,{month:'2026-10',syncedAt:'2026-10-15'});
    expect(result.issues.map(x=>x.id).sort()).toEqual(['empty','other','partial']);
    expect(result.issues.find(x=>x.id==='other')?.owner).toBe('示例人员009');
    expect(result.issues.find(x=>x.id==='empty')?.owner).toBe('—');
  });
});
