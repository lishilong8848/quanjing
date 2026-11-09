'use strict';
const fs = require('node:fs');
const path = require('node:path');

const CAPABILITY = 'purchase-workflow-ledger-v1';
const STAGE_CARDS_CAPABILITY = 'purchase-stage-cards-v1';
function fail(code) { throw Object.assign(new Error(code), { code }); }
function ordinaryPath(file) {
  let cursor = path.resolve(file);
  while (true) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('PURCHASE_COMPATIBILITY_LINK'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function readJson(file, optional) {
  ordinaryPath(file);
  let fd;
  try {
    fd=fs.openSync(file,'r');const before=fs.fstatSync(fd);
    if(!before.isFile() || before.size>64*1024*1024)fail('PURCHASE_COMPATIBILITY_INVALID_FILE');
    const bytes=fs.readFileSync(fd);const after=fs.fstatSync(fd);
    if(before.size!==after.size || before.mtimeMs!==after.mtimeMs)fail('PURCHASE_COMPATIBILITY_CHANGED');
    const value=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
    if(!value || typeof value!=='object' || Array.isArray(value))fail('PURCHASE_COMPATIBILITY_INVALID_JSON');
    return value;
  } catch(error) {
    if(error.code==='ENOENT' && optional)return null;
    if(error instanceof SyntaxError)fail('PURCHASE_COMPATIBILITY_INVALID_JSON');
    throw error;
  } finally {if(fd!==undefined)fs.closeSync(fd);}
}
function verifyPurchaseLedgerCompatibility({appRoot,runtimeDist,ledgerPath}) {
  if(!appRoot||!runtimeDist||!ledgerPath)fail('PURCHASE_COMPATIBILITY_ARGUMENTS');
  const root=path.resolve(appRoot),runtime=path.resolve(root,runtimeDist),relative=path.relative(root,runtime);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))fail('PURCHASE_COMPATIBILITY_RUNTIME_OUTSIDE_ROOT');
  ordinaryPath(root);ordinaryPath(runtime);
  const capabilities=readJson(path.join(runtime,'server/common/purchase-runtime-capabilities.json'),true);
  if(capabilities&&(capabilities.schemaVersion!==1||!Array.isArray(capabilities.capabilities)||capabilities.capabilities.some(x=>typeof x!=='string')))fail('PURCHASE_LEDGER_RUNTIME_INCOMPATIBLE');
  const runtimeCapability=capabilities?.capabilities.includes(CAPABILITY)?CAPABILITY:null;
  const ledger=readJson(path.resolve(root,ledgerPath),true);
  if(!ledger)return {compatible:true,requiredCapability:null,runtimeCapability};
  if(![1,2].includes(ledger.version)||!Array.isArray(ledger.commands)||!Array.isArray(ledger.reminders))fail('PURCHASE_LEDGER_INVALID');
  // The workflow store persists reminder deduplication keys as strings, not records.
  if(ledger.reminders.some(reminder=>typeof reminder!=='string'))fail('PURCHASE_LEDGER_INVALID');
  const arrays=['platformApprovalClaims','platformApprovalWork','platformLegacyApprovalClaims','lifecycleOutbox','lifecycleFormCredentials','lifecyclePaymentUploads','lifecyclePaymentBlocks'];
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  for(const name of ['commands','notifications','cardActions','managerApprovalActions','managerApprovalCards','managerApprovalBatches','managerApprovalBatchActions',...arrays]) {
    if(ledger[name]!==undefined&&(!Array.isArray(ledger[name])||ledger[name].some(row=>!object(row))))fail('PURCHASE_LEDGER_INVALID');
  }
  if(ledger.lifecycleReceiptPrepareQueue!==undefined&&(!object(ledger.lifecycleReceiptPrepareQueue)||!Array.isArray(ledger.lifecycleReceiptPrepareQueue.tasks)))fail('PURCHASE_LEDGER_INVALID');
  if(ledger.lifecycleReceiptImageLedger!==undefined&&(!object(ledger.lifecycleReceiptImageLedger)||!Array.isArray(ledger.lifecycleReceiptImageLedger.tasks)||!Array.isArray(ledger.lifecycleReceiptImageLedger.intents)))fail('PURCHASE_LEDGER_INVALID');
  const required=ledger.requiredRuntimeCapability;
  const hasStageCardTransition=(ledger.managerApprovalBatches||[]).some(row=>row.stageCardTransition!==undefined);
  if(hasStageCardTransition && required!==STAGE_CARDS_CAPABILITY)fail('PURCHASE_LEDGER_CAPABILITY_MARKER_MISSING');
  if(required===undefined){
    const hasNewData=ledger.lifecycleReceiptImageSource!==undefined||arrays.some(key=>ledger[key]?.length>0)||
      (ledger.managerApprovalBatches||[]).some(row=>row?.flowVersion==='lifecycle_v1')||
      ledger.commands.some(row=>row?.platformIdentity!==undefined)||
      (ledger.notifications||[]).some(row=>row?.webReceipt?.platformIdentity!==undefined)||
      (ledger.lifecycleReceiptPrepareQueue?.tasks?.length||0)>0||
      (ledger.lifecycleReceiptImageLedger?.tasks?.length||0)>0||
      (ledger.lifecycleReceiptImageLedger?.intents?.length||0)>0;
    if(hasNewData)fail('PURCHASE_LEDGER_CAPABILITY_MARKER_MISSING');
    return {compatible:true,requiredCapability:null,runtimeCapability};
  }
  if(required!==CAPABILITY && required!==STAGE_CARDS_CAPABILITY)fail('PURCHASE_LEDGER_CAPABILITY_UNKNOWN');
  if(runtimeCapability!==CAPABILITY || !capabilities.capabilities.includes(required))fail('PURCHASE_LEDGER_RUNTIME_INCOMPATIBLE');
  return {compatible:true,requiredCapability:required,runtimeCapability};
}
module.exports={verifyPurchaseLedgerCompatibility};
if(require.main===module){
  try {
    const args=process.argv.slice(2),values={};
    if(args.length!==6)fail('PURCHASE_COMPATIBILITY_ARGUMENTS');
    for(let i=0;i<args.length;i+=2){if(!['--app-root','--runtime-dist','--ledger'].includes(args[i])||Object.hasOwn(values,args[i]))fail('PURCHASE_COMPATIBILITY_ARGUMENTS');values[args[i]]=args[i+1];}
    const result=verifyPurchaseLedgerCompatibility({appRoot:values['--app-root'],runtimeDist:values['--runtime-dist'],ledgerPath:values['--ledger']});
    process.stdout.write(JSON.stringify(result)+'\n');
  }catch(error){process.stderr.write(String(error.code||'PURCHASE_COMPATIBILITY_FAILED')+'\n');process.exitCode=1;}
}
