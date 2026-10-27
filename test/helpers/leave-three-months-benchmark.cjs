// CPU-only candidate benchmark, using the existing synthetic fixture generator. No HTTP server is started.
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
const fixture=require('./leave-applicant-browser-fixture.cjs');
const {createLeaveRequestTimeCandidates}=require('../../shared/leave-request-impact');
const output=path.resolve(process.argv[2]||'output/leave-three-months-20261027/candidate-benchmark.json');
const results=[];
for(const total of [600,1800,6000]){
  const months=total===600?[10]:[9,10,11];fixture.configureScenario({rowsPerMonth:total/months.length});
  const records=months.flatMap(month=>fixture.schedulesFor(2026,month));
  assert.equal(records.length,total);const samples=[];
  for(let run=0;run<35;run++){
    const start=performance.now();const all=createLeaveRequestTimeCandidates(records,{leaveStaffName:fixture.names[0]});
    const end=createLeaveRequestTimeCandidates(records,{leaveStaffName:fixture.names[0],selectedStartAt:'2026-10-15T09:00'});
    const duration=performance.now()-start;if(run>=5)samples.push(duration);
    assert(all.startOptions.length>0&&end.endOptions.length>0);
  }
  samples.sort((a,b)=>a-b);results.push({rows:total,months:months.length,samples:samples.length,twoCandidateCalculationsMs:{p50:samples[14],p95:samples[28],max:samples.at(-1)}});
}
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({synthetic:true,node:process.version,method:'5 warm-ups then30 samples; each sample computes start candidates plus selected-start end candidates',results},null,2));console.log(JSON.stringify({output,results}));
