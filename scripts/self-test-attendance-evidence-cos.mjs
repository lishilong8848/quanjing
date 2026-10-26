import { createHash, randomBytes } from 'node:crypto';
import COS from 'cos-nodejs-sdk-v5';

const bucket = readSetting('COS_ATTENDANCE_BUCKET', 'COS_CHANGE_BUCKET', 'COS_BUCKET') ||
  'jy-1421907124';
const region = readSetting('COS_ATTENDANCE_REGION', 'COS_CHANGE_REGION', 'COS_REGION') ||
  'ap-shanghai';
const secretId = readSetting('COS_SECRET_ID', 'TENCENTCLOUD_SECRET_ID');
const secretKey = readSetting('COS_SECRET_KEY', 'TENCENTCLOUD_SECRET_KEY');
const securityToken = readSetting(
  'COS_SESSION_TOKEN',
  'TENCENTCLOUD_SESSION_TOKEN',
);

if (!secretId || !secretKey) {
  throw new Error('COS credentials are not configured.');
}

const cos = new COS({
  SecretId: secretId,
  SecretKey: secretKey,
  SecurityToken: securityToken || undefined,
  FileParallelLimit: 1,
  ChunkParallelLimit: 1,
  Timeout: 30_000,
});
const body = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const sha256 = createHash('sha256').update(body).digest('hex');
const key = `attendance/correction-evidence/self-test/${Date.now()}-${randomBytes(5).toString('hex')}.png`;
const object = { Bucket: bucket, Region: region, Key: key };
let uploaded = false;

try {
  await cos.putObject({
    ...object,
    Body: body,
    ContentLength: body.length,
    ContentType: 'image/png',
    CacheControl: 'private, max-age=60',
    'x-cos-meta-sha256': sha256,
  });
  uploaded = true;

  const head = await cos.headObject(object);
  assertEqual(Number(header(head, 'content-length')), body.length, 'stored size');
  assertEqual(header(head, 'x-cos-meta-sha256'), sha256, 'stored sha256 metadata');

  const signedUrl = cos.getObjectUrl({
    ...object,
    Sign: true,
    Method: 'GET',
    Expires: 60,
    Query: {
      'response-content-type': 'image/png',
      'response-content-disposition': 'inline',
    },
  });
  const response = await fetch(signedUrl, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`signed GET returned HTTP ${response.status}`);
  }
  const downloaded = Buffer.from(await response.arrayBuffer());
  assertEqual(
    createHash('sha256').update(downloaded).digest('hex'),
    sha256,
    'signed GET sha256',
  );

  console.log('[OK] COS evidence write, HEAD, signed GET and byte verification passed.');
} finally {
  if (uploaded) {
    await cos.deleteObject(object);
    try {
      await cos.headObject(object);
      throw new Error('temporary COS object still exists after cleanup');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    console.log('[OK] Temporary COS evidence object was deleted.');
  }
}

function readSetting(...names) {
  for (const name of names) {
    const value = String(process.env[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function header(response, name) {
  const headers = response?.headers || {};
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch`);
  }
}

function isNotFound(error) {
  return (
    error?.statusCode === 404 ||
    error?.status === 404 ||
    ['NoSuchKey', 'NotFound'].includes(String(error?.code || ''))
  );
}
