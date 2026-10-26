import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  WeeklyAttachmentCommand,
  WeeklyMeetingKind,
  SaveWeeklyMeeting,
} from '../../../shared/weekly-workspace.interface';
import { acquireWeeklyLock, WeeklyStore } from './weekly.store';
import { WeeklyGateway } from './weekly.gateway';

export const WEEKLY_IMAGE_FIELDS: Record<WeeklyMeetingKind, string> = {
  ali: '阿里会议附件',
  local: '属地周会附件',
};
export function imageMime(buffer: Buffer): string {
  if (
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return 'image/jpeg';
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6)))
    return 'image/gif';
  throw new BadRequestException('附件仅支持 PNG、JPEG、WebP、GIF');
}
function attachmentMime(file: Express.Multer.File): string {
  if (
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
      file.mimetype,
    )
  )
    return imageMime(file.buffer);
  return 'application/octet-stream';
}
function attachmentName(original: string) {
  let name = original;
  if (/^[\u0000-\u00ff]*$/.test(name)) {
    const bytes = Buffer.from(name, 'latin1');
    if (isUtf8(bytes)) name = bytes.toString('utf8');
  }
  return name.replace(/[\\/\r\n\u0000-\u001f]/g, '_').slice(-120) || '会议附件';
}
function imagePath(store: WeeklyStore, id: string, sha: string) {
  if (!/^[A-Za-z0-9-]{8,100}$/.test(id) || !/^[a-f0-9]{64}$/.test(sha))
    throw new BadRequestException('附件编号无效');
  return join(dirname(store.path), 'images', id, `${sha}.image`);
}
export function acceptWeeklyImages(
  store: WeeklyStore,
  input: Omit<WeeklyAttachmentCommand, 'files'>,
  files: Express.Multer.File[],
  actor: string,
) {
  if (
    !input ||
    !/^rec[A-Za-z0-9]{1,100}$/.test(input.targetRecordId || '') ||
    !['ali', 'local'].includes(input.kind) ||
    !files.length
  )
    throw new BadRequestException('请选择会议及附件');
  const base = store.get(input.baseJobId);
  if (
    base.actor !== actor ||
    base.job.kind !== 'meeting' ||
    base.job.targetRecordId !== input.targetRecordId ||
    base.job.meeting?.kind !== input.kind ||
    (base.job.meeting.status !== 'held' &&
      !(base.command as SaveWeeklyMeeting).todoOnly)
  )
    throw new BadRequestException('附件必须属于本人提交的已召开会议');
  const descriptions = files.map((file) => {
    if (!file.buffer?.length || file.buffer.length > 10 * 1024 * 1024)
      throw new BadRequestException('单个附件必须非空且最多10MB');
    return {
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
      mime: attachmentMime(file),
      size: file.buffer.length,
      name: attachmentName(file.originalname),
    };
  });
  const command: WeeklyAttachmentCommand = {
    clientMutationId: input.clientMutationId,
    targetRecordId: input.targetRecordId,
    kind: input.kind,
    baseJobId: input.baseJobId,
    files: descriptions,
  };
  const replay = store.replay('attachments', command, actor);
  if (replay) return replay;
  const paths = descriptions.map((file) =>
    imagePath(store, command.clientMutationId, file.sha256),
  );
  const directory = dirname(paths[0]);
  const release = acquireWeeklyLock(`${directory}.lock`);
  if (!release) throw new ConflictException('附件正在受理，请稍后重试');
  const created: string[] = [];
  try {
    mkdirSync(directory, { recursive: true });
    for (const [i, path] of paths.entries()) {
      if (existsSync(path)) {
        if (
          createHash('sha256').update(readFileSync(path)).digest('hex') !==
          descriptions[i].sha256
        )
          throw new ConflictException('附件缓存内容不一致');
      } else {
        const fd = openSync(path, 'wx', 0o600);
        created.push(path);
        try {
          writeFileSync(fd, files[i].buffer);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
    }
    return store.accept('attachments', command, actor);
  } catch (error) {
    for (const path of created) if (existsSync(path)) unlinkSync(path);
    throw error;
  } finally {
    release();
  }
}
export async function syncWeeklyImages(
  store: WeeklyStore,
  gateway: WeeklyGateway,
  id: string,
) {
  const receipt = store.get(id);
  const command = receipt.command as WeeklyAttachmentCommand;
  if (store.get(command.baseJobId).job.status !== 'success')
    throw new Error('待办文本尚未保存成功，请先处理会议保存任务，再重试附件');
  const field = WEEKLY_IMAGE_FIELDS[command.kind];
  store.change(id, {}, { stage: 'attachments' });
  await gateway.assertAttachmentField(field);
  if (receipt.attachmentState?.uploading) {
    store.change(
      id,
      {},
      {
        status: 'uncertain',
        error: '附件上传结果未确认，请联系管理员核对；不会重复上传',
      },
    );
    return;
  }
  let state = receipt.attachmentState || { tokens: {} };
  for (const file of command.files) {
    if (state.tokens[file.sha256]) continue;
    const buffer = readFileSync(imagePath(store, id, file.sha256));
    if (
      buffer.length !== file.size ||
      createHash('sha256').update(buffer).digest('hex') !== file.sha256
    )
      throw new Error('附件缓存校验失败，原任务已保留');
    state = { ...state, uploading: file.sha256 };
    store.change(id, { attachmentState: state }, { stage: 'attachments' });
    let token: string;
    try {
      token = await gateway.uploadImage(
        buffer,
        `${file.sha256.slice(0, 12)}-${file.name}`,
        file.mime,
      );
    } catch (error) {
      if ((error as { uploadRejected?: boolean }).uploadRejected) {
        state = { ...state, uploading: undefined };
        store.change(id, { attachmentState: state }, {});
        throw error;
      }
      store.change(
        id,
        {},
        {
          status: 'uncertain',
          error: '附件上传结果未确认，请联系管理员核对；不会重复上传',
        },
      );
      return;
    }
    state = {
      ...state,
      uploading: undefined,
      tokens: { ...state.tokens, [file.sha256]: token },
    };
    store.change(id, { attachmentState: state }, {});
  }
  if (state.expectedTokens === undefined) {
    state = {
      ...state,
      expectedTokens: gateway.attachmentTokens(
        (await gateway.record(command.targetRecordId))[field],
      ),
    };
    store.change(id, { attachmentState: state }, {});
  }
  await gateway.appendImages(
    command.targetRecordId,
    field,
    state.expectedTokens!,
    Object.values(state.tokens),
  );
  store.change(id, {}, { stage: 'done', status: 'success' });
  cleanupWeeklyImages(store, command);
}
export function cleanupWeeklyImages(
  store: WeeklyStore,
  command: WeeklyAttachmentCommand,
) {
  const id = command.clientMutationId;
  for (const sha of new Set(command.files.map((file) => file.sha256))) {
    const path = imagePath(store, id, sha);
    if (existsSync(path)) unlinkSync(path);
  }
  const directory = dirname(imagePath(store, id, command.files[0].sha256));
  if (existsSync(directory)) rmdirSync(directory);
}
