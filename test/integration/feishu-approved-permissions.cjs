const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('reflect-metadata');
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: {
    module: 'CommonJS',
    moduleResolution: 'node',
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
  },
});
require('tsconfig-paths').register({
  baseUrl: path.resolve(__dirname, '../..'),
  paths: { '@shared/*': ['shared/*'], '@server/*': ['server/*'] },
});
const {
  FeishuAccessService,
} = require('../../server/common/access/feishu-access.service');
const {
  UnifiedAccessService,
} = require('../../server/common/access/unified-access.service');
const {
  APPROVED_FEISHU_APP_ID,
} = require('../../server/common/access/feishu-access-approved-grants');

async function main() {
  const isolatedConfig = (values) => ({ get: (key) => values[key] });
  const env = require('dotenv').parse(fs.readFileSync('.env'));
  assert.equal(env.FEISHU_APP_ID, APPROVED_FEISHU_APP_ID);
  const identities = Object.entries(env)
    .filter(([key]) =>
      /^FEISHU_ACCESS_(ADMIN|EDITOR|PURCHASE_ADMIN|BUILDING_ADMIN_[ABCDEH]|INVENTORY_ADMIN_[ABCDEH])_OPEN_IDS$/.test(
        key,
      ),
    )
    .flatMap(([key, value]) =>
      value
        .split(',')
        .filter(Boolean)
        .map((openId) => ({ key, openId: openId.trim() })),
    );
  assert.equal(identities.length, 17);
  const config = {
    FEISHU_APP_ID: APPROVED_FEISHU_APP_ID,
    FEISHU_APP_SECRET: 'fixture-only-secret',
    PUBLIC_BASE_URL: 'https://fixture.example.test',
    CLIENT_BASE_PATH: '',
  };
  let verifiedId = '';
  const upstream = {
    axiosRef: {
      async post() {
        return { data: { code: 0, access_token: 'fixture-only-token' } };
      },
      async get() {
        return { data: { code: 0, data: { open_id: verifiedId } } };
      },
    },
  };
  const service = new FeishuAccessService(isolatedConfig(config), upstream);
  const disabled = new FeishuAccessService(
    isolatedConfig({
      ...config,
      FEISHU_ACCESS_APPROVED_GRANTS_ENABLED: ' false ',
    }),
    upstream,
  );
  const otherApplication = new FeishuAccessService(
    isolatedConfig({ ...config, FEISHU_APP_ID: 'cli_fixture_other_app' }),
    upstream,
  );
  process.env.LOCAL_ACCESS_SESSION_SECRET = require('node:crypto')
    .randomBytes(32)
    .toString('base64');
  const access = new UnifiedAccessService();
  const counts = {};
  for (const { key, openId } of identities) {
    const match =
      /^FEISHU_ACCESS_(ADMIN|EDITOR|PURCHASE_ADMIN|BUILDING_ADMIN|INVENTORY_ADMIN)(?:_([ABCDEH]))?_OPEN_IDS$/.exec(
        key,
      );
    assert.ok(match, 'Unexpected permission configuration key');
    const expected = {
      role: match[1].toLowerCase(),
      purchaseBuilding: match[2] ? match[2] + '\u697c' : null,
    };
    verifiedId = openId;
    const principal =
      await service.exchangeAuthorizationCode('fixture-only-code');
    assert.deepEqual(principal, expected);
    assert.deepEqual(service.resolvePrincipal('  ' + openId + '  '), expected);
    const login = access.issueTrustedSession(principal);
    assert.deepEqual(access.readSession(login.token).principal, expected);
    assert.equal(disabled.resolvePrincipal(openId), null);
    assert.equal(otherApplication.resolvePrincipal(openId), null);
    if (expected.role === 'editor' || expected.role === 'purchase_admin') {
      const legacyKey =
        expected.role === 'editor'
          ? 'FEISHU_ACCESS_DUTY_EDITOR_OPEN_IDS'
          : 'FEISHU_ACCESS_SUPPLY_CHAIN_ADMIN_OPEN_IDS';
      const legacy = new FeishuAccessService(
        isolatedConfig({ ...config, [legacyKey]: openId }),
        upstream,
      );
      assert.deepEqual(legacy.resolvePrincipal(openId), expected);
    }
    counts[principal.role] = (counts[principal.role] || 0) + 1;
  }
  verifiedId = 'ou_fixture_unknown_person';
  await assert.rejects(
    () => service.exchangeAuthorizationCode('fixture-only-code'),
    (error) => error.code === 'identity_not_allowed',
  );
  const first = identities[0].openId;
  const basePrincipal = service.resolvePrincipal(first);
  const sameKey = identities[0].key;
  assert.deepEqual(
    new FeishuAccessService(
      isolatedConfig({ ...config, [sameKey]: first }),
      upstream,
    ).resolvePrincipal(first),
    basePrincipal,
  );
  const conflictingKey =
    basePrincipal.role === 'admin'
      ? 'FEISHU_ACCESS_EDITOR_OPEN_IDS'
      : 'FEISHU_ACCESS_ADMIN_OPEN_IDS';
  assert.throws(
    () =>
      new FeishuAccessService(
        isolatedConfig({ ...config, [conflictingKey]: first }),
        upstream,
      ),
    /\u8de8\u89d2\u8272/,
  );
  console.log(
    JSON.stringify({
      verified: identities.length,
      roleCounts: counts,
      rawIdsInOutput: false,
      source: 'ignored local environment; only upstream OAuth exchange mocked',
      applicationIsolation: 'passed',
      disabledGrants: 'passed',
      unknownIdentity: 'denied',
      conflictingOverride: 'denied',
      signedSessions: 'passed',
    }),
  );
}
main().catch((error) => {
  console.error(error.name + ': permission acceptance failed');
  console.error(
    String(error.stack)
      .split('\n')
      .filter((line) => line.includes('feishu-approved-permissions.cjs'))
      .join('\n'),
  );
  process.exitCode = 1;
});
