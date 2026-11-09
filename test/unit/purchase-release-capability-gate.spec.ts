import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, realpathSync, unlinkSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const {verifyPurchaseLedgerCompatibility:verify}=require('../../scripts/verify-purchase-ledger-compatibility.cjs');

describe('purchase runtime capability release and rollback gate',()=>{
  const repo=resolve(__dirname,'../..'),capability='purchase-workflow-ledger-v1';
  let root:string,ledger:string,dist:string;
  const json=(file:string,value:unknown)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value));};
  const original=()=>({version:2,commands:[],reminders:['historical-reminder:fixture-one'],notifications:[],managerApprovalBatches:[]});
  const marked=()=>({...original(),requiredRuntimeCapability:capability});
  const declare=(runtime:string)=>json(join(runtime,'server/common/purchase-runtime-capabilities.json'),{schemaVersion:1,capabilities:[capability]});
  const check=(runtime=dist)=>verify({appRoot:root,runtimeDist:runtime,ledgerPath:ledger});
  beforeEach(()=>{root=mkdtempSync(join(realpathSync(tmpdir()),'purchase-capability-gate-'));ledger=join(root,'.runtime/purchase-workflow-ledger.json');dist=join(root,'dist');mkdirSync(dist);});
  afterEach(()=>{if(dirname(resolve(root))!==realpathSync(tmpdir())||!basename(root).startsWith('purchase-capability-gate-'))throw Error('fixture ownership mismatch');rmSync(root,{recursive:true,force:true});});

  it('keeps valid legacy and first-use behaviour without requiring a new capability file',()=>{
    expect(check().compatible).toBe(true);json(ledger,original());expect(check().requiredCapability).toBeNull();
    json(ledger,{...original(),notifications:[{webReceipt:{actor:{openId:'ou_legacy'}}}]});expect(check().compatible).toBe(true);
    expect(check().runtimeCapability).toBeNull();declare(dist);expect(check().runtimeCapability).toBe(capability);
  });
  it('accepts non-empty historical string reminders without requiring a new runtime capability',()=>{
    for(const version of [1,2]) {
      json(ledger,{...original(),version,reminders:['old-reminder:first','old-reminder:second']});
      expect(check()).toEqual({compatible:true,requiredCapability:null,runtimeCapability:null});
    }
  });
  it.each([{reminders:[{}]},{reminders:[null]},{reminders:[42]},{reminders:['valid-reminder',{}]}])('rejects reminders containing a non-string value: %j',({reminders})=>{
    json(ledger,{...original(),reminders});expect(()=>check()).toThrow('PURCHASE_LEDGER_INVALID');
  });
  it('rejects invalid JSON, invalid ledger structure and unknown capability instead of treating them as absent',()=>{
    json(ledger,{});expect(()=>check()).toThrow('PURCHASE_LEDGER_INVALID');
    json(ledger,{...original(),commands:[null]});expect(()=>check()).toThrow('PURCHASE_LEDGER_INVALID');
    json(ledger,{...original(),lifecycleReceiptImageLedger:{tasks:''}});expect(()=>check()).toThrow('PURCHASE_LEDGER_INVALID');
    writeFileSync(ledger,'{broken');expect(()=>check()).toThrow('PURCHASE_COMPATIBILITY_INVALID_JSON');
    json(ledger,{...marked(),requiredRuntimeCapability:'future-capability'});declare(dist);expect(()=>check()).toThrow('PURCHASE_LEDGER_CAPABILITY_UNKNOWN');
  });
  it.each([{platformLegacyApprovalClaims:[{}]},{lifecycleReceiptImageSource:{}},{commands:[{platformIdentity:{}}]},{notifications:[{webReceipt:{platformIdentity:{}}}]},{managerApprovalBatches:[{flowVersion:'lifecycle_v1'}]}])('rejects unmarked new data %j',extra=>{
    json(ledger,{...original(),...extra});expect(()=>check()).toThrow('PURCHASE_LEDGER_CAPABILITY_MARKER_MISSING');
  });
  it('rejects the old runtime and accepts only a capability-aware candidate or rollback snapshot',()=>{
    json(ledger,marked());expect(()=>check()).toThrow();
    json(join(dist,'server/common/purchase-runtime-capabilities.json'),{schemaVersion:1,capabilities:[]});expect(()=>check()).toThrow('PURCHASE_LEDGER_RUNTIME_INCOMPATIBLE');
    declare(dist);expect(check().compatible).toBe(true);
    const rollback=join(root,'dist.rollback.release-one');declare(rollback);expect(check(rollback).compatible).toBe(true);
    expect(()=>check(join(root,'../another-project/dist'))).toThrow('PURCHASE_COMPATIBILITY_RUNTIME_OUTSIDE_ROOT');
  });

  const quote=(value:string)=>"'"+value.replace(/'/g,"''")+"'";
  function powershell(code:string){
    const script=join(root,'gate-harness.ps1');writeFileSync(script,"$ErrorActionPreference='Stop'\n"+code);
    const exe=join(process.env.ProgramFiles||'C:/Program Files','PowerShell/7/pwsh.exe');
    return spawnSync(exe,['-NoProfile','-NonInteractive','-File',script],{encoding:'utf8',timeout:30_000,windowsHide:true});
  }
  const stopMarker=()=>join(root,'stop-was-called');
  it('rejects an old rollback runtime before stopping when separate-stage cutover data exists',()=>{
    setupHelper();
    const migrated={...marked(),requiredRuntimeCapability:'purchase-stage-cards-v1',managerApprovalBatches:[{flowVersion:'legacy',stageCardTransition:{version:1}}]};
    json(ledger,migrated);declare(dist);
    expect(()=>check()).toThrow('PURCHASE_LEDGER_RUNTIME_INCOMPATIBLE');
    const helper=join(root,'scripts/verify-purchase-ledger-compatibility.cjs');
    const script=`& ${quote(process.execPath)} ${quote(helper)} --app-root ${quote(root)} --runtime-dist ${quote(dist)} --ledger ${quote(ledger)}\nif ($LASTEXITCODE -ne 0) { throw 'incompatible-runtime' }\nSet-Content -LiteralPath ${quote(stopMarker())} -Value stopped\n`;
    const refused=powershell(script);expect(refused.status).not.toBe(0);expect(existsSync(stopMarker())).toBe(false);
    json(join(dist,'server/common/purchase-runtime-capabilities.json'),{schemaVersion:1,capabilities:[capability,'purchase-stage-cards-v1']});
    const allowed=powershell(script);expect(allowed.status).toBe(0);expect(existsSync(stopMarker())).toBe(true);
    expect(check()).toEqual({compatible:true,requiredCapability:'purchase-stage-cards-v1',runtimeCapability:capability});
    json(ledger,{...migrated,requiredRuntimeCapability:capability});
    expect(()=>check()).toThrow('PURCHASE_LEDGER_CAPABILITY_MARKER_MISSING');
  });
  function setupHelper(){mkdirSync(join(root,'scripts'),{recursive:true});copyFileSync(join(repo,'scripts/verify-purchase-ledger-compatibility.cjs'),join(root,'scripts/verify-purchase-ledger-compatibility.cjs'));}
  it.each(['start.ps1','deploy/start.ps1'])('%s refuses before the first process stop, and starts with the supported runtime',file=>{
    setupHelper();json(ledger,marked());
    const source=readFileSync(join(repo,file),'utf8'),begin=source.indexOf('# PURCHASE_LEDGER_COMPATIBILITY_GATE_BEGIN'),end=source.indexOf('# PURCHASE_LEDGER_COMPATIBILITY_GATE_END')+'# PURCHASE_LEDGER_COMPATIBILITY_GATE_END'.length;
    expect(begin).toBeGreaterThan(0);expect(end).toBeLessThanOrEqual(source.indexOf('\nStop-PidFileProcess -PidFile'));
    const script=`$appRoot=${quote(root)}\n$nodePath=${quote(process.execPath)}\n$envFile=${quote(join(root,'.env'))}\n$envLocalFile=${quote(join(root,'.env.local'))}\n$env:PURCHASE_WORKFLOW_LEDGER_PATH=${quote(ledger)}\nfunction Get-DotEnvValue { param($FilePath,$Name,$DefaultValue) return $DefaultValue }\n${source.slice(begin,end)}\nSet-Content -LiteralPath ${quote(stopMarker())} -Value stopped\n`;
    const withProofCheck=script+`Set-Content -LiteralPath ${quote(join(root,'proof'))} -Value ([string]$env:PURCHASE_LEDGER_RUNTIME_CAPABILITY)\n`;
    const refused=powershell(withProofCheck);expect(refused.error).toBeUndefined();expect(refused.status).not.toBe(0);expect(existsSync(stopMarker())).toBe(false);
    declare(dist);const allowed=powershell(withProofCheck);expect(allowed.error).toBeUndefined();expect(allowed.status).toBe(0);expect(existsSync(stopMarker())).toBe(true);
    expect(readFileSync(join(root,'proof'),'utf8').trim()).toBe(capability);
    json(ledger,original());unlinkSync(join(dist,'server/common/purchase-runtime-capabilities.json'));
    const legacy=powershell(`$env:PURCHASE_LEDGER_RUNTIME_CAPABILITY=${quote(capability)}\n`+withProofCheck);expect(legacy.status).toBe(0);
    expect(readFileSync(join(root,'proof'),'utf8').trim()).toBe('');
    expect(source.slice(end)).toContain('Confirm-PurchaseRuntimeStartupCapability\n');
  });
  it('uses the same gate before installation stop and before restoring or starting rollback bytes',()=>{
    const source=readFileSync(join(repo,'scripts/create-safe-full-runtime-hotfix-package.ps1'),'utf8');
    expect(source).toContain("'scripts/verify-purchase-ledger-compatibility.cjs' = 'scripts/verify-purchase-ledger-compatibility.cjs'");
    const start=source.indexOf('function Assert-PurchaseLedgerRuntimeCompatibility {'),end=source.indexOf('function Invoke-CandidateStartupConfigurationPreflight {',start);
    const normal=source.slice(source.indexOf('$preStopDependencyProofReport ='));
    expect(normal.indexOf('Assert-PurchaseLedgerRuntimeCompatibility -Root $appRootPath -RuntimeDist $stageDist')).toBeLessThan(normal.indexOf('Stop-AppProcesses -Root $appRootPath'));
    const rollback=source.slice(source.indexOf('function Rollback-UncommittedHotfixTransaction {'),source.indexOf('function Assert-CommittedRuntimeFiles {'));
    expect(rollback.indexOf('Assert-PurchaseLedgerRuntimeCompatibility -Root $Root -RuntimeDist $rollbackRuntime')).toBeLessThan(rollback.indexOf('Stop-AppProcesses'));
    const recovered=source.slice(source.indexOf('function Start-RecoveredRuntime {'),source.indexOf('function Try-CompleteAlreadyRestoredHealthyRollback {'));
    expect(recovered.indexOf('Assert-PurchaseLedgerRuntimeCompatibility')).toBeLessThan(recovered.indexOf('$launcher = Start-App'));
    const launch=source.slice(source.indexOf('function Start-App {'),source.indexOf('function Start-App {')+8000);
    expect(launch.indexOf('Assert-PurchaseLedgerRuntimeCompatibility -Root $Root')).toBeLessThan(launch.indexOf('$process.Start()'));
    expect(launch).toContain("EnvironmentVariables.Remove('PURCHASE_LEDGER_RUNTIME_CAPABILITY')");
    expect(launch).toContain("$startInfo.EnvironmentVariables['PURCHASE_LEDGER_RUNTIME_CAPABILITY'] = $purchaseStartupProof.runtimeCapability");
    setupHelper();json(ledger,marked());
    const script=`function Get-TrustedHotfixNodeExecutable { param($Root) return ${quote(process.execPath)} }\nfunction Get-ConfiguredValue { param($Root,$Name,$DefaultValue) return ${quote(ledger)} }\n${source.slice(start,end)}\nAssert-PurchaseLedgerRuntimeCompatibility -Root ${quote(root)} -RuntimeDist ${quote(dist)} -VerifierPath ${quote(join(root,'scripts/verify-purchase-ledger-compatibility.cjs'))}\nSet-Content -LiteralPath ${quote(stopMarker())} -Value stopped\n`;
    const refused=powershell(script);expect(refused.error).toBeUndefined();expect(refused.status).not.toBe(0);expect(existsSync(stopMarker())).toBe(false);
    declare(dist);const allowed=powershell(script);expect(allowed.error).toBeUndefined();expect(allowed.status).toBe(0);expect(existsSync(stopMarker())).toBe(true);
  });
});
