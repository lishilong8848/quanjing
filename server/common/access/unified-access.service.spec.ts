import {
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import {
  ACCESS_SESSION_TTL_MS,
  hashAccessPassword,
  UnifiedAccessService,
  verifyAccessPassword,
} from './unified-access.service';

describe('UnifiedAccessService', () => {
  it('roundtrips a trusted H building administrator session', () => {
    const previous = process.env.LOCAL_ACCESS_SESSION_SECRET;
    process.env.LOCAL_ACCESS_SESSION_SECRET = Buffer.alloc(32, 17).toString('base64');
    try {
      const service = new UnifiedAccessService();
      const login = service.issueTrustedSession({ role: 'building_admin', purchaseBuilding: 'H楼' });
      expect(service.readSession(login.token).principal).toEqual({ role: 'building_admin', purchaseBuilding: 'H楼' });
    } finally {
      if (previous === undefined) delete process.env.LOCAL_ACCESS_SESSION_SECRET;
      else process.env.LOCAL_ACCESS_SESSION_SECRET = previous;
    }
  });

  const now = 1_800_000_000_000;
  const adminPassword = 'dummy-admin-password';
  const editorPassword = 'dummy-editor-password';
  const purchaseAdminPassword = 'test-only-purchase-admin-7M4Q';
  const constructionAdminPassword = 'test-only-construction-admin-B7K3';
  const purchaseApplicantPasswords = {
    A楼: 'test-only-applicant-a-K9P2',
    B楼: 'test-only-applicant-b-R3V8',
    C楼: 'test-only-applicant-c-W6N1',
    D楼: 'test-only-applicant-d-F2T7',
    E楼: 'test-only-applicant-e-X8C5',
    H楼: 'test-only-applicant-h-J4L9',
  } as const;
  const inventoryAdministratorPasswords = {
    A楼: 'test-only-inventory-a-Q2W7',
    B楼: 'test-only-inventory-b-M4R9',
    C楼: 'test-only-inventory-c-V6T1',
    D楼: 'test-only-inventory-d-Y8U3',
    E楼: 'test-only-inventory-e-H5J2',
    H楼: 'test-only-inventory-h-K7L4',
  } as const;
  const wrongPassword = 'dummy-wrong-password';
  const sessionSecret = Buffer.alloc(32, 7).toString('base64');
  let adminHash: string;
  let editorHash: string;
  let purchaseAdminHash: string;
  let constructionAdminHash: string;
  let purchaseApplicantHashes: Record<
    keyof typeof purchaseApplicantPasswords,
    string
  >;
  let inventoryAdministratorHashes: Record<
    keyof typeof inventoryAdministratorPasswords,
    string
  >;
  const buildingAdministratorPassword = 'test-only-building-110-Q8M4';
  let buildingAdministratorHash: string;

  beforeAll(() => {
    adminHash = hashAccessPassword(adminPassword);
    editorHash = hashAccessPassword(editorPassword);
    purchaseAdminHash = hashAccessPassword(purchaseAdminPassword);
    constructionAdminHash = hashAccessPassword(constructionAdminPassword);
    purchaseApplicantHashes = Object.fromEntries(
      Object.entries(purchaseApplicantPasswords).map(([building, password]) => [
        building,
        hashAccessPassword(password),
      ]),
    ) as Record<keyof typeof purchaseApplicantPasswords, string>;
    inventoryAdministratorHashes = Object.fromEntries(
      Object.entries(inventoryAdministratorPasswords).map(
        ([building, password]) => [building, hashAccessPassword(password)],
      ),
    ) as Record<keyof typeof inventoryAdministratorPasswords, string>;
    buildingAdministratorHash = hashAccessPassword(buildingAdministratorPassword);
  });

  it.each([
    [undefined, true],
    ['', true],
    ['true', true],
    ['unexpected-value', true],
    [' false ', false],
    ['FALSE', false],
  ] as const)(
    'treats LOCAL_ACCESS_CONTROL_ENABLED=%p as enabled=%s',
    (configuredValue, expected) => {
      const service = createConfiguredService({
        accessControlEnabled: configuredValue,
      });

      expect(service.isAccessControlEnabled()).toBe(expected);
    },
  );

  it('uses a stable unrestricted principal fingerprint without a session secret', () => {
    const first = createConfiguredService({ accessControlEnabled: 'false' });
    const second = createConfiguredService({ accessControlEnabled: 'false' });

    expect(first.getUnrestrictedPrincipalFingerprint()).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(second.getUnrestrictedPrincipalFingerprint()).toBe(
      first.getUnrestrictedPrincipalFingerprint(),
    );
  });

  it('uses a random, canonical scrypt hash with a sufficiently long salt', async () => {
    const first = hashAccessPassword('dummy-hash-password');
    const second = hashAccessPassword('dummy-hash-password');
    const [, saltBase64, derivedBase64] = first.split('$');

    expect(first).toMatch(
      /^scrypt\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/,
    );
    expect(first).not.toContain('dummy-hash-password');
    expect(first).not.toBe(second);
    expect(Buffer.from(saltBase64, 'base64').length).toBeGreaterThanOrEqual(16);
    expect(Buffer.from(derivedBase64, 'base64')).toHaveLength(32);
    await expect(
      verifyAccessPassword('dummy-hash-password', first),
    ).resolves.toBe(true);
    await expect(verifyAccessPassword(wrongPassword, first)).resolves.toBe(
      false,
    );
  });

  it('rejects empty passwords and malformed or non-canonical hashes safely', async () => {
    expect(() => hashAccessPassword('')).toThrow();

    const shortSalt = Buffer.alloc(15, 1).toString('base64');
    const shortDerived = Buffer.alloc(31, 2).toString('base64');
    const validSalt = Buffer.alloc(16, 1).toString('base64');
    const validDerived = Buffer.alloc(32, 2).toString('base64');
    const malformed = [
      '',
      'scrypt',
      `argon2$${validSalt}$${validDerived}`,
      `scrypt$${shortSalt}$${validDerived}`,
      `scrypt$${validSalt}$${shortDerived}`,
      `scrypt$${validSalt.replace(/=+$/, '')}$${validDerived}`,
      `scrypt$${validSalt}$${validDerived}!`,
      `scrypt$${validSalt}$${validDerived}$extra`,
    ];

    for (const encoded of malformed) {
      await expect(verifyAccessPassword(adminPassword, encoded)).resolves.toBe(
        false,
      );
    }
  });

  it.each([
    ['admin', adminPassword],
    ['editor', editorPassword],
  ] as const)(
    'recognizes a valid %s login without leaking credentials into the token',
    async (role, password) => {
      const service = createConfiguredService({
        adminHash,
        editorHash,
        sessionSecret,
      });

      const result = await service.login(
        { accountType: role, password },
        '192.0.2.10',
        now,
      );
      const [encodedPayload] = result.token.split('.');
      const payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as Record<string, unknown>;

      expect(result).toMatchObject({
        principal: { role, purchaseBuilding: null },
        expiresAt: now + ACCESS_SESSION_TTL_MS,
      });
      expect(Object.keys(payload).sort()).toEqual(
        [
          'expiresAt',
          'issuedAt',
          'purchaseBuilding',
          'role',
          'sessionFamilyId',
          'version',
        ].sort(),
      );
      expect(payload).toEqual({
        version: 3,
        role,
        purchaseBuilding: null,
        issuedAt: now,
        expiresAt: now + ACCESS_SESSION_TTL_MS,
        sessionFamilyId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      });
      expect(result.token).not.toContain(password);
      expect(result.token).not.toContain('192.0.2.10');
      expect(service.readSession(result.token, now)).toEqual({
        principal: { role, purchaseBuilding: null },
        expiresAt: now + ACCESS_SESSION_TTL_MS,
      });
    },
  );

  it('recognizes the independent 110 station administrator by password alone', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      buildingAdministratorHashes: { '110站': buildingAdministratorHash },
      sessionSecret,
    });
    await expect(
      service.login({ password: buildingAdministratorPassword }, '192.0.2.30', now),
    ).resolves.toMatchObject({
      principal: { role: 'building_admin', purchaseBuilding: '110站' },
    });
  });

  it('accepts a six-digit numeric password for password-only login', async () => {
    const service = createConfiguredService({
      adminHash: hashAccessPassword('123456'),
      editorHash,
      sessionSecret,
    });
    await expect(service.login({ password: '123456' }, '192.0.2.32', now)).resolves.toMatchObject({
      principal: { role: 'admin', purchaseBuilding: null },
      expiresAt: now + ACCESS_SESSION_TTL_MS,
    });
  });

  it('rejects an ambiguous password without assigning either role', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash: hashAccessPassword(adminPassword),
      sessionSecret,
    });
    await expect(
      service.login({ password: adminPassword }, '192.0.2.31', now),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each([
    ['admin', adminPassword],
    ['editor', editorPassword],
  ] as const)(
    'resolves a password-only unified login as %s',
    async (role, password) => {
      const service = createConfiguredService({
        adminHash,
        editorHash,
        sessionSecret,
      });

      await expect(
        service.login({ password } as never, '192.0.2.11', now),
      ).resolves.toMatchObject({
        principal: { role, purchaseBuilding: null },
        expiresAt: now + ACCESS_SESSION_TTL_MS,
      });
    },
  );

  it('logs in a purchase administrator with a null building scope', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      purchaseAdminHash,
      purchaseApplicantHashes,
      sessionSecret,
    });

    await expect(
      service.login(
        {
          accountType: 'purchase_admin',
          password: purchaseAdminPassword,
        } as never,
        '192.0.2.17',
        now,
      ),
    ).resolves.toMatchObject({
      principal: { role: 'purchase_admin', purchaseBuilding: null },
      expiresAt: now + ACCESS_SESSION_TTL_MS,
    });
  });

  it('logs in a construction administrator with a null building scope', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      constructionAdminHash,
      sessionSecret,
    });

    await expect(
      service.login(
        {
          accountType: 'construction_admin',
          password: constructionAdminPassword,
        } as never,
        '192.0.2.24',
        now,
      ),
    ).resolves.toMatchObject({
      principal: { role: 'construction_admin', purchaseBuilding: null },
      expiresAt: now + ACCESS_SESSION_TTL_MS,
    });
  });

  it('rejects the retired contract administrator login identity', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      purchaseAdminHash,
      purchaseApplicantHashes,
      sessionSecret,
    });

    await expect(
      service.login(
        {
          accountType: 'contract_admin',
          password: purchaseAdminPassword,
        } as never,
        '192.0.2.21',
        now,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it.each(Object.entries(purchaseApplicantPasswords))(
    'logs in the %s purchase applicant with only that building password',
    async (purchaseBuilding, password) => {
      const service = createConfiguredService({
        adminHash,
        editorHash,
        purchaseAdminHash,
        purchaseApplicantHashes,
        sessionSecret,
      });

      await expect(
        service.login(
          {
            accountType: 'purchase_applicant',
            purchaseBuilding,
            password,
          } as never,
          '192.0.2.18',
          now,
        ),
      ).resolves.toMatchObject({
        principal: { role: 'purchase_applicant', purchaseBuilding },
      });
    },
  );

  it.each(Object.entries(inventoryAdministratorPasswords))(
    'logs in the %s inventory administrator with only that building password',
    async (purchaseBuilding, password) => {
      const service = createConfiguredService({
        adminHash,
        editorHash,
        purchaseAdminHash,
        purchaseApplicantHashes,
        inventoryAdministratorHashes,
        sessionSecret,
      });

      await expect(
        service.login(
          {
            accountType: 'inventory_admin',
            purchaseBuilding,
            password,
          } as never,
          '192.0.2.22',
          now,
        ),
      ).resolves.toMatchObject({
        principal: { role: 'inventory_admin', purchaseBuilding },
      });
    },
  );

  it('rejects a valid inventory administrator password selected for another building', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      purchaseAdminHash,
      purchaseApplicantHashes,
      inventoryAdministratorHashes,
      sessionSecret,
    });

    await expect(
      service.login(
        {
          accountType: 'inventory_admin',
          purchaseBuilding: 'B楼',
          password: inventoryAdministratorPasswords['A楼'],
        } as never,
        '192.0.2.23',
        now,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a valid applicant password selected for the wrong building', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      purchaseAdminHash,
      purchaseApplicantHashes,
      sessionSecret,
    });

    await expect(
      service.login(
        {
          accountType: 'purchase_applicant',
          purchaseBuilding: 'B楼',
          password: purchaseApplicantPasswords['A楼'],
        } as never,
        '192.0.2.19',
        now,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('uses one indistinguishable unauthorized response for an invalid password', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });

    let error: unknown;
    try {
      await service.login(
        { accountType: 'admin', password: wrongPassword },
        '192.0.2.11',
        now,
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as HttpException).getStatus()).toBe(401);
    expect(JSON.stringify((error as HttpException).getResponse())).not.toMatch(
      /admin|editor|管理员|编辑员/i,
    );
  });

  it.each([
    ['missing admin hash', 'admin', adminPassword, { adminHash: '' }],
    ['missing editor hash', 'editor', editorPassword, { editorHash: '' }],
    [
      'bad admin hash',
      'admin',
      adminPassword,
      { adminHash: 'not-a-scrypt-hash' },
    ],
    [
      'bad editor hash',
      'editor',
      editorPassword,
      { editorHash: 'not-a-scrypt-hash' },
    ],
    ['missing secret', 'admin', adminPassword, { sessionSecret: '' }],
    [
      'short secret',
      'admin',
      adminPassword,
      { sessionSecret: Buffer.alloc(31, 4).toString('base64') },
    ],
    [
      'non-canonical secret',
      'admin',
      adminPassword,
      { sessionSecret: `${sessionSecret.slice(0, -1)}_` },
    ],
  ] as const)(
    'fails closed on %s',
    async (_label, accountType, password, overrides) => {
      const service = createConfiguredService({
        adminHash,
        editorHash,
        sessionSecret,
        ...overrides,
      });

      await expect(
        service.login(accessRequest(accountType, password), '192.0.2.12', now),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(service.readSession('malformed-token', now)).toEqual({
        principal: { role: 'guest', purchaseBuilding: null },
        expiresAt: null,
      });
      expect(service.renew('malformed-token', now)).toBeNull();
    },
  );

  it('reports core, inventory, purchase, and construction readiness independently', () => {
    const configured = createConfiguredService({
      adminHash,
      editorHash,
      purchaseAdminHash,
      purchaseApplicantHashes,
      inventoryAdministratorHashes,
      constructionAdminHash,
      sessionSecret,
    });
    expect(configured.configurationReadiness()).toEqual({
      core: true,
      inventory: true,
      purchase: true,
      construction: true,
    });

    const missingInventoryBuilding = createConfiguredService({
      adminHash,
      editorHash,
      purchaseAdminHash,
      purchaseApplicantHashes,
      inventoryAdministratorHashes: {
        ...inventoryAdministratorHashes,
        H楼: '',
      },
      constructionAdminHash,
      sessionSecret,
    });
    expect(missingInventoryBuilding.configurationReadiness()).toEqual({
      core: true,
      inventory: false,
      purchase: true,
      construction: true,
    });

    const invalidEditor = createConfiguredService({
      adminHash,
      editorHash: 'invalid-test-hash',
      purchaseAdminHash,
      purchaseApplicantHashes,
      inventoryAdministratorHashes,
      constructionAdminHash,
      sessionSecret,
    });
    expect(invalidEditor.configurationReadiness()).toEqual({
      core: false,
      inventory: true,
      purchase: true,
      construction: true,
    });

    const missingPurchaseBuilding = createConfiguredService({
      adminHash,
      editorHash,
      purchaseAdminHash,
      purchaseApplicantHashes: {
        ...purchaseApplicantHashes,
        H楼: '',
      },
      inventoryAdministratorHashes,
      constructionAdminHash,
      sessionSecret,
    });
    expect(missingPurchaseBuilding.configurationReadiness()).toEqual({
      core: true,
      inventory: true,
      purchase: false,
      construction: true,
    });

    const invalidConstruction = createConfiguredService({
      adminHash,
      editorHash,
      purchaseAdminHash,
      purchaseApplicantHashes,
      inventoryAdministratorHashes,
      constructionAdminHash: 'invalid-test-hash',
      sessionSecret,
    });
    expect(invalidConstruction.configurationReadiness()).toEqual({
      core: true,
      inventory: true,
      purchase: true,
      construction: false,
    });
  });

  it('supports the legacy session secret only when the preferred secret is absent', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret: undefined,
      legacySessionSecret: sessionSecret,
    });

    await expect(
      service.login(accessRequest('editor', editorPassword), '192.0.2.13', now),
    ).resolves.toMatchObject({
      principal: { role: 'editor', purchaseBuilding: null },
    });

    const invalidPreferred = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret: 'invalid-preferred-secret',
      legacySessionSecret: sessionSecret,
    });
    await expect(
      invalidPreferred.login(
        accessRequest('editor', editorPassword),
        '192.0.2.13',
        now,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects tampered tokens and malformed token input without throwing', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });
    const { token } = await service.login(
      accessRequest('admin', adminPassword),
      '192.0.2.14',
      now,
    );
    const [payload, signature] = token.split('.');
    const tamperedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    const inputs: Array<string | undefined> = [
      undefined,
      '',
      'no-dot',
      `${payload}.${tamperedSignature}`,
      `${payload}.${signature}.extra`,
      `*.${signature}`,
    ];

    for (const input of inputs) {
      expect(() => service.readSession(input, now)).not.toThrow();
      expect(service.readSession(input, now)).toEqual({
        principal: { role: 'guest', purchaseBuilding: null },
        expiresAt: null,
      });
    }
  });

  it('accepts a session before one hour and rejects it exactly at one hour', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });
    const result = await service.login(
      accessRequest('admin', adminPassword),
      '192.0.2.15',
      now,
    );

    expect(service.readSession(result.token, now + 59 * 60 * 1000)).toEqual({
      principal: { role: 'admin', purchaseBuilding: null },
      expiresAt: now + ACCESS_SESSION_TTL_MS,
    });
    expect(
      service.readSession(result.token, now + ACCESS_SESSION_TTL_MS),
    ).toEqual({
      principal: { role: 'guest', purchaseBuilding: null },
      expiresAt: null,
    });
  });

  it.each([
    'admin',
    'duty_editor',
    'supply_chain_admin',
    'construction_admin',
  ] as const)('issues, parses, and renews a trusted %s v3 session', (role) => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });
    const issued = service.issueTrustedSession(
      { role, purchaseBuilding: null },
      now,
    );
    const [encodedPayload] = issued.token.split('.');

    expect(
      JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')),
    ).toEqual({
      version: 3,
      role,
      purchaseBuilding: null,
      issuedAt: now,
      expiresAt: now + ACCESS_SESSION_TTL_MS,
      sessionFamilyId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    });
    expect(issued.principalFingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(service.readSession(issued.token, now)).toEqual({
      principal: { role, purchaseBuilding: null },
      expiresAt: now + ACCESS_SESSION_TTL_MS,
    });

    const renewedAt = now + 5 * 60 * 1000;
    const renewed = service.renew(issued.token, renewedAt);
    expect(renewed).toMatchObject({
      principal: { role, purchaseBuilding: null },
      expiresAt: renewedAt + ACCESS_SESSION_TTL_MS,
      principalFingerprint: issued.principalFingerprint,
    });
    expect(renewed?.token).not.toBe(issued.token);
    expect(service.readSession(renewed?.token, renewedAt)).toEqual({
      principal: { role, purchaseBuilding: null },
      expiresAt: renewedAt + ACCESS_SESSION_TTL_MS,
    });
  });

  it('uses a new principal fingerprint for every new privileged login', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });

    const first = await service.login(
      accessRequest('editor', editorPassword),
      '192.0.2.30',
      now,
    );
    const second = await service.login(
      accessRequest('editor', editorPassword),
      '192.0.2.30',
      now + 1,
    );

    expect(first.principalFingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.principalFingerprint).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.principalFingerprint).not.toBe(first.principalFingerprint);
  });

  it('returns a stable trusted fingerprint for the current session and null for guests', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });
    const issued = await service.login(
      accessRequest('editor', editorPassword),
      '192.0.2.31',
      now,
    );

    expect(service.readSessionIdentity(issued.token, now)).toEqual({
      principal: { role: 'editor', purchaseBuilding: null },
      expiresAt: now + ACCESS_SESSION_TTL_MS,
      principalFingerprint: issued.principalFingerprint,
    });
    expect(service.readSessionIdentity(undefined, now)).toEqual({
      principal: { role: 'guest', purchaseBuilding: null },
      expiresAt: null,
      principalFingerprint: null,
    });
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'not-a-valid-session-secret'],
  ] as const)(
    'rejects trusted session issuance when the session secret is %s',
    (_label, configuredSessionSecret) => {
      const service = createConfiguredService({
        adminHash,
        editorHash,
        sessionSecret: configuredSessionSecret,
      });

      expect(() =>
        service.issueTrustedSession(
          { role: 'duty_editor', purchaseBuilding: null },
          now,
        ),
      ).toThrow(ServiceUnavailableException);
    },
  );

  it.each([
    ['guest role', { role: 'guest', purchaseBuilding: null }],
    ['unknown role', { role: 'root', purchaseBuilding: null }],
    [
      'Feishu role with building scope',
      { role: 'duty_editor', purchaseBuilding: 'A楼' },
    ],
    [
      'local null-scoped role with building scope',
      { role: 'admin', purchaseBuilding: 'A楼' },
    ],
    [
      'local building-scoped role without a building',
      { role: 'inventory_admin', purchaseBuilding: null },
    ],
    [
      'local building-scoped role with an invalid building',
      { role: 'purchase_applicant', purchaseBuilding: 'G楼' },
    ],
  ])('rejects a trusted principal with %s at runtime', (_label, principal) => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });

    expect(() => service.issueTrustedSession(principal as never, now)).toThrow(
      UnauthorizedException,
    );
  });

  it.each([
    ['admin', null],
    ['editor', null],
    ['purchase_admin', null],
    ['inventory_admin', 'A楼'],
    ['purchase_applicant', 'B楼'],
  ] as const)(
    'continues to parse an existing local v2 %s session',
    (role, purchaseBuilding) => {
      const service = createConfiguredService({
        adminHash,
        editorHash,
        sessionSecret,
      });
      const expiresAt = now + 1_000;
      const token = signTestToken(
        {
          version: 2,
          role,
          purchaseBuilding,
          issuedAt: now,
          expiresAt,
        },
        sessionSecret,
      );

      expect(service.readSession(token, now)).toEqual({
        principal: { role, purchaseBuilding },
        expiresAt,
      });
    },
  );

  it.each([
    [
      'purchase administrator with a building scope',
      {
        version: 2,
        role: 'purchase_admin',
        purchaseBuilding: 'A楼',
        issuedAt: now,
        expiresAt: now + 1_000,
      },
    ],
    [
      'administrator with a building scope',
      {
        version: 2,
        role: 'admin',
        purchaseBuilding: 'B楼',
        issuedAt: now,
        expiresAt: now + 1_000,
      },
    ],
    [
      'editor with a building scope',
      {
        version: 2,
        role: 'editor',
        purchaseBuilding: 'C楼',
        issuedAt: now,
        expiresAt: now + 1_000,
      },
    ],
    [
      'purchase applicant without a building scope',
      {
        version: 2,
        role: 'purchase_applicant',
        purchaseBuilding: null,
        issuedAt: now,
        expiresAt: now + 1_000,
      },
    ],
    [
      'purchase applicant with an invalid building scope',
      {
        version: 2,
        role: 'purchase_applicant',
        purchaseBuilding: 'G楼',
        issuedAt: now,
        expiresAt: now + 1_000,
      },
    ],
  ])('rejects a correctly signed v2 token for %s', (_label, payload) => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });
    const token = signTestToken(payload, sessionSecret);

    expect(service.readSession(token, now)).toEqual({
      principal: { role: 'guest', purchaseBuilding: null },
      expiresAt: null,
    });
  });

  it.each([
    [
      'guest role',
      {
        version: 2,
        role: 'guest',
        purchaseBuilding: null,
        issuedAt: now,
        expiresAt: now + 1_000,
      },
    ],
    [
      'future issue time',
      {
        version: 2,
        role: 'admin',
        purchaseBuilding: null,
        issuedAt: now + 1,
        expiresAt: now + ACCESS_SESSION_TTL_MS,
      },
    ],
    [
      'excessive ttl',
      {
        version: 2,
        role: 'editor',
        purchaseBuilding: null,
        issuedAt: now,
        expiresAt: now + ACCESS_SESSION_TTL_MS + 1,
      },
    ],
    [
      'extra payload data',
      {
        version: 2,
        role: 'admin',
        purchaseBuilding: null,
        issuedAt: now,
        expiresAt: now + 1_000,
        source: 'must-not-be-accepted',
      },
    ],
  ])('rejects a correctly signed v2 token with %s', (_label, payload) => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });
    const token = signTestToken(payload, sessionSecret);

    expect(service.readSession(token, now)).toEqual({
      principal: { role: 'guest', purchaseBuilding: null },
      expiresAt: null,
    });
  });

  it('renews only a currently valid privileged session with a fresh expiry', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });
    const original = await service.login(
      accessRequest('editor', editorPassword),
      '192.0.2.16',
      now,
    );
    const renewedAt = now + 10 * 60 * 1000;
    const renewed = service.renew(original.token, renewedAt);

    expect(renewed).toMatchObject({
      principal: { role: 'editor', purchaseBuilding: null },
      expiresAt: renewedAt + ACCESS_SESSION_TTL_MS,
    });
    expect(renewed?.token).not.toBe(original.token);
    expect(
      service.readSession(original.token, now + ACCESS_SESSION_TTL_MS),
    ).toEqual({
      principal: { role: 'guest', purchaseBuilding: null },
      expiresAt: null,
    });
    expect(
      service.readSession(renewed?.token, now + ACCESS_SESSION_TTL_MS),
    ).toEqual({
      principal: { role: 'editor', purchaseBuilding: null },
      expiresAt: renewedAt + ACCESS_SESSION_TTL_MS,
    });
    expect(
      service.renew(original.token, now + ACCESS_SESSION_TTL_MS),
    ).toBeNull();
    expect(service.renew('invalid', now)).toBeNull();
  });

  it('preserves a purchase applicant building when renewing the session', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      purchaseAdminHash,
      purchaseApplicantHashes,
      sessionSecret,
    });
    const original = await service.login(
      {
        accountType: 'purchase_applicant',
        purchaseBuilding: 'B楼',
        password: purchaseApplicantPasswords['B楼'],
      },
      '192.0.2.20',
      now,
    );
    const renewedAt = now + 10 * 60 * 1000;
    const renewed = service.renew(original.token, renewedAt);

    expect(renewed).toMatchObject({
      principal: {
        role: 'purchase_applicant',
        purchaseBuilding: 'B楼',
      },
      expiresAt: renewedAt + ACCESS_SESSION_TTL_MS,
    });
    expect(renewed?.token).not.toBe(original.token);
    expect(service.readSession(renewed?.token, renewedAt + 1)).toEqual({
      principal: {
        role: 'purchase_applicant',
        purchaseBuilding: 'B楼',
      },
      expiresAt: renewedAt + ACCESS_SESSION_TTL_MS,
    });
  });

  it('yields the event loop while checking both password hashes', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });
    let loginSettled = false;
    const timerObservedSettledState = new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(loginSettled), 0);
    });

    const loginPromise = Promise.resolve(
      service.login(accessRequest('admin', adminPassword), 'async-source', now),
    ).then(
      (result) => {
        loginSettled = true;
        return result;
      },
      (error: unknown) => {
        loginSettled = true;
        throw error;
      },
    );

    expect(await timerObservedSettledState).toBe(false);
    await expect(loginPromise).resolves.toMatchObject({
      principal: { role: 'admin', purchaseBuilding: null },
    });
  });

  it('limits concurrent password checks and releases capacity after success or failure', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });

    const first = invokeLogin(service, adminPassword, 'concurrent-a', now);
    const second = invokeLogin(service, wrongPassword, 'concurrent-b', now);
    const third = invokeLogin(
      service,
      editorPassword,
      'concurrent-c',
      now,
      'editor',
    );
    const firstExpectation = expect(first).resolves.toMatchObject({
      principal: { role: 'admin', purchaseBuilding: null },
    });
    const secondExpectation = expect(second).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    await expectHttpStatus(() => third, 429);
    await firstExpectation;
    await secondExpectation;
    await expect(
      service.login(
        accessRequest('editor', editorPassword),
        'concurrent-after-release',
        now + 1,
      ),
    ).resolves.toMatchObject({
      principal: { role: 'editor', purchaseBuilding: null },
    });
  });

  it('fails closed for an unknown source when the failure map is full', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });
    const internals = accessServiceInternals(service);
    const existingState: TestLoginFailureState = {
      firstFailureAt: now,
    };
    internals.failures.set('existing-source', existingState);
    seedFailures(internals.failures, 1023, now, 'full-source');

    await expectHttpStatus(
      () =>
        service.login(
          accessRequest('admin', wrongPassword),
          'unknown-source',
          now,
        ),
      429,
    );

    expect(internals.failures.size).toBe(1024);
    expect(internals.failures.get('existing-source')).toEqual(existingState);
    expect(internals.failures.has('unknown-source')).toBe(false);
    expect(internals.activePasswordVerifications).toBe(0);
    await expect(
      service.login(
        accessRequest('admin', adminPassword),
        'existing-source',
        now,
      ),
    ).resolves.toMatchObject({
      principal: { role: 'admin', purchaseBuilding: null },
    });
    expect(internals.failures.size).toBe(1023);
  });

  it('rechecks failure-map capacity after an asynchronous password check', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });
    const internals = accessServiceInternals(service);
    seedFailures(internals.failures, 1023, now, 'race-existing');

    const pending = invokeLogin(service, wrongPassword, 'race-new-source', now);
    const pendingStatus = expectHttpStatus(() => pending, 429);
    internals.failures.set('race-final-capacity-entry', {
      firstFailureAt: now,
    });

    await pendingStatus;
    expect(internals.failures.size).toBe(1024);
    expect(internals.failures.has('race-new-source')).toBe(false);
    expect(internals.activePasswordVerifications).toBe(0);
  });

  it('allows a correct login immediately after repeated invalid passwords', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        service.login(
          accessRequest('admin', wrongPassword),
          'source-a',
          now + attempt,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }

    await expect(
      service.login(accessRequest('admin', adminPassword), 'source-a', now + 5),
    ).resolves.toMatchObject({
      principal: { role: 'admin', purchaseBuilding: null },
    });
  });

  it('resets failures outside the 15 minute window', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        service.login(
          accessRequest('admin', wrongPassword),
          'window-source',
          now,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(
      service.login(
        accessRequest('admin', wrongPassword),
        'window-source',
        now + 15 * 60 * 1000 + 1,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    await expect(
      service.login(
        accessRequest('editor', editorPassword),
        'window-source',
        now + 15 * 60 * 1000 + 2,
      ),
    ).resolves.toMatchObject({
      principal: { role: 'editor', purchaseBuilding: null },
    });
  });

  it('clears the source failure state after a successful login', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        service.login(
          accessRequest('admin', wrongPassword),
          'clear-source',
          now,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(
      service.login(
        accessRequest('admin', adminPassword),
        'clear-source',
        now + 1,
      ),
    ).resolves.toMatchObject({
      principal: { role: 'admin', purchaseBuilding: null },
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        service.login(
          accessRequest('admin', wrongPassword),
          'clear-source',
          now + 2 + attempt,
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(
      service.login(
        accessRequest('editor', editorPassword),
        'clear-source',
        now + 7,
      ),
    ).resolves.toMatchObject({
      principal: { role: 'editor', purchaseBuilding: null },
    });
  });

  it('bounds normalized source keys', async () => {
    const service = createConfiguredService({
      adminHash,
      editorHash,
      sessionSecret,
    });

    await expect(
      service.login(
        accessRequest('admin', wrongPassword),
        'x'.repeat(10_000),
        now,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const keys = [
      ...(
        service as unknown as { failures: Map<string, unknown> }
      ).failures.keys(),
    ];

    expect(keys).toHaveLength(1);
    expect(keys[0].length).toBeLessThanOrEqual(128);
  });
});

interface ServiceEnvironment {
  accessControlEnabled?: string;
  adminHash?: string;
  editorHash?: string;
  purchaseAdminHash?: string;
  constructionAdminHash?: string;
  purchaseApplicantHashes?: Partial<
    Record<keyof typeof PURCHASE_APPLICANT_ENV_NAMES, string>
  >;
  inventoryAdministratorHashes?: Partial<
    Record<keyof typeof INVENTORY_ADMINISTRATOR_ENV_NAMES, string>
  >;
  buildingAdministratorHashes?: Partial<
    Record<keyof typeof BUILDING_ADMINISTRATOR_ENV_NAMES, string>
  >;
  sessionSecret?: string;
  legacySessionSecret?: string;
}

const PURCHASE_APPLICANT_ENV_NAMES = {
  A楼: 'LOCAL_PURCHASE_APPLICANT_A_PASSWORD_HASH',
  B楼: 'LOCAL_PURCHASE_APPLICANT_B_PASSWORD_HASH',
  C楼: 'LOCAL_PURCHASE_APPLICANT_C_PASSWORD_HASH',
  D楼: 'LOCAL_PURCHASE_APPLICANT_D_PASSWORD_HASH',
  E楼: 'LOCAL_PURCHASE_APPLICANT_E_PASSWORD_HASH',
  H楼: 'LOCAL_PURCHASE_APPLICANT_H_PASSWORD_HASH',
} as const;

const INVENTORY_ADMINISTRATOR_ENV_NAMES = {
  A楼: 'LOCAL_INVENTORY_ADMIN_A_PASSWORD_HASH',
  B楼: 'LOCAL_INVENTORY_ADMIN_B_PASSWORD_HASH',
  C楼: 'LOCAL_INVENTORY_ADMIN_C_PASSWORD_HASH',
  D楼: 'LOCAL_INVENTORY_ADMIN_D_PASSWORD_HASH',
  E楼: 'LOCAL_INVENTORY_ADMIN_E_PASSWORD_HASH',
  H楼: 'LOCAL_INVENTORY_ADMIN_H_PASSWORD_HASH',
} as const;

const BUILDING_ADMINISTRATOR_ENV_NAMES = {
  A楼: 'LOCAL_BUILDING_ADMIN_A_PASSWORD_HASH',
  B楼: 'LOCAL_BUILDING_ADMIN_B_PASSWORD_HASH',
  C楼: 'LOCAL_BUILDING_ADMIN_C_PASSWORD_HASH',
  D楼: 'LOCAL_BUILDING_ADMIN_D_PASSWORD_HASH',
  E楼: 'LOCAL_BUILDING_ADMIN_E_PASSWORD_HASH',
  '110站': 'LOCAL_BUILDING_ADMIN_110_PASSWORD_HASH',
} as const;

function createConfiguredService(
  values: ServiceEnvironment,
): UnifiedAccessService {
  const names = [
    'LOCAL_ACCESS_CONTROL_ENABLED',
    'LOCAL_ADMIN_PASSWORD_HASH',
    'LOCAL_EDITOR_PASSWORD_HASH',
    'LOCAL_PURCHASE_ADMIN_PASSWORD_HASH',
    'LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH',
    ...Object.values(PURCHASE_APPLICANT_ENV_NAMES),
    ...Object.values(INVENTORY_ADMINISTRATOR_ENV_NAMES),
    ...Object.values(BUILDING_ADMINISTRATOR_ENV_NAMES),
    'LOCAL_ACCESS_SESSION_SECRET',
    'LOCAL_ADMIN_SESSION_SECRET',
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  setEnvironment('LOCAL_ACCESS_CONTROL_ENABLED', values.accessControlEnabled);
  setEnvironment('LOCAL_ADMIN_PASSWORD_HASH', values.adminHash);
  setEnvironment('LOCAL_EDITOR_PASSWORD_HASH', values.editorHash);
  setEnvironment(
    'LOCAL_PURCHASE_ADMIN_PASSWORD_HASH',
    values.purchaseAdminHash,
  );
  setEnvironment(
    'LOCAL_CONSTRUCTION_ADMIN_PASSWORD_HASH',
    values.constructionAdminHash,
  );
  for (const [building, environmentName] of Object.entries(
    PURCHASE_APPLICANT_ENV_NAMES,
  )) {
    setEnvironment(
      environmentName,
      values.purchaseApplicantHashes?.[
        building as keyof typeof PURCHASE_APPLICANT_ENV_NAMES
      ],
    );
  }
  for (const [building, environmentName] of Object.entries(
    INVENTORY_ADMINISTRATOR_ENV_NAMES,
  )) {
    setEnvironment(
      environmentName,
      values.inventoryAdministratorHashes?.[
        building as keyof typeof INVENTORY_ADMINISTRATOR_ENV_NAMES
      ],
    );
  }
  for (const [building, environmentName] of Object.entries(
    BUILDING_ADMINISTRATOR_ENV_NAMES,
  )) {
    setEnvironment(
      environmentName,
      values.buildingAdministratorHashes?.[
        building as keyof typeof BUILDING_ADMINISTRATOR_ENV_NAMES
      ],
    );
  }
  setEnvironment('LOCAL_ACCESS_SESSION_SECRET', values.sessionSecret);
  setEnvironment('LOCAL_ADMIN_SESSION_SECRET', values.legacySessionSecret);

  try {
    return new UnifiedAccessService();
  } finally {
    for (const name of names) setEnvironment(name, previous.get(name));
  }
}

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function expectHttpStatus(
  action: () => unknown | Promise<unknown>,
  status: number,
): Promise<void> {
  let error: unknown;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getStatus()).toBe(status);
}

interface TestLoginFailureState {
  firstFailureAt: number;
}

interface TestAccessServiceInternals {
  failures: Map<string, TestLoginFailureState>;
  activePasswordVerifications: number;
}

function accessServiceInternals(
  service: UnifiedAccessService,
): TestAccessServiceInternals {
  return service as unknown as TestAccessServiceInternals;
}

function seedFailures(
  failures: Map<string, TestLoginFailureState>,
  count: number,
  now: number,
  prefix: string,
): void {
  for (let index = 0; index < count; index += 1) {
    failures.set(`${prefix}-${index}`, {
      firstFailureAt: now,
    });
  }
}

function accessRequest(accountType: 'admin' | 'editor', password: string) {
  return { accountType, password } as const;
}

function invokeLogin(
  service: UnifiedAccessService,
  password: string,
  source: string,
  now: number,
  accountType: 'admin' | 'editor' = 'admin',
): Promise<unknown> {
  try {
    return Promise.resolve(
      service.login(accessRequest(accountType, password), source, now),
    );
  } catch (error) {
    return Promise.reject(error);
  }
}

function signTestToken(payload: object, secretBase64: string): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const signature = createHmac('sha256', Buffer.from(secretBase64, 'base64'))
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}
