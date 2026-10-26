import {
  decryptContractBuffer,
  encryptContractBuffer,
  isEncryptedContractEnvelope,
  parseContractEncryptionKey,
} from './contract-attachment-crypto';

describe('contract attachment encryption', () => {
  const key = Buffer.alloc(32, 7);
  const aad = 'secure-contracts/object-a.vnetc';

  it('round-trips an attachment without exposing plaintext bytes', () => {
    const source = Buffer.from('%PDF-1.7\nconfidential contract');

    const encrypted = encryptContractBuffer(source, key, aad);

    expect(isEncryptedContractEnvelope(encrypted)).toBe(true);
    expect(encrypted.includes(source)).toBe(false);
    expect(decryptContractBuffer(encrypted, key, aad)).toEqual(source);
  });

  it('rejects ciphertext tampering instead of returning partial content', () => {
    const encrypted = encryptContractBuffer(Buffer.from('content'), key, aad);
    encrypted[encrypted.length - 1] ^= 1;

    expect(() => decryptContractBuffer(encrypted, key, aad)).toThrow(
      /校验失败/,
    );
  });

  it('binds ciphertext to its object key', () => {
    const encrypted = encryptContractBuffer(Buffer.from('content'), key, aad);

    expect(() =>
      decryptContractBuffer(encrypted, key, 'secure-contracts/object-b.vnetc'),
    ).toThrow(/校验失败/);
  });

  it('accepts only an exact 32-byte base64 key', () => {
    expect(parseContractEncryptionKey(key.toString('base64'))).toEqual(key);
    expect(() => parseContractEncryptionKey('')).toThrow(/未配置/);
    expect(() => parseContractEncryptionKey('c2hvcnQ=')).toThrow(/32 字节/);
  });
});
