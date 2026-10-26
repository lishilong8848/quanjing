const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const installProbe=require('./probe.cjs'),file=path.join(__dirname,'reopen-diagnostic.cjs'),text=fs.readFileSync(file,'utf8'),begin=text.indexOf('let probe=installProbe.toString();'),end=text.indexOf('const inputs=',begin);assert(begin>=0&&end>begin);
const corrected=new Function('installProbe','assert',text.slice(begin,end)+'return probe;')(installProbe,assert);
const incorrect=corrected.replaceAll('{(row.frameRequests ||= []).push(performance.now());requestAnimationFrame(frame);}','(row.frameRequests ||= []).push(performance.now());requestAnimationFrame(frame);');assert.notEqual(corrected,incorrect);
function examine(code){
 const queue=[],listeners={},target={disabled:false,textContent:'确认恢复',closest:()=>target};let clock=0;
 const environment={window:{},document:{documentElement:{},visibilityState:'visible',hasFocus:()=>true,querySelector:()=>target,addEventListener:(type,listener)=>listeners[type]=listener},performance:{now:()=>clock},MutationObserver:class{observe(){}disconnect(){}},queueMicrotask:callback=>callback(),requestAnimationFrame:callback=>queue.push(callback)};
 vm.runInNewContext('('+code+')()',environment);environment.window.__uiFeedback.arm({kind:'busy',expected:'正在提交'});
 listeners.pointerdown({target,isTrusted:true});target.disabled=true;target.textContent='正在提交…';listeners.pointerup({target,isTrusted:true});listeners.click({target,isTrusted:true});clock=5;queue.shift()(clock);const row=environment.window.__uiFeedback.rows[0];return{complete:row.complete,queuedAfterCompletion:queue.length,requests:row.frameRequests.length,callbacks:row.frames.length};
}
const negative=examine(incorrect),positive=examine(corrected);assert(negative.complete&&negative.queuedAfterCompletion===1);assert(positive.complete&&positive.queuedAfterCompletion===0&&positive.requests===positive.callbacks);
console.log(JSON.stringify({negative,positive,driverSha256:crypto.createHash('sha256').update(text).digest('hex'),limits:'Synthetic scheduler checks insertion semantics only, not browser performance'}));
