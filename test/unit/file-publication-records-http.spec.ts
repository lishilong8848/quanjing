import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePublicationGateway } from '../../server/modules/file-publication/file-publication.gateway';
import { FilePublicationModule } from '../../server/modules/file-publication/file-publication.module';
import type { AccessPrincipal } from '../../shared/access-control.interface';

describe('file publication source record HTTP flow', () => {
  it('routes a dynamic table through authorized, idempotent CRUD while protecting publication rows', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'file-publication-records-http-'));
    const previousRoot = process.env.FILE_PUBLICATION_STATE_DIR;
    process.env.FILE_PUBLICATION_STATE_DIR = stateRoot;
    let app: INestApplication | undefined;

    try {
      const link = 'https://example.feishu.cn/base/PublicationBase?table=tblPublication';
      const schema = { tableName: '发布台账', sourceUrl: link, appToken: 'PublicationBase', tableId: 'tblPublication', fields: [
        { key: 'fldTitle', name: '资料名称', type: 1 },
        { key: 'fldAmount', name: '排序值', type: 2 },
        { key: 'fldBatch', name: '发布批次ID', type: 1 },
        { key: 'fldFormula', name: '摘要', type: 20 },
      ] };
      const rows = new Map<string, { id: string; fields: Record<string, unknown> }>([
        ['recManaged', { id: 'recManaged', fields: { 资料名称: '既有发布', 发布批次ID: randomUUID() } }],
      ]);
      const writes = {
        create: jest.fn(async (_link: string, _token: string, fields: Record<string, unknown>) => {
          const row = { id: 'recManual', fields };
          rows.set(row.id, row);
          return row;
        }),
        update: jest.fn(async (_link: string, id: string, fields: Record<string, unknown>) => {
          const row = { id, fields: { ...rows.get(id)?.fields, ...fields } };
          rows.set(id, row);
          return row;
        }),
        delete: jest.fn(async (_link: string, id: string) => { rows.delete(id); }),
      };
      const module = await Test.createTestingModule({ imports: [FilePublicationModule] })
        .overrideProvider(FilePublicationGateway).useValue({
          tables: () => [], groups: () => [{ id: 'oc_private', name: '发布通知群' }],
          getRecordSchema: async () => schema, listTableRecords: async () => ({ records: [...rows.values()] }),
          getTableRecord: async (_link: string, id: string) => rows.get(id) || null,
          createTableRecord: writes.create, updateTableRecord: writes.update, deleteTableRecord: writes.delete,
        }).compile();
      app = module.createNestApplication();
      const actors: Record<string, AccessPrincipal> = {
        admin: { role: 'admin', purchaseBuilding: null, accountId: 'admin' },
        publisher: { role: 'editor', purchaseBuilding: null, accountId: 'publisher' },
        reader: { role: 'inventory_admin', purchaseBuilding: null, accountId: 'reader', personalRules: [{
          id: 'records-read', module: 'file_publication_table', effect: 'allow', actions: ['read'], buildings: null, specialties: null,
        }] },
      };
      app.use((request: Request, _response: Response, next: NextFunction) => {
        Object.assign(request, { accessPrincipal: actors[String(request.headers['x-test-actor'])] });
        next();
      });
      await app.listen(0, '127.0.0.1');
      const api = `${await app.getUrl()}/api/file-publication`;
      const send = (path: string, actor: string, body?: object, method = body ? 'POST' : 'GET') => fetch(api + path, {
        method,
        headers: { 'x-test-actor': actor, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });

      expect(await (await send('/options', 'publisher')).json()).toMatchObject({ canPublish: true, canManageRecords: false });
      expect(await (await send('/options', 'reader')).json()).toMatchObject({ canReadPublication: false, canManageRecords: true, groups: [] });
      expect((await send('/records/query', 'publisher', { link })).status).toBe(403);
      const view = await (await send('/records/query', 'reader', { link })).json();
      expect(view).toMatchObject({
        permissions: { create: false, update: false, delete: false },
        records: [{ id: 'recManaged', managed: true }],
      });
      expect(view.fields).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'fldTitle', editable: true }),
        expect.objectContaining({ key: 'fldFormula', editable: false }),
        expect.objectContaining({ key: 'fldBatch', editable: false }),
      ]));

      const add = { link, schemaVersion: view.schemaVersion, requestId: randomUUID(), values: { fldTitle: '手工资料', fldAmount: 1 } };
      expect((await send('/records', 'reader', add)).status).toBe(403);
      const added = await (await send('/records', 'admin', add)).json();
      expect(added.record).toMatchObject({ id: 'recManual', managed: false, values: { fldTitle: '手工资料', fldAmount: 1 } });
      expect(await (await send('/records', 'admin', add)).json()).toMatchObject({ record: { id: 'recManual' } });
      expect(writes.create).toHaveBeenCalledTimes(1);

      const patch = { link, version: added.record.version, requestId: randomUUID(), values: { fldAmount: 2 } };
      const edited = await (await send('/records/recManual', 'admin', patch, 'PATCH')).json();
      expect(edited.record).toMatchObject({ values: { fldTitle: '手工资料', fldAmount: 2 } });
      const stale = await send('/records/recManual', 'admin', { ...patch, requestId: randomUUID(), values: { fldAmount: 3 } }, 'PATCH');
      expect(stale.status).toBe(409);
      expect(writes.update).toHaveBeenCalledTimes(1);

      const administratorView = await (await send('/records/query', 'admin', { link })).json();
      const existingPublication = administratorView.records.find(record => record.id === 'recManaged');
      expect((await send('/records/recManaged/delete', 'admin', { link, version: existingPublication.version, requestId: randomUUID() })).ok).toBe(false);
      const remove = { link, version: edited.record.version, requestId: randomUUID() };
      expect(await (await send('/records/recManual/delete', 'admin', remove)).json()).toMatchObject({ deleted: true, id: 'recManual' });
      expect((await send('/records/recManual/delete', 'admin', remove)).ok).toBe(true);
      expect(writes.delete).toHaveBeenCalledTimes(1);
      expect([...rows.keys()]).toEqual(['recManaged']);
    } finally {
      await app?.close();
      if (previousRoot === undefined) delete process.env.FILE_PUBLICATION_STATE_DIR;
      else process.env.FILE_PUBLICATION_STATE_DIR = previousRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
