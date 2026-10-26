// Independent fixture only: no instrumentation is imported by the application.
export function installPerformanceProbe() {
  const samples: { name: string; category: string; elapsedMs: number; requests: number; ready: boolean; firstReadyMs: number; maxFrameGapMs: number; visibility: string; focused: boolean; longTasks: number[] }[] = [];
  const requests: { method: string; path: string }[] = [];
  const capturedEvents: { serial: number; eventName: string; name: string; timeStamp: number; capturedAt: number; trusted: boolean }[] = [];
  const eventTimings: { eventName: string; startTime: number; processingStart: number; processingEnd: number; duration: number; interactionId: number; capturedSerial: number | null; name: string | null; trusted: boolean | null; closedState: boolean }[] = [];
  const probeCosts = { publishCount:0, publishTotalMs:0, publishMaxMs:0, serializedBytes:0, observerCount:0, observerTotalMs:0, observerMaxMs:0 };
  const animationFrames: unknown[] = [];
  let filteredUnrelatedEvents = 0;
  let eventSerial = 0;
  for (const eventName of ['pointerdown','pointerup','click']) document.addEventListener(eventName, event => {
    const button = (event.target as Element)?.closest<HTMLButtonElement>('button');
    if (!button || button.disabled || button.dataset.probeExport === 'true') return;
    if (eventName === 'pointerdown') eventSerial += 1;
    capturedEvents.push({ serial: eventSerial, eventName, name: button.getAttribute('aria-label') || button.textContent?.trim() || '', timeStamp: event.timeStamp, capturedAt: performance.now(), trusted: event.isTrusted });
  }, true);
  const longTasks: PerformanceEntry[] = [];
  new PerformanceObserver(list => { longTasks.push(...list.getEntries()); }).observe({ type: 'longtask', buffered: true });
  const output = document.createElement('output');
  output.id = 'configuration-performance'; output.style.cssText = 'position:fixed;bottom:0;left:0;z-index:9999;background:#fff;color:#111;font:11px monospace;padding:2px;pointer-events:none'; document.body.append(output);
  output.textContent = 'Fixture performance ready';
  const control = document.createElement('button'); control.textContent = 'Fixture frame control'; control.style.cssText = 'position:fixed;bottom:0;right:0;z-index:9999;background:#fff;color:#111;font:11px monospace'; document.body.append(control);
  const exportButton = document.createElement('button'); exportButton.textContent = 'Export fixture measurements'; exportButton.dataset.probeExport='true'; exportButton.style.cssText='position:fixed;bottom:18px;right:0;z-index:9999;background:#fff;color:#111;font:11px monospace'; document.body.append(exportButton);
  const eventTimingSupported = PerformanceObserver.supportedEntryTypes.includes('event');
  const publish = () => { const start=performance.now(); output.dataset.count = String(samples.length); const elapsed=performance.now()-start; probeCosts.publishCount+=1;probeCosts.publishTotalMs+=elapsed;probeCosts.publishMaxMs=Math.max(probeCosts.publishMaxMs,elapsed); };
  const exportMeasurements = () => {const serialized=JSON.stringify({semantics:'DOM readiness plus two rAF is a conservative opportunity-to-paint proxy. Event Timing uses threshold16, 8ms rounding and actual trusted events; omitted entries are not zero. Only events pre-associated with captured pointerdown/up/click are stored. Collection stays in memory; this export is after the measured sequence.',samples,requests,eventTimingSupported,capturedEvents,eventTimings,probeCosts,animationFrames,filteredUnrelatedEvents});probeCosts.serializedBytes=serialized.length;output.dataset.result=serialized;};
  exportButton.addEventListener('click', exportMeasurements);
  if(PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'))new PerformanceObserver(list=>{
    for(const raw of list.getEntries()) { const entry=raw as PerformanceEntry & {blockingDuration:number;renderStart:number;styleAndLayoutStart:number;scripts:{duration:number;executionStart:number;forcedStyleAndLayoutDuration:number;invoker:string;sourceFunctionName:string}[]};animationFrames.push({startTime:entry.startTime,duration:entry.duration,blockingDuration:entry.blockingDuration,renderStart:entry.renderStart,styleAndLayoutStart:entry.styleAndLayoutStart,scripts:entry.scripts.map(script=>({duration:script.duration,executionStart:script.executionStart,forcedStyleAndLayoutDuration:script.forcedStyleAndLayoutDuration,invoker:script.invoker,sourceFunctionName:script.sourceFunctionName}))}); }
  }).observe({type:'long-animation-frame',buffered:true});
  if (eventTimingSupported) new PerformanceObserver(list => {
    const start=performance.now();
    for (const raw of list.getEntries()) {
      const entry = raw as PerformanceEventTiming;
      const captured = capturedEvents.find(event => event.eventName === entry.name && Math.abs(event.timeStamp-entry.startTime) <= 1);
      if (!captured) { filteredUnrelatedEvents += 1; continue; }
      eventTimings.push({ eventName:entry.name,startTime:entry.startTime,processingStart:entry.processingStart,processingEnd:entry.processingEnd,duration:entry.duration,interactionId:entry.interactionId,capturedSerial:captured?.serial ?? null,name:captured?.name ?? null,trusted:captured?.trusted ?? null,closedState:!document.querySelector('.configuration-editor') && !document.querySelector('[data-slot="sheet-overlay"]') });
    }
    publish();
    const elapsed=performance.now()-start;probeCosts.observerCount+=1;probeCosts.observerTotalMs+=elapsed;probeCosts.observerMaxMs=Math.max(probeCosts.observerMaxMs,elapsed);
  }).observe({type:'event',buffered:true,durationThreshold:16} as PerformanceObserverInit);
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = (...args) => { requests.push({ method: args[1]?.method || 'GET', path: new URL(typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : args[0].href, location.href).pathname }); publish(); return fetchOriginal(...args); };
  const openOriginal = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...rest: unknown[]) {
    requests.push({ method, path: new URL(String(url), location.href).pathname }); publish();
    return (openOriginal as Function).call(this,method,url,...rest);
  } as typeof XMLHttpRequest.prototype.open;
  const record = (name: string, category: string, ready: () => boolean) => {
    const started = performance.now(), requestCount = requests.length;
    let firstReadyMs = -1, previousFrame = started, maxFrameGapMs = 0;
    const tick = () => { const now = performance.now(); maxFrameGapMs = Math.max(maxFrameGapMs, now - previousFrame); previousFrame = now; };
    const finish = (isReady: boolean) => { tick(); samples.push({ name, category, elapsedMs: performance.now()-started, requests: requests.length-requestCount, ready:isReady,firstReadyMs,maxFrameGapMs,visibility:document.visibilityState,focused:document.hasFocus(),longTasks:longTasks.filter(task=>task.startTime>=started).map(task=>task.duration) }); publish(); };
    const frame = () => {
      tick();
      if (ready()) { firstReadyMs = performance.now()-started; requestAnimationFrame(() => { tick(); requestAnimationFrame(() => finish(true)); }); }
      else if (performance.now()-started > 3000) finish(false);
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  };
  document.addEventListener('click', event => {
    const button = (event.target as Element)?.closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    const name = button.getAttribute('aria-label') || button.textContent?.trim() || '';
    if (button === control) record(name, 'control', () => true);
    else if (/^编辑|^新增飞书授权$/.test(name)) {
      record(name,'cached-dialog',() => {
        const dialog=document.querySelector<HTMLElement>('.configuration-editor[data-state="open"]');
        if(!dialog || !dialog.querySelector('#config-account-name'))return false;
        const rect=dialog.getBoundingClientRect(),style=getComputedStyle(dialog);
        return Number(style.opacity)>=0.99 && rect.left>=-1 && rect.right<=innerWidth+1 && rect.width>0 && !dialog.getAnimations().some(animation=>animation.playState==='running');
      });
    } else if(button.getAttribute('role')==='tab') record(name,'feedback',()=>button.getAttribute('aria-selected')==='true');
    else if(button.hasAttribute('aria-pressed')) record(name,'feedback',()=>button.getAttribute('aria-pressed')==='true');
    else if(name==='下一页'||name==='上一页') { const first=document.querySelector('tbody tr')?.textContent; record(name,'feedback',()=>document.querySelector('tbody tr')?.textContent!==first); }
    else if(name==='关闭'||name==='取消')record(name,'feedback',()=>!document.querySelector('.configuration-editor[data-state="open"]'));
  },true);
  publish();
  return { exportMeasurements };
}
