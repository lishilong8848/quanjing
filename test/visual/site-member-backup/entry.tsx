import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AccessProvider,useAccess } from '../../../client/src/access/AccessProvider';
import { UnifiedAccessControl } from '../../../client/src/components/Layout';
import { AccountEditor } from '../../../client/src/pages/SystemConfiguration/AccountEditor';
import type { ManagedAccount } from '../../../shared/access-configuration.interface';
import '../mobile-feishu-session/styles.css';
declare global { interface Window { __backup: ManagedAccount; } }
function Fixture(){
  const access=useAccess(),[editor,setEditor]=React.useState(false);
  return <><UnifiedAccessControl/><button onClick={()=>access.requestLogin()}>打开登录</button><button onClick={()=>setEditor(true)}>检查备用配置</button>
    <output data-testid="identity">{access.isLoading?'确认中':`${access.displayName||'未登录'} / ${access.role}`}</output>
    <output data-testid="pages">{JSON.stringify(access.pagePaths)}</output>
    {editor&&<AccountEditor account={window.__backup} data={{revision:0,appId:'',accounts:[window.__backup],cardRules:[],audit:[]}} people={[]} onClose={()=>setEditor(false)} onSaved={()=>setEditor(false)}/>}
    <Toaster/></>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><AccessProvider><Fixture/></AccessProvider></BrowserRouter>);
