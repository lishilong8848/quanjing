import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';

describe('隔离临时账本：首次启动与历史缺失的现状', () => {
  let directory:string, path:string, store:PurchaseWorkflowStore;
  beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'purchase-init-safety-'));path=join(directory,'ledger.json');store=new PurchaseWorkflowStore(path);await store.onModuleInit();});
  afterEach(async()=>{await store.onModuleDestroy();await rm(directory,{recursive:true,force:true});});
  it('启动只创建锁，账本缺失的普通读取显示空结果',async()=>{
    await expect(readFile(path)).rejects.toMatchObject({code:'ENOENT'});
    expect(await store.findCommand('synthetic')).toBeNull();
  });
  it('历史账本被删除后与首次启动同样显示空结果，现有普通写入会重新创建空历史',async()=>{
    await store.recordReminder('synthetic-original-history'); await unlink(path);
    expect(await store.findCommand('synthetic')).toBeNull();
    await store.recordReminder('synthetic-after-deletion');
    const fresh=JSON.parse(await readFile(path,'utf8'));
    expect(fresh.reminders).toEqual(['synthetic-after-deletion']);
  });
  it('损坏的 JSON 触发异常且普通写入不覆盖原字节',async()=>{
    const corrupt='{broken';await writeFile(path,corrupt);
    await expect(store.recordReminder('synthetic')).rejects.toThrow();
    expect(await readFile(path,'utf8')).toBe(corrupt);
  });
  it('合法 JSON 但缺少全部业务字段会被当前普通写入视为空账本',async()=>{
    await writeFile(path,'{}');await store.recordReminder('synthetic');
    const fresh=JSON.parse(await readFile(path,'utf8'));
    expect(fresh.reminders).toEqual(['synthetic']);expect(fresh.commands).toEqual([]);
  });
});
