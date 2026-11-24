import { BadGatewayException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePublicationGateway } from '../../server/modules/file-publication/file-publication.gateway';
import { FilePublicationModule } from '../../server/modules/file-publication/file-publication.module';
import { FilePublicationService } from '../../server/modules/file-publication/file-publication.service';
import type { AccessPrincipal } from '../../shared/access-control.interface';

describe('file publication HTTP flow', () => {
  it('accepts one multipart batch, requires an approver, and returns its published files', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'file-publication-http-'));
    const previousRoot = process.env.FILE_PUBLICATION_STATE_DIR;
    process.env.FILE_PUBLICATION_STATE_DIR = stateRoot;
    let app: INestApplication | undefined;

    try {
      const link = 'https://example.feishu.cn/base/PublicationBase?table=tblPublication';
      const groups = [{ id: 'oc_first', name: '一号群' }, { id: 'oc_second', name: '二号群' }];
      const fields = [{ key: 'fldTitle', name: '资料名称', value: '巡检指引' }];
      const preview = {
        tableName: '发布台账', sourceUrl: link, title: '巡检指引', code: 'GL-2026-038', fields,
        schemaVersion: 'a'.repeat(64),
      };
      const manualGroup = { id: 'oc_custom', name: '测试定向群', kind: 'group' };
      const person = { id: 'ou_person', name: '测试收件人', kind: 'person' };
      const resolveManualRecipients = jest.fn(async () => [manualGroup, person, groups[0]]);
      const prepareBatch = jest.fn(async () => ({ ...preview, title: '巡检指引（新版）' }));
      const commitBatch = jest.fn(async () => 'recPublication');
      const notifyRecipient = jest.fn(async (_batch: { id: string }, _group: { id: string; name: string }) => 'om_publication');
      const module = await Test.createTestingModule({ imports: [FilePublicationModule] })
        .overrideProvider(FilePublicationGateway).useValue({
          tables: () => [], groups: () => groups, parse: async () => preview,
          prepareBatch, commitBatch, notifyRecipient, resolveManualRecipients,
        }).compile();
      app = module.createNestApplication();
      app.use((request: Request, _response: Response, next: NextFunction) => {
        const accountId = request.headers['x-test-actor'];
        if (accountId) Object.assign(request, {
          accessPrincipal: { accountId, role: accountId === 'reviewer' ? 'admin' : 'editor', specialties: [] },
        });
        next();
      });
      await app.listen(0, '127.0.0.1');
      const api = `${await app.getUrl()}/api/file-publication`;
      const service = app.get(FilePublicationService);
      const send = (path: string, actor?: string, body?: FormData | string) => fetch(api + path, {
        method: body === undefined ? 'GET' : 'POST', body,
        headers: {
          ...(actor ? { 'x-test-actor': actor } : {}),
          ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        },
      });

      expect((await send('/options')).status).toBe(403);
      const parsed = await send('/parse', 'publisher', JSON.stringify({ link, files: [{ name: '巡检.pdf', size: 8 }] }));
      expect(await parsed.json()).toMatchObject({ fields });

      const requestId = randomUUID();
      const upload = (version = preview.schemaVersion) => {
        const data = new FormData();
        data.set('requestId', requestId);
        data.set('link', link);
        data.set('metadata', JSON.stringify({ fldTitle: '巡检指引（新版）' }));
        data.set('groupIds', JSON.stringify(groups.map(group => group.id)));
        data.set('recipientInputs', JSON.stringify(['测试收件人', 'oc_custom', groups[0].id]));
        data.set('schemaVersion', version);
        data.append('files', new Blob(['file one']), '巡检.pdf');
        data.append('files', new Blob(['file two']), '记录.xlsx');
        return data;
      };
      const outdated = await send('/batches', 'publisher', upload('b'.repeat(64)));
      expect(outdated.status).toBe(400);
      expect(await outdated.json()).toMatchObject({ code: 'PUBLICATION_SCHEMA_CHANGED' });
      expect(resolveManualRecipients).not.toHaveBeenCalled();
      resolveManualRecipients.mockRejectedValueOnce(new BadGatewayException('暂时无法核对飞书通知群'));
      const unavailable = await send('/batches', 'publisher', upload());
      expect(unavailable.status).toBe(422);
      expect(await unavailable.json()).toMatchObject({ message: '暂时无法核对飞书通知群' });
      expect(commitBatch).not.toHaveBeenCalled();
      const submissions = await Promise.all([send('/batches', 'publisher', upload()), send('/batches', 'publisher', upload())]);
      expect(submissions.map(response => response.status)).toEqual([201, 201]);
      const [batch, repeated] = await Promise.all(submissions.map(response => response.json()));
      expect(repeated.id).toBe(batch.id);
      expect(batch.groups).toEqual([manualGroup, person, ...groups]);
      expect(batch.files.map(file => file.name)).toEqual(['巡检.pdf', '记录.xlsx']);
      expect(await (await send('/batches', 'other-editor')).json()).toEqual({ batches: [] });

      await service.processPending();
      expect(prepareBatch).toHaveBeenCalledTimes(1);
      expect(commitBatch).toHaveBeenCalledTimes(1);
      expect(notifyRecipient).not.toHaveBeenCalled();
      expect(await (await send('/batches', 'reviewer')).json()).toMatchObject({
        batches: [{ id: batch.id, title: '巡检指引（新版）', status: 'pending', canReview: true, groups: batch.groups }],
      });
      const review = `/batches/${batch.id}/review`;
      const approve = JSON.stringify({ decision: 'approve' });
      expect((await send(review, 'other-editor', approve)).status).toBe(403);
      expect((await send(review, 'reviewer', approve)).ok).toBe(true);
      expect((await send(review, 'reviewer', approve)).ok).toBe(true);

      await service.processPending();
      await service.processPending();
      expect(notifyRecipient.mock.calls.map(call => call[1])).toEqual(batch.groups);
      expect(commitBatch).toHaveBeenCalledTimes(1);
      expect(await (await send('/batches', 'other-editor')).json()).toMatchObject({
        batches: [{ id: batch.id, status: 'published', canDownload: true }],
      });
      const download = await send(`/batches/${batch.id}/files/${batch.files[0].id}`, 'other-editor');
      expect(download.headers.get('Content-Disposition')).toContain('attachment;');
      expect(download.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(await download.text()).toBe('file one');
    } finally {
      await app?.close();
      if (previousRoot === undefined) delete process.env.FILE_PUBLICATION_STATE_DIR;
      else process.env.FILE_PUBLICATION_STATE_DIR = previousRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('archives one multipart batch without approval or notification and keeps retries pinned to that mode', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'file-publication-archive-http-'));
    const previousRoot = process.env.FILE_PUBLICATION_STATE_DIR;
    process.env.FILE_PUBLICATION_STATE_DIR = stateRoot;
    let app: INestApplication | undefined;

    try {
      const link = 'https://example.feishu.cn/base/ArchiveFixture?table=tblArchiveFixture';
      const preview = {
        tableName: '演练台账', sourceUrl: link, title: '仅归档演练', code: 'ARC-TEST-01',
        fields: [{ key: 'fldTitle', name: '资料名称', value: '仅归档演练', maxLength: 200 }],
        schemaVersion: 'a'.repeat(64),
      };
      const prepareBatch = jest.fn(async () => ({ ...preview, fields: { 资料名称: '仅归档演练' } }));
      const commitBatch = jest.fn(async () => 'recArchiveFixture');
      const notifyRecipient = jest.fn(async () => 'om_should_not_be_used');
      const resolveManualRecipients = jest.fn(async () => []);
      const module = await Test.createTestingModule({ imports: [FilePublicationModule] })
        .overrideProvider(FilePublicationGateway).useValue({
          tables: () => [], groups: () => [{ id: 'oc_forbidden_on_archive', name: '仅用于门禁演练' }],
          parse: async () => preview, prepareBatch, commitBatch, notifyRecipient, resolveManualRecipients,
        }).compile();
      const tablePermission = {
        id: 'archive-table-create', module: 'file_publication_table', effect: 'allow', actions: ['read', 'create'],
        buildings: null, specialties: null,
      } as const;
      const actors: Record<string, AccessPrincipal> = {
        uploader: { accountId: 'uploader', role: 'editor', purchaseBuilding: null,
          personalRules: [{ ...tablePermission, actions: [...tablePermission.actions] }] },
        'publisher-only': { accountId: 'publisher-only', role: 'editor', purchaseBuilding: null },
        'table-only': { accountId: 'table-only', role: 'inventory_admin', purchaseBuilding: null,
          personalRules: [{ ...tablePermission, actions: [...tablePermission.actions] }] },
        approver: { accountId: 'approver', role: 'admin', purchaseBuilding: null },
      };
      app = module.createNestApplication();
      app.use((request: Request, _response: Response, next: NextFunction) => {
        Object.assign(request, { accessPrincipal: actors[String(request.headers['x-test-actor'])] });
        next();
      });
      await app.listen(0, '127.0.0.1');
      const api = `${await app.getUrl()}/api/file-publication`;
      const service = app.get(FilePublicationService);
      const send = (path: string, actor = 'uploader', body?: FormData | string) => fetch(api + path, {
        method: body === undefined ? 'GET' : 'POST', body,
        headers: { 'x-test-actor': actor, ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}) },
      });

      expect(await (await send('/options')).json()).toMatchObject({ canPublish: true, canArchive: true, canReview: false });
      expect(await (await send('/options', 'publisher-only')).json()).toMatchObject({ canPublish: true, canArchive: false });
      expect(await (await send('/options', 'table-only')).json()).toMatchObject({ canPublish: false, canArchive: false });

      const requestId = randomUUID();
      const upload = (mode = 'archive', groupIds: string[] = [], recipientInputs?: string[]) => {
        const data = new FormData();
        data.set('requestId', requestId);
        data.set('link', link);
        data.set('mode', mode);
        data.set('metadata', JSON.stringify({ fldTitle: '仅归档演练' }));
        data.set('groupIds', JSON.stringify(groupIds));
        data.set('schemaVersion', preview.schemaVersion);
        if (recipientInputs) data.set('recipientInputs', JSON.stringify(recipientInputs));
        data.append('files', new Blob(['first']), '演练文档.pdf');
        data.append('files', new Blob(['second']), '演练表格.xlsx');
        return data;
      };

      expect((await send('/batches', 'publisher-only', upload())).status).toBe(403);
      expect((await send('/batches', 'table-only', upload())).status).toBe(403);
      const withGroup = await send('/batches', 'uploader', upload('archive', ['oc_forbidden_on_archive']));
      const withRecipient = await send('/batches', 'uploader', upload('archive', [], ['ou_forbidden_on_archive']));
      for (const invalid of [withGroup, withRecipient]) {
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ message: expect.stringContaining('通知') });
      }
      await service.processPending();
      expect(commitBatch).not.toHaveBeenCalled();

      const response = await send('/batches', 'uploader', upload());
      expect(response.status).toBe(201);
      const batch = await response.json();
      expect(batch).toMatchObject({ mode: 'archive', status: 'syncing', groups: [], canReview: false });
      expect(batch.files.map((file: { name: string }) => file.name)).toEqual(['演练文档.pdf', '演练表格.xlsx']);

      await service.processPending();
      const archived = { id: batch.id, mode: 'archive', status: 'archived', groups: [], canReview: false };
      expect(await (await send(`/batches/${batch.id}`)).json()).toMatchObject({ batch: archived });
      expect(await (await send(`/submissions/${requestId}`)).json()).toMatchObject({ batch: archived });
      expect(await (await send('/batches', 'uploader', upload())).json()).toMatchObject(archived);
      expect((await send('/batches', 'uploader', upload('publish'))).status).toBe(409);
      expect((await send(`/batches/${batch.id}/review`, 'approver', JSON.stringify({ decision: 'approve' }))).status).toBe(409);
      expect((await send(`/batches/${batch.id}`, 'publisher-only')).status).toBe(404);
      expect(await (await send(`/batches/${batch.id}`, 'approver')).json()).toMatchObject({ batch: archived });
      await service.processPending();
      expect(prepareBatch).toHaveBeenCalledTimes(1);
      expect(commitBatch).toHaveBeenCalledTimes(1);
      expect(resolveManualRecipients).not.toHaveBeenCalled();
      expect(notifyRecipient).not.toHaveBeenCalled();
    } finally {
      await app?.close();
      if (previousRoot === undefined) delete process.env.FILE_PUBLICATION_STATE_DIR;
      else process.env.FILE_PUBLICATION_STATE_DIR = previousRoot;
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
