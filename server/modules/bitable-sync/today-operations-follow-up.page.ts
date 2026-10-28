export function renderTodayOperationsFollowUpPage(input: { ticket: string }): string {
  const ticket = JSON.stringify(input.ticket).replace(/</gu, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>异常跟进</title>
<style>:root{font-family:Inter,system-ui,sans-serif;color:#172033;background:#f5f7fb}*{box-sizing:border-box}body{margin:0;padding:20px}.shell{max-width:760px;margin:0 auto}.panel{background:#fff;border:1px solid #e5eaf2;border-radius:14px;box-shadow:0 8px 28px #1f293714;overflow:hidden}.head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #edf0f5}.head h1{font-size:21px;margin:0}.close{border:1px solid #dbe2ec;background:#fff;color:#475569;border-radius:8px;padding:8px 13px}.content{padding:16px}.state{padding:28px;text-align:center;color:#64748b}.item{border:1px solid #e5eaf2;border-radius:10px;padding:15px;margin-bottom:12px}.row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.title{font-weight:700}.meta{font-size:13px;color:#64748b;margin-top:4px}.description{white-space:pre-wrap;line-height:1.55;margin:12px 0;color:#334155}.checks{display:flex;gap:18px;margin:10px 0}.checks label{display:flex;gap:7px;align-items:center}input.login-input{width:100%;border:1px solid #cfd8e6;border-radius:8px;padding:10px;font:inherit;margin:6px 0 12px}.login-label{display:block;margin-top:12px}.login-note{font-size:12px;color:#64748b}.save-link{display:block;text-align:center;text-decoration:none}.readonly{white-space:pre-wrap;line-height:1.55}textarea{width:100%;min-height:84px;border:1px solid #cfd8e6;border-radius:8px;padding:10px;font:inherit;resize:vertical}textarea:focus{outline:2px solid #93b4ff;border-color:#4f7cff}.save{width:100%;border:0;border-radius:8px;background:#3563e9;color:#fff;padding:11px;font-weight:700;margin-top:10px}.save:disabled{opacity:.55}.result{min-height:22px;margin-top:8px;font-size:13px}.success{color:#16803c}.error{color:#c73232}.submitting{color:#475569}@media(max-width:560px){body{padding:0}.panel{border:0;border-radius:0;min-height:100vh}.row{display:block}.content{padding:12px}}</style></head>
<body><main class="shell"><section class="panel"><header class="head"><h1>异常跟进</h1><button id="close" class="close" type="button">退出</button></header><div id="content" class="content"><div class="state loading">正在加载…</div></div></section></main>
<script>(()=>{
  const ticket=${ticket},content=document.getElementById('content'),basePath=location.pathname.replace(/\\/attendance-anomaly-follow-up\\/?$/u,''),api=basePath+'/api/duty-schedules/daily-operations-follow-ups';
  history.replaceState({},document.title,location.pathname);
  let loadGeneration=0,actorKey='',canUpdate=false;
  document.getElementById('close').onclick=()=>{window.close();setTimeout(()=>{if(history.length>1)history.back();else content.innerHTML='<div class="state">已退出，请关闭此页面</div>'},120)};
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const draftKey=id=>'follow-up-draft:'+actorKey+':'+id;
  function readDraft(id){try{const value=JSON.parse(localStorage.getItem(draftKey(id))||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}catch{return {}}}
  function csrfToken(){
    for(const name of ['__Host-suda-csrf-token','suda-csrf-token']){
      const matches=document.cookie.split(';').map(part=>part.trim()).filter(part=>part===name||part.startsWith(name+'='));
      if(!matches.length)continue;
      if(matches.length!==1)return '';
      try{const value=decodeURIComponent(matches[0].slice(name.length+1));return /^[A-Za-z0-9_-]{43}$/.test(value)||/^[a-f0-9]{40}-\\d{10}$/.test(value)?value:''}catch{return ''}
    }
    return '';
  }
  async function request(url,options={}){
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
    try{const headers=new Headers(options.headers),token=csrfToken();if(token)headers.set('x-suda-csrf-token',token);const response=await fetch(url,{...options,headers,signal:controller.signal,credentials:'same-origin'});const data=await response.json().catch(()=>({}));return {response,data}}
    catch(error){if(error&&error.name==='AbortError')throw new Error('请求超时，草稿已保留，请重试');throw new Error('连接失败，请稍后重试')}
    finally{clearTimeout(timeout)}
  }
  const message=(data,fallback)=>typeof data.message==='string'?data.message:fallback;
  function signIn(){
    content.innerHTML='<div class="item"><div class="title">登录后查看异常跟进</div><a id="feishu-login" class="save save-link">飞书授权登录</a><details style="margin-top:18px"><summary>使用姓名与密码登录</summary><form id="name-login"><label class="login-label" for="login-name">姓名</label><input id="login-name" class="login-input" type="text" autocomplete="username" maxlength="100" required><label class="login-label" for="login-password">密码</label><input id="login-password" class="login-input" type="password" autocomplete="current-password" maxlength="128" required><p class="login-note">如未修改，初始密码为身份证后6位。</p><button class="save" type="submit">登录</button><div class="result" role="status" aria-live="polite"></div></form></details></div>';
    const returnTo=location.pathname+'?'+new URLSearchParams({ticket}).toString();
    document.getElementById('feishu-login').href=basePath+'/api/access/feishu/authorize?'+new URLSearchParams({returnTo}).toString();
    document.getElementById('name-login').onsubmit=async event=>{
      event.preventDefault();const form=event.currentTarget,button=form.querySelector('button'),result=form.querySelector('.result'),password=form.querySelector('#login-password');
      if(button.disabled)return;button.disabled=true;result.className='result submitting';result.textContent='正在登录…';
      try{const {response,data}=await request(basePath+'/api/access/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({employeeName:form.querySelector('#login-name').value.trim(),password:password.value})});if(!response.ok)throw new Error(message(data,'登录失败，请核对姓名和密码'));password.value='';await load()}
      catch(error){result.className='result error';result.textContent=error.message}
      finally{password.value='';button.disabled=false}
    };
  }
  function draw(items){
    if(!items.length){content.innerHTML='<div class="state success">当前范围暂无异常</div>';return}
    content.innerHTML=(!canUpdate?'<p class="meta">当前账号可查看异常跟进</p>':'')+items.map(item=>{
      const draft=canUpdate?readDraft(item.recordId):{},measure=draft.treatmentMeasure??item.treatmentMeasure;
      const controls=canUpdate?'<div class="checks"><label><input class="ack" type="checkbox" '+((draft.acknowledged??item.acknowledged)?'checked':'')+'> 已知悉</label><label><input class="done" type="checkbox" '+((draft.completed??item.completed)?'checked':'')+'> 已处理完成</label></div><textarea class="measure" maxlength="500" aria-label="处理措施" placeholder="填写处理措施">'+esc(measure)+'</textarea><button class="save" type="button">保存</button><div class="result" role="status" aria-live="polite"></div>':'<p class="meta">'+(item.completed?'已处理完成':item.acknowledged?'已知悉':'待跟进')+'</p><div class="readonly">'+esc(item.treatmentMeasure||'暂无处理措施')+'</div>';
      return '<article class="item" data-id="'+esc(item.recordId)+'"><div class="row"><div><div class="title">'+esc(item.item)+'</div><div class="meta">'+esc(item.date)+' · '+esc(item.source)+(item.building?' · '+esc(item.building):'')+'</div></div></div><div class="description">'+esc(item.description)+'</div>'+controls+'</article>'
    }).join('');
    if(canUpdate)for(const card of content.querySelectorAll('.item'))bind(card);
  }
  function bind(card){
    const id=card.dataset.id,ack=card.querySelector('.ack'),done=card.querySelector('.done'),measure=card.querySelector('.measure'),button=card.querySelector('.save'),result=card.querySelector('.result');
    let attempt=readDraft(id).attempt;
    const values=()=>({recordId:id,acknowledged:ack.checked||done.checked,completed:done.checked,treatmentMeasure:measure.value.trim()});
    const persist=()=>{try{localStorage.setItem(draftKey(id),JSON.stringify({...values(),...(attempt?{attempt}:{})}))}catch{result.className='result error';result.textContent='无法保存草稿，请保留当前页面后重试'}};
    measure.addEventListener('input',persist);ack.addEventListener('change',persist);done.addEventListener('change',()=>{if(done.checked)ack.checked=true;persist()});
    button.onclick=async()=>{
      if(button.disabled)return;const body=values();
      if(body.completed&&body.treatmentMeasure.length<2){result.className='result error';result.textContent='完成前请填写处理措施';return}
      const fingerprint=JSON.stringify(body);
      if(!attempt||attempt.fingerprint!==fingerprint||typeof attempt.clientMutationId!=='string')attempt={fingerprint,clientMutationId:crypto.randomUUID()};
      persist();button.disabled=true;result.className='result submitting';result.textContent='正在保存…';
      try{const {response,data}=await request(api,{method:'POST',headers:{'content-type':'application/json','x-follow-up-ticket':ticket},body:JSON.stringify({...body,clientMutationId:attempt.clientMutationId})});if(!response.ok)throw new Error(message(data,'保存失败，请重试'));try{localStorage.removeItem(draftKey(id))}catch{}attempt=null;result.className='result success';result.textContent='已保存';ack.checked=Boolean(data.record.acknowledged);done.checked=Boolean(data.record.completed)}
      catch(error){persist();result.className='result error';result.textContent=error.message}
      finally{button.disabled=false}
    };
  }
  async function load(){
    const generation=++loadGeneration;content.innerHTML='<div class="state loading">正在加载…</div>';
    try{const {response,data}=await request(api,{headers:{'x-follow-up-ticket':ticket}});if(generation!==loadGeneration)return;if(response.status===401){signIn();return}if(!response.ok)throw new Error(message(data,'加载失败，请重试'));actorKey=data.actorKey;canUpdate=data.canUpdate===true;draw(data.records||[])}
    catch(error){if(generation!==loadGeneration)return;content.innerHTML='<div class="state error">'+esc(error.message)+'</div><button id="retry" class="close" type="button">重试</button>';document.getElementById('retry').onclick=()=>load()}
  }
  load();
})();</script></body></html>`;
}
