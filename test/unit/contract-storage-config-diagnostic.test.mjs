import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadContractStartupEnvironment } from '../../scripts/verify-contract-storage-startup.mjs';

const modulePath = resolve('scripts/diagnose-contract-storage-config.mjs');
const key = Buffer.alloc(32, 19).toString('base64');
const credentials = {
  CONTRACT_ATTACHMENT_ENCRYPTION_KEY: key,
  COS_SECRET_ID: 'synthetic-id-private',
  COS_SECRET_KEY: 'synthetic-secret-private',
};
async function diagnose(
  root,
  environment = {},
  windowsEnvironment = { User: {}, Machine: {} },
) {
  assert.ok(
    existsSync(modulePath),
    'configuration diagnostic must exist and distinguish missing settings',
  );
  const { diagnoseContractStorageConfig } = await import(
    pathToFileURL(modulePath)
  );
  return diagnoseContractStorageConfig({
    root,
    environment,
    readWindowsEnvironment: () => windowsEnvironment,
  });
}
async function fixture(action) {
  const parent = mkdtempSync(join(tmpdir(), 'nt-contract-config-'));
  const root = join(parent, 'app');
  mkdirSync(root);
  try {
    return await action(root, parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

test('missing key is distinguished from existing COS credentials', async () =>
  fixture(async (root) => {
    const result = await diagnose(root, {
      COS_SECRET_ID: credentials.COS_SECRET_ID,
      COS_SECRET_KEY: credentials.COS_SECRET_KEY,
    });
    assert.equal(result.status, 'not-configured');
    assert.deepEqual(result.issues, ['encryption_key_missing']);
    assert.equal(result.effective.cosSecretIdPresent, true);
    assert.equal(result.effective.cosSecretKeyPresent, true);
  }));

for (const [name, issue] of [
  ['COS_SECRET_ID', 'cos_secret_id_missing'],
  ['COS_SECRET_KEY', 'cos_secret_key_missing'],
]) {
  test(`missing ${name} has a specific reason with a valid existing key`, async () =>
    fixture(async (root) => {
      const environment = { ...credentials };
      delete environment[name];
      const result = await diagnose(root, environment);
      assert.deepEqual(result.issues, [issue]);
      assert.equal(result.effective.encryptionKeyValid, true);
    }));
}

test('all missing settings are reported together, without claiming COS connectivity', async () =>
  fixture(async (root) => {
    const result = await diagnose(root);
    assert.deepEqual(result.issues, [
      'encryption_key_missing',
      'cos_secret_id_missing',
      'cos_secret_key_missing',
    ]);
    assert.equal(result.networkCalls, 0);
    assert.equal(result.applicationWrites, 0);
    assert.equal(result.liveProcessStateVerified, false);
    assert.equal(result.cosConnectivityVerified, false);
  }));

test('valid local-format configuration is not called a successful preview', async () =>
  fixture(async (root) => {
    const result = await diagnose(root, credentials);
    assert.equal(result.status, 'configuration-ready');
    assert.deepEqual(result.issues, []);
    assert.equal(result.cosConnectivityVerified, false);
    const output = JSON.stringify(result);
    for (const value of Object.values(credentials))
      assert.equal(output.includes(value), false);
    assert.equal(
      /sha256|fingerprint|digest/.test(output),
      false,
      'never fingerprint secrets',
    );
  }));

for (const value of ['false', '0', 'OFF', ' no ']) {
  test(`explicit disabled flag ${value} is separate from missing credentials`, async () =>
    fixture(async (root) => {
      const result = await diagnose(root, {
        ...credentials,
        CONTRACT_ATTACHMENT_STORAGE_ENABLED: value,
      });
      assert.equal(result.status, 'disabled');
      assert.deepEqual(result.issues, ['storage_disabled']);
    }));
}

test('invalid nonempty key is distinguished from a missing key and never printed', async () =>
  fixture(async (root) => {
    const result = await diagnose(root, {
      ...credentials,
      CONTRACT_ATTACHMENT_ENCRYPTION_KEY: 'synthetic-invalid-private-key',
    });
    assert.deepEqual(result.issues, ['encryption_key_invalid']);
    assert.equal(
      JSON.stringify(result).includes('synthetic-invalid-private-key'),
      false,
    );
  }));

test('User then Machine fallback matches startup semantics and empty dotenv values do not erase credentials', async () =>
  fixture(async (root) => {
    const windows = {
      User: {
        CONTRACT_ATTACHMENT_ENCRYPTION_KEY: key,
        COS_SECRET_ID: credentials.COS_SECRET_ID,
      },
      Machine: { COS_SECRET_KEY: credentials.COS_SECRET_KEY },
    };
    writeFileSync(
      join(root, '.env'),
      'CONTRACT_ATTACHMENT_ENCRYPTION_KEY=\nCOS_SECRET_ID=\nCOS_SECRET_KEY=\n',
    );
    writeFileSync(
      join(root, '.env.local'),
      'COS_SECRET_KEY="" # empty placeholder\n',
    );
    const result = await diagnose(root, {}, windows);
    assert.equal(result.status, 'configuration-ready');
    assert.equal(
      result.settings.CONTRACT_ATTACHMENT_ENCRYPTION_KEY.source,
      'windows-user',
    );
    assert.equal(result.settings.COS_SECRET_KEY.source, 'windows-machine');
    assert.equal(
      result.sources.find((item) => item.source === '.env').settings
        .CONTRACT_ATTACHMENT_ENCRYPTION_KEY.present,
      false,
    );
  }));

test('nonempty file precedence, BOM, quotes and aliases agree with frozen startup loader', async () =>
  fixture(async (root, parent) => {
    writeFileSync(
      join(parent, 'nantong-schedule.private.env'),
      `CONTRACT_ATTACHMENT_ENCRYPTION_KEY="${key}"\nCOS_SECRET_ID=private-id\nCOS_SECRET_KEY=private-key\nCONTRACT_ATTACHMENT_STORAGE_ENABLED=false\n`,
    );
    writeFileSync(
      join(root, '.env'),
      '\uFEFFCOS_SECRET_ID="dotenv-id" # comment\nCOS_SECRET_KEY=\n',
    );
    writeFileSync(
      join(root, '.env.local'),
      'COS_SECRET_KEY="local-secret" # 中文注释\n',
    );
    const environment = {
      COS_SECRET_ID: 'process-id',
      CONTRACT_ATTACHMENT_STORAGE_ENABLED: 'true',
    };
    const result = await diagnose(root, environment);
    const expected = loadContractStartupEnvironment(
      root,
      environment,
      () => ({}),
    );
    assert.equal(
      result.effective.encryptionKeyValid,
      Boolean(expected.CONTRACT_ATTACHMENT_ENCRYPTION_KEY),
    );
    assert.equal(
      result.effective.storageEnabled,
      true,
      'private file only supplies credentials',
    );
    assert.equal(result.settings.COS_SECRET_ID.source, '.env');
    assert.equal(result.settings.COS_SECRET_KEY.source, '.env.local');
  }));

test('COS aliases satisfy each missing member without an unrelated dotenv source masking the result', async () =>
  fixture(async (root) => {
    const result = await diagnose(root, {
      CONTRACT_ATTACHMENT_ENCRYPTION_KEY: key,
      TENCENTCLOUD_SECRET_ID: 'alias-id-private',
      TENCENTCLOUD_SECRET_KEY: 'alias-secret-private',
    });
    assert.equal(result.status, 'configuration-ready');
    assert.equal(result.settings.COS_SECRET_ID.present, false);
    assert.equal(result.settings.TENCENTCLOUD_SECRET_ID.source, 'process');
    assert.equal(result.effective.cosSecretIdPresent, true);
    assert.equal(result.effective.cosSecretKeyPresent, true);
    assert.equal(
      JSON.stringify(result).includes('alias-secret-private'),
      false,
    );
  }));

test('nonempty Process wins over User and User wins over Machine before file overrides', async () =>
  fixture(async (root) => {
    const result = await diagnose(
      root,
      { CONTRACT_ATTACHMENT_ENCRYPTION_KEY: key },
      {
        User: {
          CONTRACT_ATTACHMENT_ENCRYPTION_KEY: 'invalid-user-key-private',
          COS_SECRET_ID: 'user-id-private',
        },
        Machine: {
          COS_SECRET_ID: 'machine-id-private',
          COS_SECRET_KEY: 'machine-secret-private',
        },
      },
    );
    assert.equal(result.status, 'configuration-ready');
    assert.equal(
      result.settings.CONTRACT_ATTACHMENT_ENCRYPTION_KEY.source,
      'process',
    );
    assert.equal(result.settings.COS_SECRET_ID.source, 'windows-user');
    assert.equal(result.settings.COS_SECRET_KEY.source, 'windows-machine');
    assert.equal(
      JSON.stringify(result).includes('invalid-user-key-private'),
      false,
    );
  }));

test('noncanonical Base64 is invalid even when Node can decode 32 bytes', async () =>
  fixture(async (root) => {
    const result = await diagnose(root, {
      ...credentials,
      CONTRACT_ATTACHMENT_ENCRYPTION_KEY: key.replace(/=$/, ''),
    });
    assert.deepEqual(result.issues, ['encryption_key_invalid']);
  }));

test('dotenv storage flag overrides Process while credentials keep nonempty fallback', async () =>
  fixture(async (root) => {
    writeFileSync(
      join(root, '.env.local'),
      'CONTRACT_ATTACHMENT_STORAGE_ENABLED="false" # explicit\nCONTRACT_ATTACHMENT_ENCRYPTION_KEY=\n',
    );
    const result = await diagnose(root, {
      ...credentials,
      CONTRACT_ATTACHMENT_STORAGE_ENABLED: 'true',
    });
    assert.equal(result.status, 'disabled');
    assert.equal(
      result.settings.CONTRACT_ATTACHMENT_ENCRYPTION_KEY.source,
      'process',
    );
    assert.equal(
      result.settings.CONTRACT_ATTACHMENT_STORAGE_ENABLED.source,
      '.env.local',
    );
  }));

test('an unreadable source produces unknown rather than fabricated missing-key diagnosis', async () =>
  fixture(async (root) => {
    const { diagnoseContractStorageConfig } = await import(
      pathToFileURL(modulePath)
    );
    const result = diagnoseContractStorageConfig({
      root,
      environment: {},
      readWindowsEnvironment: () => {
        throw Error('private-secret-error');
      },
    });
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.issues, ['configuration_source_unreadable']);
    assert.equal(
      JSON.stringify(result).includes('private-secret-error'),
      false,
    );
  }));

test('unsafe config link is refused and its contents are not exported', async () =>
  fixture(async (root, parent) => {
    const outside = join(parent, 'private-outside');
    mkdirSync(outside);
    symlinkSync(outside, join(root, '.env'), 'junction');
    const result = await diagnose(root, credentials);
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.issues, ['configuration_source_unreadable']);
  }));

test('read-only invocation leaves all existing fixture bytes and directory contents unchanged', async () =>
  fixture(async (root) => {
    writeFileSync(
      join(root, '.env'),
      `CONTRACT_ATTACHMENT_ENCRYPTION_KEY=${key}\nCOS_SECRET_ID=synthetic-id\nCOS_SECRET_KEY=synthetic-key\n`,
    );
    writeFileSync(
      join(root, '.hotfix-installed-release.json'),
      JSON.stringify({
        deploymentId: 'nantong-safe-full-runtime-hotfix-20261003-191028',
      }),
    );
    const before = readdirSync(root).map((name) => [
      name,
      readFileSync(join(root, name)).toString('hex'),
    ]);
    const result = await diagnose(root);
    assert.equal(
      result.installedDeploymentId,
      'nantong-safe-full-runtime-hotfix-20261003-191028',
    );
    assert.equal(result.receiptVerified, false);
    assert.deepEqual(
      readdirSync(root).map((name) => [
        name,
        readFileSync(join(root, name)).toString('hex'),
      ]),
      before,
    );
  }));

test('CLI only emits a redacted JSON report and rejects invalid arguments without disclosure', async () =>
  fixture(async (root) => {
    assert.ok(
      existsSync(modulePath),
      'configuration diagnostic CLI must exist',
    );
    const result = spawnSync(process.execPath, [modulePath, '--root', root], {
      encoding: 'utf8',
      env: {
        SystemRoot: process.env.SystemRoot,
        PATH: process.env.PATH,
        ...credentials,
      },
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'configuration-ready');
    for (const value of Object.values(credentials))
      assert.equal((result.stdout + result.stderr).includes(value), false);
    const invalid = spawnSync(
      process.execPath,
      [modulePath, 'synthetic-private-argument'],
      { encoding: 'utf8', timeout: 15000 },
    );
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stderr.includes('synthetic-private-argument'), false);
  }));
