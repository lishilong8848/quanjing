const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=process.cwd(), out=path.resolve('output/weekly-workbench-validation-20261009');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const base=JSON.parse(fs.readFileSync(path.join(out,'execution-proof.json')));
const updated=['client/src/pages/MeetingManagement/WeeklyWorkbench.tsx','client/src/pages/MeetingManagement/WeeklyGenerateDialog.tsx'];
const proof={startedAt:new Date().toISOString(),passed:false,baseProofSha256:sha(path.join(out,'execution-proof.json')),inputs:base.inputs.map(input=>({path:input.path,sha256:sha(input.path)})),executions:[]};
try {
 if(!base.passed)throw Error('原验证未通过');
 for(const input of base.inputs)if(!updated.includes(input.path)&&input.sha256!==sha(input.path))throw Error('复用证据失效：'+input.path);
 for(const [name,args] of [
 ['final-client-types',['node_modules/typescript/bin/tsc','--noEmit','--project','tsconfig.app.json']],
 ['final-client-lint',['node_modules/eslint/bin/eslint.js',...updated,'--rule','@darraghor/nestjs-typed/injectable-should-be-provided: off']],
 ['final-client-compile',['node_modules/@rspack/cli/bin/rspack.js','build','--config','test/helpers/meeting-browser.rspack.cjs']]]){
 const start=performance.now(); const result=spawnSync(process.execPath,args,{cwd:root,env:{...process.env,MEETING_BROWSER_MODE:'production'},encoding:'utf8',timeout:120000,windowsHide:true,maxBuffer:8*1024*1024});
 const log=path.join(out,name+'.log');fs.writeFileSync(log,(result.stdout||'')+'\n'+(result.stderr||''));
 proof.executions.push({name,seconds:(performance.now()-start)/1000,exitCode:result.status,args,logSha256:sha(log)});console.log(JSON.stringify(proof.executions.at(-1)));if(result.status!==0)throw Error(name+'失败');}
 for(const input of proof.inputs)if(input.sha256!==sha(input.path))throw Error('验证期间源码变化');
 proof.passed=true;
}catch(error){proof.error=error.message;console.error(error.message);process.exitCode=1;}finally{proof.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'final-client-proof.json'),JSON.stringify(proof,null,2));}
