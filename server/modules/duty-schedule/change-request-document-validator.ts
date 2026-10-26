import { TextDecoder } from 'node:util';
import { inflateRawSync } from 'node:zlib';

export type OoxmlDocumentExtension = '.docx' | '.xlsx';

export type OoxmlDocumentValidationFailureReason =
  | 'invalid-archive'
  | 'missing-required-entry'
  | 'unsafe-entry-name'
  | 'duplicate-entry'
  | 'encrypted-entry'
  | 'zip64-not-supported'
  | 'multi-disk-not-supported'
  | 'unsupported-compression'
  | 'invalid-entry-bounds'
  | 'too-many-entries'
  | 'total-uncompressed-size-limit'
  | 'entry-uncompressed-size-limit'
  | 'compression-ratio-limit'
  | 'required-xml-size-limit'
  | 'corrupt-required-xml'
  | 'invalid-content-types'
  | 'invalid-package-relationships';

export type OoxmlDocumentValidationResult =
  | { valid: true }
  | {
      valid: false;
      reason: OoxmlDocumentValidationFailureReason;
    };

interface CentralDirectoryEntry {
  name: string;
  nameBytes: Buffer;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dataOffset: number;
}

interface ParsedArchive {
  entries: CentralDirectoryEntry[];
  entriesByName: Map<string, CentralDirectoryEntry>;
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP64_UINT16_SENTINEL = 0xffff;
const ZIP64_UINT32_SENTINEL = 0xffffffff;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ENCRYPTION_FLAGS = 0x2041;
const MAX_ENTRY_COUNT = 4096;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;
const MAX_REQUIRED_XML_BYTES = 1024 * 1024;
const MAX_EOCD_COMMENT_BYTES = 0xffff;

const WORD_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const WORKBOOK_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
]);

class OoxmlValidationFailure extends Error {
  constructor(readonly reason: OoxmlDocumentValidationFailureReason) {
    super(reason);
  }
}

/**
 * Validates the ZIP/OPC structure used by change-request DOCX/XLSX uploads.
 * The function is total for untrusted input: malformed bytes produce a result,
 * never a decompression or range exception.
 */
export function validateOoxmlDocument(
  buffer: Buffer,
  extension: OoxmlDocumentExtension,
): OoxmlDocumentValidationResult {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
      fail('invalid-archive');
    }

    const archive = parseArchive(buffer);
    const mainPart =
      extension === '.docx' ? 'word/document.xml' : 'xl/workbook.xml';
    const expectedContentType =
      extension === '.docx'
        ? WORD_MAIN_CONTENT_TYPE
        : WORKBOOK_MAIN_CONTENT_TYPE;
    const contentTypesEntry = archive.entriesByName.get('[Content_Types].xml');
    const relationshipsEntry = archive.entriesByName.get('_rels/.rels');
    const mainPartEntry = archive.entriesByName.get(mainPart);

    if (!contentTypesEntry || !relationshipsEntry || !mainPartEntry) {
      fail('missing-required-entry');
    }

    const contentTypesXml = readRequiredXml(buffer, contentTypesEntry);
    if (
      !hasContentTypeOverride(
        contentTypesXml,
        `/${mainPart}`,
        expectedContentType,
      )
    ) {
      fail('invalid-content-types');
    }

    const relationshipsXml = readRequiredXml(buffer, relationshipsEntry);
    if (!hasOfficeDocumentRelationship(relationshipsXml, mainPart)) {
      fail('invalid-package-relationships');
    }

    const mainPartXml = readRequiredXml(buffer, mainPartEntry);
    const expectedRoot = extension === '.docx' ? 'document' : 'workbook';
    if (!hasXmlRoot(mainPartXml, expectedRoot)) {
      fail('corrupt-required-xml');
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      reason:
        error instanceof OoxmlValidationFailure
          ? error.reason
          : 'invalid-archive',
    };
  }
}

export function isValidOoxmlDocument(
  buffer: Buffer,
  extension: OoxmlDocumentExtension,
): boolean {
  return validateOoxmlDocument(buffer, extension).valid;
}

function parseArchive(buffer: Buffer): ParsedArchive {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = readUInt16(buffer, eocdOffset + 4);
  const centralDirectoryDisk = readUInt16(buffer, eocdOffset + 6);
  const diskEntryCount = readUInt16(buffer, eocdOffset + 8);
  const totalEntryCount = readUInt16(buffer, eocdOffset + 10);
  const centralDirectorySize = readUInt32(buffer, eocdOffset + 12);
  const centralDirectoryOffset = readUInt32(buffer, eocdOffset + 16);

  if (
    diskNumber === ZIP64_UINT16_SENTINEL ||
    centralDirectoryDisk === ZIP64_UINT16_SENTINEL ||
    diskEntryCount === ZIP64_UINT16_SENTINEL ||
    totalEntryCount === ZIP64_UINT16_SENTINEL ||
    centralDirectorySize === ZIP64_UINT32_SENTINEL ||
    centralDirectoryOffset === ZIP64_UINT32_SENTINEL
  ) {
    fail('zip64-not-supported');
  }
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    diskEntryCount !== totalEntryCount
  ) {
    fail('multi-disk-not-supported');
  }
  if (totalEntryCount > MAX_ENTRY_COUNT) {
    fail('too-many-entries');
  }

  const centralDirectoryEnd = checkedAdd(
    centralDirectoryOffset,
    centralDirectorySize,
  );
  if (
    centralDirectoryOffset >= eocdOffset ||
    centralDirectoryEnd !== eocdOffset
  ) {
    fail('invalid-entry-bounds');
  }

  const entries: CentralDirectoryEntry[] = [];
  const entriesByName = new Map<string, CentralDirectoryEntry>();
  const normalizedNames = new Set<string>();
  let cursor = centralDirectoryOffset;
  let totalUncompressedSize = 0;

  for (let index = 0; index < totalEntryCount; index += 1) {
    assertRange(buffer, cursor, 46, centralDirectoryEnd);
    if (readUInt32(buffer, cursor) !== CENTRAL_DIRECTORY_HEADER_SIGNATURE) {
      fail('invalid-archive');
    }

    const flags = readUInt16(buffer, cursor + 8);
    const method = readUInt16(buffer, cursor + 10);
    const crc = readUInt32(buffer, cursor + 16);
    const compressedSize = readUInt32(buffer, cursor + 20);
    const uncompressedSize = readUInt32(buffer, cursor + 24);
    const nameLength = readUInt16(buffer, cursor + 28);
    const extraLength = readUInt16(buffer, cursor + 30);
    const commentLength = readUInt16(buffer, cursor + 32);
    const diskStart = readUInt16(buffer, cursor + 34);
    const localHeaderOffset = readUInt32(buffer, cursor + 42);

    if (
      compressedSize === ZIP64_UINT32_SENTINEL ||
      uncompressedSize === ZIP64_UINT32_SENTINEL ||
      localHeaderOffset === ZIP64_UINT32_SENTINEL ||
      diskStart === ZIP64_UINT16_SENTINEL
    ) {
      fail('zip64-not-supported');
    }
    if (diskStart !== 0) {
      fail('multi-disk-not-supported');
    }
    assertEntryFlagsAndMethod(flags, method);

    const variableLength = checkedAdd(
      checkedAdd(nameLength, extraLength),
      commentLength,
    );
    const nextCursor = checkedAdd(cursor + 46, variableLength);
    assertRange(buffer, cursor + 46, variableLength, centralDirectoryEnd);
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decodeEntryName(nameBytes, (flags & UTF8_FLAG) !== 0);
    assertSafeEntryName(name);
    const normalizedName = name.normalize('NFC').toLowerCase();
    if (normalizedNames.has(normalizedName)) {
      fail('duplicate-entry');
    }
    normalizedNames.add(normalizedName);

    assertExtraFields(
      buffer,
      cursor + 46 + nameLength,
      extraLength,
      centralDirectoryEnd,
    );
    totalUncompressedSize += uncompressedSize;

    const entry: CentralDirectoryEntry = {
      name,
      nameBytes: Buffer.from(nameBytes),
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset: -1,
    };
    entries.push(entry);
    entriesByName.set(name, entry);
    cursor = nextCursor;
  }

  if (cursor !== centralDirectoryEnd) {
    fail('invalid-archive');
  }
  if (totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_BYTES) {
    fail('total-uncompressed-size-limit');
  }
  for (const entry of entries) {
    if (entry.uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      fail('entry-uncompressed-size-limit');
    }
  }
  for (const entry of entries) {
    if (
      entry.uncompressedSize > 0 &&
      (entry.compressedSize === 0 ||
        entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO)
    ) {
      fail('compression-ratio-limit');
    }
    if (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize) {
      fail('invalid-entry-bounds');
    }
  }

  validateLocalEntries(buffer, entries, centralDirectoryOffset);
  return { entries, entriesByName };
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimumOffset = Math.max(
    0,
    buffer.length - 22 - MAX_EOCD_COMMENT_BYTES,
  );
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (readUInt32(buffer, offset) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      continue;
    }
    const commentLength = readUInt16(buffer, offset + 20);
    if (offset + 22 + commentLength === buffer.length) {
      return offset;
    }
  }
  fail('invalid-archive');
}

function validateLocalEntries(
  buffer: Buffer,
  entries: CentralDirectoryEntry[],
  centralDirectoryOffset: number,
): void {
  const orderedEntries = [...entries].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset,
  );
  if (
    orderedEntries.length === 0 ||
    orderedEntries[0].localHeaderOffset !== 0
  ) {
    fail('invalid-entry-bounds');
  }

  for (let index = 0; index < orderedEntries.length; index += 1) {
    const entry = orderedEntries[index];
    const nextBoundary =
      orderedEntries[index + 1]?.localHeaderOffset ?? centralDirectoryOffset;
    const offset = entry.localHeaderOffset;
    assertRange(buffer, offset, 30, centralDirectoryOffset);
    if (readUInt32(buffer, offset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      fail('invalid-entry-bounds');
    }

    const flags = readUInt16(buffer, offset + 6);
    const method = readUInt16(buffer, offset + 8);
    const localCrc = readUInt32(buffer, offset + 14);
    const localCompressedSize = readUInt32(buffer, offset + 18);
    const localUncompressedSize = readUInt32(buffer, offset + 22);
    const nameLength = readUInt16(buffer, offset + 26);
    const extraLength = readUInt16(buffer, offset + 28);
    if (
      localCompressedSize === ZIP64_UINT32_SENTINEL ||
      localUncompressedSize === ZIP64_UINT32_SENTINEL
    ) {
      fail('zip64-not-supported');
    }
    if (flags !== entry.flags || method !== entry.method) {
      fail('invalid-entry-bounds');
    }

    const headerEnd = checkedAdd(
      offset + 30,
      checkedAdd(nameLength, extraLength),
    );
    assertRange(
      buffer,
      offset + 30,
      nameLength + extraLength,
      centralDirectoryOffset,
    );
    const localName = buffer.subarray(offset + 30, offset + 30 + nameLength);
    if (!localName.equals(entry.nameBytes)) {
      fail('invalid-entry-bounds');
    }
    assertExtraFields(
      buffer,
      offset + 30 + nameLength,
      extraLength,
      centralDirectoryOffset,
    );

    const dataEnd = checkedAdd(headerEnd, entry.compressedSize);
    if (dataEnd > nextBoundary || nextBoundary > centralDirectoryOffset) {
      fail('invalid-entry-bounds');
    }
    entry.dataOffset = headerEnd;

    if ((flags & DATA_DESCRIPTOR_FLAG) !== 0) {
      if (
        (localCrc !== 0 && localCrc !== entry.crc) ||
        (localCompressedSize !== 0 &&
          localCompressedSize !== entry.compressedSize) ||
        (localUncompressedSize !== 0 &&
          localUncompressedSize !== entry.uncompressedSize)
      ) {
        fail('invalid-entry-bounds');
      }
      validateDataDescriptor(buffer, dataEnd, nextBoundary, entry);
    } else {
      if (
        localCrc !== entry.crc ||
        localCompressedSize !== entry.compressedSize ||
        localUncompressedSize !== entry.uncompressedSize ||
        dataEnd !== nextBoundary
      ) {
        fail('invalid-entry-bounds');
      }
    }
  }
}

function validateDataDescriptor(
  buffer: Buffer,
  dataEnd: number,
  nextBoundary: number,
  entry: CentralDirectoryEntry,
): void {
  const hasSignature =
    nextBoundary - dataEnd === 16 &&
    readUInt32(buffer, dataEnd) === DATA_DESCRIPTOR_SIGNATURE;
  const descriptorLength = hasSignature ? 16 : 12;
  if (nextBoundary - dataEnd !== descriptorLength) {
    fail('invalid-entry-bounds');
  }
  const valueOffset = dataEnd + (hasSignature ? 4 : 0);
  if (
    readUInt32(buffer, valueOffset) !== entry.crc ||
    readUInt32(buffer, valueOffset + 4) !== entry.compressedSize ||
    readUInt32(buffer, valueOffset + 8) !== entry.uncompressedSize
  ) {
    fail('invalid-entry-bounds');
  }
}

function readRequiredXml(
  archive: Buffer,
  entry: CentralDirectoryEntry,
): string {
  if (entry.uncompressedSize > MAX_REQUIRED_XML_BYTES) {
    fail('required-xml-size-limit');
  }
  const compressed = archive.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );

  try {
    const content =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, {
            maxOutputLength: MAX_REQUIRED_XML_BYTES,
          });
    if (
      content.length !== entry.uncompressedSize ||
      crc32(content) !== entry.crc
    ) {
      fail('corrupt-required-xml');
    }
    return decodeXml(content);
  } catch (error) {
    if (error instanceof OoxmlValidationFailure) throw error;
    fail('corrupt-required-xml');
  }
}

function hasContentTypeOverride(
  xml: string,
  expectedPartName: string,
  expectedContentType: string,
): boolean {
  const source = sanitizeXmlForInspection(xml);
  if (!containsStartTag(source, 'Types')) return false;
  return findStartTagAttributes(source, 'Override').some(
    (attributes) =>
      attributes.get('PartName') === expectedPartName &&
      attributes.get('ContentType') === expectedContentType,
  );
}

function hasOfficeDocumentRelationship(
  xml: string,
  expectedTarget: string,
): boolean {
  const source = sanitizeXmlForInspection(xml);
  if (!containsStartTag(source, 'Relationships')) return false;
  return findStartTagAttributes(source, 'Relationship').some((attributes) => {
    const targetMode = attributes.get('TargetMode');
    return (
      OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(attributes.get('Type') ?? '') &&
      attributes.get('Target') === expectedTarget &&
      (!targetMode || targetMode === 'Internal')
    );
  });
}

function hasXmlRoot(xml: string, expectedLocalName: string): boolean {
  const source = sanitizeXmlForInspection(xml).trimStart();
  const root = createStartTagPattern(expectedLocalName).exec(source);
  return root?.index === 0;
}

function sanitizeXmlForInspection(xml: string): string {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    fail('corrupt-required-xml');
  }
  let source = xml.replace(/<!--[\s\S]*?-->/g, '');
  if (source.includes('<!--') || source.includes('-->')) {
    fail('corrupt-required-xml');
  }
  source = source.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (source.includes('<![CDATA[') || source.includes(']]>')) {
    fail('corrupt-required-xml');
  }
  source = source.replace(/<\?[\s\S]*?\?>/g, '');
  if (source.includes('<?') || source.includes('?>')) {
    fail('corrupt-required-xml');
  }
  return source;
}

function containsStartTag(xml: string, localName: string): boolean {
  return createStartTagPattern(localName).test(xml);
}

function findStartTagAttributes(
  xml: string,
  localName: string,
): Map<string, string>[] {
  const tags: Map<string, string>[] = [];
  const pattern = createStartTagPattern(localName);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml))) {
    const attributes = parseXmlAttributes(match[1]);
    if (attributes) tags.push(attributes);
  }
  return tags;
}

function createStartTagPattern(localName: string): RegExp {
  return new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b((?:[^"'<>]|"[^"]*"|'[^']*')*)\\s*\/?>`,
    'g',
  );
}

function parseXmlAttributes(source: string): Map<string, string> | undefined {
  const attributes = new Map<string, string>();
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (cursor >= source.length || source[cursor] === '/') break;
    const nameMatch = /^[A-Za-z_][\w:.-]*/.exec(source.slice(cursor));
    if (!nameMatch) return undefined;
    const name = nameMatch[0];
    cursor += name.length;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] !== '=') return undefined;
    cursor += 1;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") return undefined;
    const valueStart = cursor + 1;
    const valueEnd = source.indexOf(quote, valueStart);
    if (valueEnd < 0 || attributes.has(name)) return undefined;
    const value = decodeXmlAttribute(source.slice(valueStart, valueEnd));
    if (value === undefined) return undefined;
    attributes.set(name, value);
    cursor = valueEnd + 1;
  }
  return attributes;
}

function decodeXmlAttribute(value: string): string | undefined {
  let valid = true;
  const decoded = value.replace(
    /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi,
    (_entity, body: string) => {
      const lower = body.toLowerCase();
      if (lower === 'amp') return '&';
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'quot') return '"';
      if (lower === 'apos') return "'";
      const codePoint = lower.startsWith('#x')
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      if (
        !Number.isInteger(codePoint) ||
        codePoint < 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        valid = false;
        return '';
      }
      return String.fromCodePoint(codePoint);
    },
  );
  if (!valid || decoded.includes('&')) return undefined;
  return decoded;
}

function decodeXml(content: Buffer): string {
  try {
    if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
      return new TextDecoder('utf-16le', { fatal: true }).decode(
        content.subarray(2),
      );
    }
    if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
      if ((content.length - 2) % 2 !== 0) fail('corrupt-required-xml');
      const swapped = Buffer.allocUnsafe(content.length - 2);
      for (let index = 2; index < content.length; index += 2) {
        swapped[index - 2] = content[index + 1];
        swapped[index - 1] = content[index];
      }
      return new TextDecoder('utf-16le', { fatal: true }).decode(swapped);
    }
    const start =
      content.length >= 3 &&
      content[0] === 0xef &&
      content[1] === 0xbb &&
      content[2] === 0xbf
        ? 3
        : 0;
    return new TextDecoder('utf-8', { fatal: true }).decode(
      content.subarray(start),
    );
  } catch (error) {
    if (error instanceof OoxmlValidationFailure) throw error;
    fail('corrupt-required-xml');
  }
}

function assertEntryFlagsAndMethod(flags: number, method: number): void {
  if ((flags & ENCRYPTION_FLAGS) !== 0) fail('encrypted-entry');
  if (method !== 0 && method !== 8) fail('unsupported-compression');
}

function assertSafeEntryName(name: string): void {
  if (
    !name ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name) ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    fail('unsafe-entry-name');
  }
  const withoutDirectorySlash = name.endsWith('/') ? name.slice(0, -1) : name;
  if (
    !withoutDirectorySlash ||
    withoutDirectorySlash
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    fail('unsafe-entry-name');
  }
}

function assertExtraFields(
  buffer: Buffer,
  offset: number,
  length: number,
  limit: number,
): void {
  const end = checkedAdd(offset, length);
  assertRange(buffer, offset, length, limit);
  let cursor = offset;
  while (cursor < end) {
    assertRange(buffer, cursor, 4, end);
    const id = readUInt16(buffer, cursor);
    const valueLength = readUInt16(buffer, cursor + 2);
    cursor += 4;
    assertRange(buffer, cursor, valueLength, end);
    if (id === ZIP64_EXTRA_FIELD_ID) fail('zip64-not-supported');
    cursor += valueLength;
  }
}

function decodeEntryName(name: Buffer, utf8: boolean): string {
  try {
    return utf8
      ? new TextDecoder('utf-8', { fatal: true }).decode(name)
      : name.toString('latin1');
  } catch {
    fail('unsafe-entry-name');
  }
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < left) {
    fail('invalid-entry-bounds');
  }
  return result;
}

function assertRange(
  buffer: Buffer,
  offset: number,
  length: number,
  limit = buffer.length,
): void {
  const end = checkedAdd(offset, length);
  if (offset < 0 || length < 0 || end > limit || end > buffer.length) {
    fail('invalid-entry-bounds');
  }
}

function readUInt16(buffer: Buffer, offset: number): number {
  assertRange(buffer, offset, 2);
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer: Buffer, offset: number): number {
  assertRange(buffer, offset, 4);
  return buffer.readUInt32LE(offset);
}

function fail(reason: OoxmlDocumentValidationFailureReason): never {
  throw new OoxmlValidationFailure(reason);
}
