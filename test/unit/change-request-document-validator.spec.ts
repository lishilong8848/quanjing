import { deflateRawSync } from 'node:zlib';

import {
  OoxmlDocumentValidationResult,
  validateOoxmlDocument,
} from '../../server/modules/duty-schedule/change-request-document-validator';

type OoxmlExtension = '.docx' | '.xlsx';

interface ZipEntryFixture {
  name: string;
  data?: Buffer | string;
  compressedData?: Buffer;
  declaredCrc?: number;
  method?: 0 | 8;
  flags?: number;
  dataDescriptor?: boolean;
  centralName?: string;
  localName?: string;
  centralCompressedSize?: number;
  centralUncompressedSize?: number;
  localCompressedSize?: number;
  localUncompressedSize?: number;
  localHeaderOffset?: number;
  diskStart?: number;
  centralExtra?: Buffer;
  localExtra?: Buffer;
}

interface ZipFixtureOptions {
  diskNumber?: number;
  centralDirectoryDisk?: number;
  diskEntryCount?: number;
  totalEntryCount?: number;
  centralDirectorySize?: number;
  centralDirectoryOffset?: number;
}

const WORD_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const WORKBOOK_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const OFFICE_DOCUMENT_RELATIONSHIP =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

describe('OOXML change request document validator', () => {
  it.each<OoxmlExtension>(['.docx', '.xlsx'])(
    'accepts a structurally valid %s package',
    (extension) => {
      expect(
        validateOoxmlDocument(createOoxmlFixture(extension), extension),
      ).toEqual({
        valid: true,
      });
    },
  );

  it('accepts required XML entries that use ZIP data descriptors', () => {
    const archive = createOoxmlFixture('.docx', undefined, {
      requiredXmlDataDescriptor: true,
    });

    expect(validateOoxmlDocument(archive, '.docx')).toEqual({ valid: true });
  });

  it('accepts required XML entries stored without compression', () => {
    const archive = createOoxmlFixture('.xlsx', undefined, {
      requiredMethod: 0,
    });

    expect(validateOoxmlDocument(archive, '.xlsx')).toEqual({ valid: true });
  });

  it('rejects a generic ZIP whose payload merely contains forged OOXML entry strings', () => {
    const archive = createZip([
      {
        name: 'payload.txt',
        data: '[Content_Types].xml _rels/.rels word/document.xml',
      },
    ]);

    expectInvalid(archive, '.docx', 'missing-required-entry');
  });

  it.each([
    '../escape.xml',
    'word\\document.xml',
    '/absolute.xml',
    'C:/drive.xml',
  ])('rejects the unsafe entry path %s', (name) => {
    const archive = createOoxmlFixture('.docx', [{ name, data: 'x' }]);

    expectInvalid(archive, '.docx', 'unsafe-entry-name');
  });

  it('rejects duplicate normalized entry names', () => {
    const archive = createOoxmlFixture('.docx', [
      { name: 'word/document.xml', data: '<duplicate />' },
    ]);

    expectInvalid(archive, '.docx', 'duplicate-entry');
  });

  it('rejects encrypted entries', () => {
    const archive = createOoxmlFixture('.docx', undefined, {
      contentTypesFlags: 0x0001,
    });

    expectInvalid(archive, '.docx', 'encrypted-entry');
  });

  it.each([
    {
      label: 'EOCD entry-count sentinel',
      archive: () =>
        createOoxmlFixture('.docx', undefined, {
          zipOptions: { totalEntryCount: 0xffff },
        }),
    },
    {
      label: 'central directory size sentinel',
      archive: () =>
        createOoxmlFixture('.docx', undefined, {
          zipOptions: { centralDirectorySize: 0xffffffff },
        }),
    },
    {
      label: 'ZIP64 extra field',
      archive: () =>
        createOoxmlFixture('.docx', [
          {
            name: 'custom/item.xml',
            data: 'x',
            centralExtra: createExtraField(0x0001, Buffer.alloc(8)),
          },
        ]),
    },
  ])('rejects ZIP64 metadata: $label', ({ archive }) => {
    expectInvalid(archive(), '.docx', 'zip64-not-supported');
  });

  it.each([
    { diskNumber: 1 },
    { centralDirectoryDisk: 1 },
    { diskEntryCount: 2 },
  ])('rejects multi-disk EOCD metadata %#', (zipOptions) => {
    expectInvalid(
      createOoxmlFixture('.docx', undefined, { zipOptions }),
      '.docx',
      'multi-disk-not-supported',
    );
  });

  it('rejects a central-directory entry that points outside the local-file region', () => {
    const archive = createOoxmlFixture('.docx', [
      {
        name: 'custom/item.xml',
        data: 'x',
        localHeaderOffset: 0x7fffffff,
      },
    ]);

    expectInvalid(archive, '.docx', 'invalid-entry-bounds');
  });

  it('rejects an archive containing more than 4096 entries', () => {
    const fillerEntries = Array.from({ length: 4094 }, (_, index) => ({
      name: `custom/item-${index}.bin`,
      data: Buffer.alloc(0),
      method: 0 as const,
    }));

    expectInvalid(
      createOoxmlFixture('.docx', fillerEntries),
      '.docx',
      'too-many-entries',
    );
  });

  it('rejects a declared total uncompressed size above 100 MiB', () => {
    const oversizedEntries = Array.from({ length: 3 }, (_, index) => ({
      name: `custom/large-${index}.bin`,
      data: 'x',
      centralUncompressedSize: 40 * 1024 * 1024,
      localUncompressedSize: 40 * 1024 * 1024,
    }));

    expectInvalid(
      createOoxmlFixture('.docx', oversizedEntries),
      '.docx',
      'total-uncompressed-size-limit',
    );
  });

  it('rejects a single entry above the uncompressed-size limit', () => {
    const archive = createOoxmlFixture('.docx', [
      {
        name: 'custom/large.bin',
        data: 'x',
        centralUncompressedSize: 51 * 1024 * 1024,
        localUncompressedSize: 51 * 1024 * 1024,
      },
    ]);

    expectInvalid(archive, '.docx', 'entry-uncompressed-size-limit');
  });

  it('rejects an abnormal declared compression ratio', () => {
    const archive = createOoxmlFixture('.docx', [
      {
        name: 'custom/bomb.bin',
        data: 'x',
        centralUncompressedSize: 10 * 1024 * 1024,
        localUncompressedSize: 10 * 1024 * 1024,
      },
    ]);

    expectInvalid(archive, '.docx', 'compression-ratio-limit');
  });

  it.each<OoxmlExtension>(['.docx', '.xlsx'])(
    'requires the exact main-part content type for %s',
    (extension) => {
      const correctType =
        extension === '.docx'
          ? WORD_MAIN_CONTENT_TYPE
          : WORKBOOK_MAIN_CONTENT_TYPE;
      const contentTypes = `<?xml version="1.0"?><Types><Override PartName="/${mainPart(extension)}" ContentType="application/octet-stream"/><!-- <Override PartName="/${mainPart(extension)}" ContentType="${correctType}"/> --></Types>`;

      expectInvalid(
        createOoxmlFixture(extension, undefined, { contentTypes }),
        extension,
        'invalid-content-types',
      );
    },
  );

  it('requires the package relationship to point to the matching main part', () => {
    const relationships = `<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="${OFFICE_DOCUMENT_RELATIONSHIP}" Target="xl/workbook.xml"/></Relationships>`;

    expectInvalid(
      createOoxmlFixture('.docx', undefined, { relationships }),
      '.docx',
      'invalid-package-relationships',
    );
  });

  it('rejects corrupted compressed required XML without throwing', () => {
    const archive = createOoxmlFixture('.docx');
    const contentTypesDataOffset = localEntryDataOffset(archive, 0);
    archive[contentTypesDataOffset] ^= 0xff;

    expectInvalid(archive, '.docx', 'corrupt-required-xml');
  });

  it('rejects a corrupted compressed Word main part without throwing', () => {
    const archive = createOoxmlFixture('.docx', undefined, {
      mainPartCompressedData: Buffer.from([0xff, 0xff, 0xff]),
    });

    expectInvalid(archive, '.docx', 'corrupt-required-xml');
  });

  it('rejects an Excel main part whose declared CRC does not match its XML', () => {
    const archive = createOoxmlFixture('.xlsx', undefined, {
      mainPartDeclaredCrc: 0,
    });

    expectInvalid(archive, '.xlsx', 'corrupt-required-xml');
  });

  it.each([
    { extension: '.docx' as const, mainPartXml: '<w:workbook />' },
    { extension: '.xlsx' as const, mainPartXml: '<x:document />' },
  ])(
    'rejects a $extension main part with the wrong XML root',
    ({ extension, mainPartXml }) => {
      const archive = createOoxmlFixture(extension, undefined, {
        mainPartXml,
      });

      expectInvalid(archive, extension, 'corrupt-required-xml');
    },
  );
});

function expectInvalid(
  archive: Buffer,
  extension: OoxmlExtension,
  reason: OoxmlDocumentValidationResult extends { reason?: infer Reason }
    ? Reason
    : never,
): void {
  expect(validateOoxmlDocument(archive, extension)).toEqual({
    valid: false,
    reason,
  });
}

function createOoxmlFixture(
  extension: OoxmlExtension,
  additionalEntries: ZipEntryFixture[] = [],
  options: {
    contentTypes?: string;
    relationships?: string;
    contentTypesFlags?: number;
    requiredXmlDataDescriptor?: boolean;
    requiredMethod?: 0 | 8;
    mainPartXml?: string;
    mainPartCompressedData?: Buffer;
    mainPartDeclaredCrc?: number;
    zipOptions?: ZipFixtureOptions;
  } = {},
): Buffer {
  const partName = mainPart(extension);
  const contentType =
    extension === '.docx' ? WORD_MAIN_CONTENT_TYPE : WORKBOOK_MAIN_CONTENT_TYPE;
  const contentTypes =
    options.contentTypes ??
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override ContentType="${contentType}" PartName="/${partName}"/></Types>`;
  const relationships =
    options.relationships ??
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="${partName}" Type="${OFFICE_DOCUMENT_RELATIONSHIP}" Id="rId1"/></Relationships>`;

  return createZip(
    [
      {
        name: '[Content_Types].xml',
        data: contentTypes,
        flags: options.contentTypesFlags,
        dataDescriptor: options.requiredXmlDataDescriptor,
        method: options.requiredMethod,
      },
      {
        name: '_rels/.rels',
        data: relationships,
        dataDescriptor: options.requiredXmlDataDescriptor,
        method: options.requiredMethod,
      },
      {
        name: partName,
        data:
          options.mainPartXml ??
          (extension === '.docx'
            ? '<w:document xmlns:w="urn:test" />'
            : '<workbook xmlns="urn:test" />'),
        compressedData: options.mainPartCompressedData,
        declaredCrc: options.mainPartDeclaredCrc,
        method: options.requiredMethod,
      },
      ...additionalEntries,
    ],
    options.zipOptions,
  );
}

function mainPart(extension: OoxmlExtension): string {
  return extension === '.docx' ? 'word/document.xml' : 'xl/workbook.xml';
}

function createZip(
  entries: ZipEntryFixture[],
  options: ZipFixtureOptions = {},
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? '');
    const method = entry.method ?? 8;
    const compressedData =
      entry.compressedData ?? (method === 8 ? deflateRawSync(data) : data);
    const flags = (entry.flags ?? 0x0800) | (entry.dataDescriptor ? 0x0008 : 0);
    const crc = entry.declaredCrc ?? crc32(data);
    const centralCompressedSize =
      entry.centralCompressedSize ?? compressedData.length;
    const centralUncompressedSize =
      entry.centralUncompressedSize ?? data.length;
    const localCompressedSize =
      entry.localCompressedSize ?? centralCompressedSize;
    const localUncompressedSize =
      entry.localUncompressedSize ?? centralUncompressedSize;
    const localName = Buffer.from(entry.localName ?? entry.name);
    const centralName = Buffer.from(entry.centralName ?? entry.name);
    const localExtra = entry.localExtra ?? Buffer.alloc(0);
    const centralExtra = entry.centralExtra ?? Buffer.alloc(0);
    const localHeader = Buffer.alloc(30);

    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    if (!entry.dataDescriptor) {
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(localCompressedSize, 18);
      localHeader.writeUInt32LE(localUncompressedSize, 22);
    }
    localHeader.writeUInt16LE(localName.length, 26);
    localHeader.writeUInt16LE(localExtra.length, 28);

    const descriptor = entry.dataDescriptor
      ? createDataDescriptor(
          crc,
          centralCompressedSize,
          centralUncompressedSize,
        )
      : Buffer.alloc(0);
    const localPart = Buffer.concat([
      localHeader,
      localName,
      localExtra,
      compressedData,
      descriptor,
    ]);
    localParts.push(localPart);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(centralCompressedSize, 20);
    centralHeader.writeUInt32LE(centralUncompressedSize, 24);
    centralHeader.writeUInt16LE(centralName.length, 28);
    centralHeader.writeUInt16LE(centralExtra.length, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(entry.diskStart ?? 0, 34);
    centralHeader.writeUInt32LE(entry.localHeaderOffset ?? localOffset, 42);
    centralParts.push(
      Buffer.concat([centralHeader, centralName, centralExtra]),
    );

    localOffset += localPart.length;
  }

  const locals = Buffer.concat(localParts);
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.diskNumber ?? 0, 4);
  end.writeUInt16LE(options.centralDirectoryDisk ?? 0, 6);
  end.writeUInt16LE(options.diskEntryCount ?? entries.length, 8);
  end.writeUInt16LE(options.totalEntryCount ?? entries.length, 10);
  end.writeUInt32LE(
    options.centralDirectorySize ?? centralDirectory.length,
    12,
  );
  end.writeUInt32LE(options.centralDirectoryOffset ?? locals.length, 16);

  return Buffer.concat([locals, centralDirectory, end]);
}

function createDataDescriptor(
  crc: number,
  compressedSize: number,
  uncompressedSize: number,
): Buffer {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(uncompressedSize, 12);
  return descriptor;
}

function createExtraField(id: number, value: Buffer): Buffer {
  const field = Buffer.alloc(4 + value.length);
  field.writeUInt16LE(id, 0);
  field.writeUInt16LE(value.length, 2);
  value.copy(field, 4);
  return field;
}

function localEntryDataOffset(
  archive: Buffer,
  localHeaderOffset: number,
): number {
  const nameLength = archive.readUInt16LE(localHeaderOffset + 26);
  const extraLength = archive.readUInt16LE(localHeaderOffset + 28);
  return localHeaderOffset + 30 + nameLength + extraLength;
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
