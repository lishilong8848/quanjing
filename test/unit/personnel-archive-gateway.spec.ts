jest.mock('../../server/common/feishu/bitable-direct-read',()=>({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords:jest.fn(),getTenantAccessToken:jest.fn(),resolveBitableAppToken:jest.fn(),readLatestPersistedBitableRecordSnapshot:jest.fn(),
}));
import { fetchBitableRecords,getTenantAccessToken,resolveBitableAppToken,readLatestPersistedBitableRecordSnapshot } from '../../server/common/feishu/bitable-direct-read';
import { PersonnelArchiveGateway,PERSONAL_ARCHIVE_PHOTO_MAX_BYTES,photoToken,type PersonnelArchiveDirectory } from '../../server/common/access/personnel-archive.gateway';

describe('personal archive source projection and fixed media proxy',()=>{
  const saved={...process.env};let gateway:PersonnelArchiveGateway,http:any,metas:any[],rows:any[];
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/q3cAAAAASUVORK5CYII=','base64');
  beforeEach(()=>{
    process.env.FEISHU_APP_ID='cli_archive_test';process.env.FEISHU_EMPLOYEE_ONBOARDING_APP_TOKEN='bascnArchiveSynthetic';process.env.FEISHU_EMPLOYEE_ONBOARDING_TABLE_ID='tblArchiveTest';process.env.FEISHU_ORG_VIEW_ID='vewArchiveTest';
    jest.clearAllMocks();(resolveBitableAppToken as jest.Mock).mockResolvedValue('bascnArchiveSynthetic');(getTenantAccessToken as jest.Mock).mockResolvedValue('synthetic-token');
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue({fetchedAt:1793235600000});
    metas=[{field_name:'姓名',type:1},{field_name:'员工姓名',type:11},{field_name:'离职/异动情况',type:7},{field_name:'照片',type:17},{field_name:'联系方式',type:13},{field_name:'身份证号',type:1},{field_name:'密码',type:1}];
    rows=[{record_id:'recArchiveTest',fields:{姓名:'合成人员',员工姓名:[{id:'ou_archive_test'}],身份证号:'11010519491231002X',联系方式:'13800000000',密码:'NEVER_READ_OR_CACHE',照片:[{file_token:'boxPhotoTest',url:'http://127.0.0.1/private',tmp_download_url:'https://arbitrary.invalid'}]}}];
    (fetchBitableRecords as jest.Mock).mockImplementation(async(_http,options)=>{const result=structuredClone(rows);options.validateRecords(result);return result;});
    http={axiosRef:{get:jest.fn(async(url:string)=>url.endsWith('/fields')?{data:{code:0,data:{items:metas,has_more:false}}}:{data:png,headers:{'content-type':'image/png'}})}};
    gateway=new PersonnelArchiveGateway(http);
  });
  afterEach(()=>{process.env={...saved};jest.useRealTimers();});
  it('reads the login/onboarding source with an explicit existing-field whitelist and no password column',async()=>{
    const result=await gateway.read();const options=(fetchBitableRecords as jest.Mock).mock.calls[0][1];
    expect(result).toMatchObject({appId:'cli_archive_test',appToken:'bascnArchiveSynthetic',tableId:'tblArchiveTest',snapshotAt:'2026-10-29T01:00:00.000Z'});
    expect(options).toMatchObject({viewId:'vewArchiveTest',automaticFields:true,strict:true,allowStale:false,cacheTtlMs:300000});
    expect(options.fieldNames).toContain('联系方式');expect(options.fieldNames).not.toContain('密码');expect(options.fieldNames).not.toContain('不存在字段');
    expect(result.records[0].fields).toMatchObject({身份证号:'110105********002X','离职/异动情况':false,照片:[{file_token:'boxPhotoTest'}]});
    expect(JSON.stringify(result)).not.toMatch(/NEVER_READ_OR_CACHE|11010519491231002X|127\.0\.0\.1|arbitrary\.invalid/);
  });
  it.each(['证件照','员工照片'])('keeps schema-validated %s through both pre-persistence and return projections',async alias=>{
    metas=metas.filter(item=>item.field_name!=='照片');metas.push({field_name:alias,type:17});
    rows[0].fields[alias]=rows[0].fields.照片;delete rows[0].fields.照片;
    rows[0].fields.身份证号=[{text:'11010519491231002X',type:'text'}];
    const result=await gateway.read();expect(photoToken(result.records[0])).toBe('boxPhotoTest');
    expect(result.records[0].fields?.[alias]).toEqual([{file_token:'boxPhotoTest'}]);
    expect(result.records[0].fields?.身份证号).toBe('110105********002X');
    expect(JSON.stringify(result)).not.toContain('11010519491231002X');
  });
  it('does not accept extra photo fields absent from schema or non-attachment photo columns',async()=>{
    metas=metas.filter(item=>item.field_name!=='照片');metas.push({field_name:'员工照片',type:1});
    rows[0].fields.员工照片=[{file_token:'boxMalicious'}];
    expect(photoToken((await gateway.read()).records[0])).toBeNull();
  });
  it('uses schema evidence only for missing checkbox false',async()=>{
    metas.find(item=>item.field_name==='离职/异动情况').type=3;
    expect((await gateway.read()).records[0].fields?.['离职/异动情况']).toBeUndefined();
  });
  it('coalesces simultaneous reads and reuses metadata without forcing the shared record cache',async()=>{
    let finish!:(rows:unknown)=>void;
    (fetchBitableRecords as jest.Mock).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const a=gateway.read(),b=gateway.read();for(let i=0;i<8;i++)await Promise.resolve();
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);finish(structuredClone(rows));await Promise.all([a,b]);await gateway.read();
    expect(http.axiosRef.get.mock.calls.filter(([url]:[string])=>url.endsWith('/fields'))).toHaveLength(1);
    expect((fetchBitableRecords as jest.Mock).mock.calls.every(([,options])=>options.forceRefresh!==true)).toBe(true);
  });
  it('does not cancel the shared directory request when one display wait reaches fifty seconds',async()=>{
    jest.useFakeTimers();let finish!:(rows:unknown)=>void;(fetchBitableRecords as jest.Mock).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const first=gateway.read();const firstCheck=expect(first).rejects.toThrow('读取超时');
    for(let i=0;i<8;i++)await Promise.resolve();await jest.advanceTimersByTimeAsync(49000);
    const second=gateway.read();await jest.advanceTimersByTimeAsync(1000);await firstCheck;
    finish(structuredClone(rows));await expect(second).resolves.toMatchObject({appId:'cli_archive_test'});
    expect(fetchBitableRecords).toHaveBeenCalledTimes(1);
  });
  it('sanitizes source errors instead of returning upstream bodies or credentials',async()=>{
    http.axiosRef.get.mockRejectedValue(new Error('axios secret-token and sensitive data'));
    await expect(gateway.read()).rejects.toThrow('个人档案资料暂不可用');
  });
  it('does not silently use stale metadata when the configured source changes',async()=>{
    await gateway.read();process.env.FEISHU_EMPLOYEE_ONBOARDING_TABLE_ID='tblOtherArchive';await gateway.read();
    expect(http.axiosRef.get.mock.calls.filter(([url]:[string])=>url.endsWith('/fields'))).toHaveLength(2);
    expect((fetchBitableRecords as jest.Mock).mock.calls[1][1].tableId).toBe('tblOtherArchive');
  });
  it('downloads only a bound attachment token through the fixed media endpoint without redirects',async()=>{
    const directory=await gateway.read();const result=await gateway.photo(directory,directory.records[0]);
    expect(result?.contentType).toBe('image/png');expect(result?.buffer).toEqual(png);
    const call=http.axiosRef.get.mock.calls.find(([url]:[string])=>url.includes('/medias/'));
    expect(call).toEqual(['https://open.feishu.cn/open-apis/drive/v1/medias/boxPhotoTest/download',expect.objectContaining({responseType:'arraybuffer',timeout:8000,maxRedirects:0,maxContentLength:PERSONAL_ARCHIVE_PHOTO_MAX_BYTES})]);
  });
  it('accepts generic binary MIME only when the bytes prove a supported image',async()=>{
    const directory=await gateway.read();http.axiosRef.get.mockResolvedValue({data:png,headers:{'content-type':'application/octet-stream'}});
    expect((await gateway.photo(directory,directory.records[0]))?.contentType).toBe('image/png');
  });
  it('preserves the existing onboarding ten MiB photo allowance',async()=>{
    expect(PERSONAL_ARCHIVE_PHOTO_MAX_BYTES).toBe(10*1024*1024);
    const directory=await gateway.read(),large=Buffer.alloc(9*1024*1024);png.copy(large);
    http.axiosRef.get.mockResolvedValue({data:large,headers:{'content-type':'image/png'}});
    expect((await gateway.photo(directory,directory.records[0]))?.buffer.length).toBe(large.length);
  });
  it.each([['html-as-png',Buffer.from('<html>private</html>'),'image/png'],['wrong-type',png,'image/jpeg'],['svg',Buffer.from('<svg></svg>'),'image/svg+xml'],['oversize',Buffer.alloc(PERSONAL_ARCHIVE_PHOTO_MAX_BYTES+1),'application/octet-stream']])('rejects %s photo payloads',async(_label,data,contentType)=>{
    const directory=await gateway.read();http.axiosRef.get.mockResolvedValue({data,headers:{'content-type':contentType}});
    await expect(gateway.photo(directory,directory.records[0])).rejects.toThrow('个人照片读取失败');
  });
  it('does not fetch an arbitrary URL or a path-injecting file token',async()=>{
    const directory=await gateway.read();directory.records[0].fields!.照片=[{url:'http://127.0.0.1/private',file_token:'../../secret'}];
    http.axiosRef.get.mockClear();expect(await gateway.photo(directory,directory.records[0])).toBeNull();expect(http.axiosRef.get).not.toHaveBeenCalled();
  });
  it('coalesces and caches successful photographs by source plus token',async()=>{
    const directory=await gateway.read();http.axiosRef.get.mockClear();
    const [a,b]=await Promise.all([gateway.photo(directory,directory.records[0]),gateway.photo(directory,directory.records[0])]);
    expect(a).toEqual(b);await gateway.photo(directory,directory.records[0]);expect(http.axiosRef.get).toHaveBeenCalledTimes(1);
  });
});
