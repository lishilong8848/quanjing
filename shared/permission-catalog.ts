import { BUSINESS_PERMISSION_CATALOG, configurableBusinessActions } from './business-permissions';
import { PERMISSION_ROUTE_CLASSIFICATIONS } from './permission-route-classification';
import { PAGE_ACCESS_CATALOG } from './page-access';

const staticPages=new Set(['/nantong-base','/operations-architecture','/exhaust-valve-map']);
export function createPermissionCatalog(){
  return {
    version:2,
    pages:PAGE_ACCESS_CATALOG.map(page=>({
      ...page,
      kind:page.path.startsWith('https://')?'external' as const:staticPages.has(page.path)?'static' as const:'business' as const,
      modules:BUSINESS_PERMISSION_CATALOG.filter(module=>module.page===page.path).map(module=>({
        ...module,actions:staticPages.has(page.path)||page.path.startsWith('https://')?['read'] as const:configurableBusinessActions(module.id),
        endpoints:PERMISSION_ROUTE_CLASSIFICATIONS.filter(route=>route.permission?.module===module.id).map(route=>({method:route.method,path:route.path,action:route.permission!.action,conditions:route.protection,recordDependent:!!route.recordDependent})),
        conditions:['purchase','inventory','stocktake','contracts'].includes(module.id)?['单据阶段、本人身份和实际审批职责仍须校验']:['leave_requests','overtime_requests'].includes(module.id)?['仅能按现有申请规则提交本人申请']:[],
      })),
    })),
    management:{path:'/system-configuration',label:'配置',kind:'fixed-admin' as const,editable:false},
    routes:PERMISSION_ROUTE_CLASSIFICATIONS.map(({source,...route})=>route),
    publicFunctions:[{id:'employee_onboarding',label:'新员工入职申请',editable:false,condition:'公开申请入口，保留身份校验与提交频率限制'},{id:'weather_preparedness',label:'天气戒备登记',editable:false,condition:'公开登记入口，保留表单校验与提交频率限制'}],
    notificationCondition:'手动通知权限控制主动发送和重发；操作完成后的自动通知仍按原业务流程发送。',
    precedence:['account-status','fixed-safety','personal-deny','personal-allow','role-template'] as const,
  };
}
