import { AccessConfigurationDirectory } from '../../server/common/access/access-configuration.directory';
import { fetchBitableRecords } from '../../server/common/feishu/bitable-direct-read';
jest.mock('../../server/common/feishu/bitable-direct-read',()=>({ ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords:jest.fn(),getTenantAccessToken:jest.fn(async()=> 'synthetic-token'),resolveBitableAppToken:jest.fn(async()=> 'syntheticBase') }));
jest.mock('../../server/common/access/external-employee-directory',()=>({readExternalEmployeeCredentials:jest.fn(async()=>[])}));

it('强制核源不能复用正在进行的普通缓存读取，等待后仍需真实强制读取',async()=>{
  const previous={...process.env};process.env.FEISHU_APP_ID='cli_source_force_synthetic';
  let release!:(value:unknown)=>void,started!:()=>void,reads=0;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const person=(name:string)=>[{record_id:'recPerson',fields:{姓名:name,'飞书 open_id':'ou_source_person',岗位:'值班人员','机楼/专业':['C楼'],'离职/异动情况':false}}];
  (fetchBitableRecords as jest.Mock).mockImplementation(async(_http,options)=>{
    if(options.viewId)return person('合成在职人员');
    reads++;
    if(reads===1){started();return new Promise(resolve=>{release=resolve;});}
    expect(options.forceRefresh).toBe(true);return person('合成更新人员');
  });
  const fields=['姓名','飞书 open_id','岗位','机楼/专业','离职/异动情况'].map(field_name=>({field_name,type:field_name==='离职/异动情况'?7:1}));
  const http={axiosRef:{get:jest.fn(async(url:string)=>({data:{code:0,data:{has_more:false,items:url.endsWith('/fields')?fields:[]}}}))}};
  try{
    const directory=new AccessConfigurationDirectory(http as never),normal=directory.read(false);await entered;
    const forced=directory.read(true),secondForced=directory.read(true);release(person('合成旧人员'));
    expect((await normal).employees[0].name).toBe('合成旧人员');
    expect((await forced).employees[0].name).toBe('合成更新人员');expect((await secondForced).employees[0].name).toBe('合成更新人员');expect(reads).toBe(2);
    expect((await directory.read()).employees[0].name).toBe('合成更新人员');expect(reads).toBe(2);
  }finally{process.env=previous;jest.restoreAllMocks();jest.clearAllMocks();}
});

it('已有缓存时强制读取失败必须抛错，不把旧缓存当作强制成功',async()=>{
  const previous={...process.env};process.env.FEISHU_APP_ID='cli_source_force_synthetic';
  const person=[{record_id:'recPerson',fields:{姓名:'合成缓存人员','飞书 open_id':'ou_source_person',岗位:'值班人员','机楼/专业':['C楼'],'离职/异动情况':false}}];
  const fields=['姓名','飞书 open_id','岗位','机楼/专业','离职/异动情况'].map(field_name=>({field_name,type:field_name==='离职/异动情况'?7:1}));
  const http={axiosRef:{get:jest.fn(async(url:string)=>({data:{code:0,data:{has_more:false,items:url.endsWith('/fields')?fields:[]}}}))}};
  try{
    (fetchBitableRecords as jest.Mock).mockResolvedValue(person);const directory=new AccessConfigurationDirectory(http as never);await directory.read();
    (fetchBitableRecords as jest.Mock).mockRejectedValue(new Error('synthetic-forced-failure'));
    await expect(directory.read(true)).rejects.toThrow('synthetic-forced-failure');
    expect((await directory.read()).employees[0].name).toBe('合成缓存人员');
  }finally{process.env=previous;jest.restoreAllMocks();jest.clearAllMocks();}
});

it('普通pending失败后强制请求仍实际执行，最终失败来源不能被旧请求替代',async()=>{
  const previous={...process.env};process.env.FEISHU_APP_ID='cli_source_force_synthetic';let rejectNormal!:(reason:Error)=>void,started!:()=>void,reads=0;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const fields=['姓名','飞书 open_id','岗位','机楼/专业','离职/异动情况'].map(field_name=>({field_name,type:field_name==='离职/异动情况'?7:1}));
  const http={axiosRef:{get:jest.fn(async(url:string)=>({data:{code:0,data:{has_more:false,items:url.endsWith('/fields')?fields:[]}}}))}};
  try{
    (fetchBitableRecords as jest.Mock).mockImplementation(async()=>{reads++;if(reads===1){started();return new Promise((_resolve,reject)=>{rejectNormal=reject;});}throw new Error('synthetic-forced-failure');});
    const directory=new AccessConfigurationDirectory(http as never),normal=directory.read().catch(error=>(error as Error).message);await entered;
    const forced=directory.read(true);rejectNormal(new Error('synthetic-normal-failure'));
    expect(await normal).toBe('synthetic-normal-failure');await expect(forced).rejects.toThrow('synthetic-forced-failure');expect(reads).toBe(2);
  }finally{process.env=previous;jest.restoreAllMocks();jest.clearAllMocks();}
});
