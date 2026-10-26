import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ENVELOPE_MAGIC = Buffer.from('VNETC1', 'ascii');
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEADER_BYTES = ENVELOPE_MAGIC.length + NONCE_BYTES + AUTH_TAG_BYTES;

export function parseContractEncryptionKey(value: string | undefined): Buffer {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error('合同附件加密密钥未配置');
  }
  const key = Buffer.from(normalized, 'base64');
  if (key.length !== 32 || key.toString('base64') !== normalized) {
    throw new Error('合同附件加密密钥必须是 32 字节 Base64');
  }
  return key;
}

export function encryptContractBuffer(
  plaintext: Buffer,
  key: Buffer,
  aad: string,
): Buffer {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([ENVELOPE_MAGIC, nonce, authTag, ciphertext]);
}

export function decryptContractBuffer(
  envelope: Buffer,
  key: Buffer,
  aad: string,
): Buffer {
  assertKey(key);
  if (
    !isEncryptedContractEnvelope(envelope) ||
    envelope.length < HEADER_BYTES
  ) {
    throw new Error('合同附件密文格式无效');
  }
  const nonceStart = ENVELOPE_MAGIC.length;
  const tagStart = nonceStart + NONCE_BYTES;
  const contentStart = tagStart + AUTH_TAG_BYTES;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      envelope.subarray(nonceStart, tagStart),
    );
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(envelope.subarray(tagStart, contentStart));
    return Buffer.concat([
      decipher.update(envelope.subarray(contentStart)),
      decipher.final(),
    ]);
  } catch {
    throw new Error('合同附件密文校验失败');
  }
}

export function isEncryptedContractEnvelope(value: Buffer): boolean {
  return (
    value.length >= HEADER_BYTES &&
    value.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)
  );
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) {
    throw new Error('合同附件加密密钥必须是 32 字节');
  }
}
