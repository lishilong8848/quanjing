import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

describe('runtime environment defaults', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    jest.doMock('dotenv', () => ({ config: jest.fn() }));
    delete process.env.SUDA_DATABASE_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.dontMock('dotenv');
  });

  it.each(['production', 'development', undefined])(
    'forces Datapass off without a database URL when NODE_ENV is %s',
    (nodeEnv) => {
      if (nodeEnv) {
        process.env.NODE_ENV = nodeEnv;
      } else {
        delete process.env.NODE_ENV;
      }
      process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = 'false';

      jest.isolateModules(() => {
        require('../../server/runtime-env');
      });

      expect(process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS).toBe('true');
    },
  );

  it('does not disable Datapass when a database URL is configured', () => {
    process.env.NODE_ENV = 'production';
    process.env.SUDA_DATABASE_URL = ' postgres://database.example/app ';
    delete process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS;

    jest.isolateModules(() => {
      require('../../server/runtime-env');
    });

    expect(process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS).toBeUndefined();
  });

  it.each([undefined, 'not-a-boolean'])(
    'normalizes a missing or invalid Datapass switch without a database: %s',
    (datapassValue) => {
      process.env.NODE_ENV = 'production';
      if (datapassValue === undefined) {
        delete process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS;
      } else {
        process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS = datapassValue;
      }

      jest.isolateModules(() => {
        require('../../server/runtime-env');
      });

      expect(process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS).toBe('true');
    },
  );

  it.each([undefined, 'false', 'true'])(
    'keeps HTTP request and response bodies out of logs when configured as %s',
    (configuredValue) => {
      if (configuredValue === undefined) {
        delete process.env.LOG_REQUEST_BODY;
        delete process.env.LOG_RESPONSE_BODY;
      } else {
        process.env.LOG_REQUEST_BODY = configuredValue;
        process.env.LOG_RESPONSE_BODY = configuredValue;
      }

      jest.isolateModules(() => {
        require('../../server/runtime-env');
      });

      expect(process.env.LOG_REQUEST_BODY).toBe('false');
      expect(process.env.LOG_RESPONSE_BODY).toBe('false');
    },
  );

  it('preserves purchase workflow activation injected by the candidate launcher', () => {
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';

    jest.isolateModules(() => {
      require('../../server/runtime-env');
    });

    expect(process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED).toBe('true');
    expect(process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED).toBe('true');
  });

  it('preserves explicit disabled card-copy process settings over dotenv', () => {
    process.env.FEISHU_CARD_READONLY_COPY_ENABLED = 'false';
    jest.doMock('dotenv', () => ({ config: jest.fn(() => { process.env.FEISHU_CARD_READONLY_COPY_ENABLED = 'true'; }) }));
    jest.isolateModules(() => { require('../../server/runtime-env'); });
    expect(process.env.FEISHU_CARD_READONLY_COPY_ENABLED).toBe('false');
  });

  it('explicitly disables card copies in a production smoke startup', () => {
    process.env.NODE_ENV = 'production'; process.env.NANTONG_HOTFIX_SMOKE_MODE = 'true'; process.env.FEISHU_CARD_READONLY_COPY_ENABLED = 'true';
    jest.isolateModules(() => { require('../../server/runtime-env'); });
    expect(process.env.FEISHU_CARD_READONLY_COPY_ENABLED).toBe('false');
  });

  it('keeps explicit process startup values above real dotenv files while preserving local FEISHU overrides', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'nantong-runtime-env-'));
    try {
      writeFileSync(
        join(fixtureDir, '.env'),
        [
          'NODE_ENV=development',
          'FORCE_FRAMEWORK_DISABLE_DATAPASS=true',
          'SERVER_HOST=env-host',
          'SERVER_PORT=3100',
          'LOCAL_ACCESS_DEPLOYMENT_ID=env-deployment',
          'SUDA_DATABASE_URL=',
          'FEISHU_APP_ID=from-env',
          'FEISHU_CARD_ACTION_CONSUMER_PROFILE=disabled',
          'FEISHU_CARD_ACTION_TEST_APP_ID=test-app-from-env',
          'FEISHU_CARD_ACTION_TEST_APP_SECRET=test-secret-from-env',
          'TENCENTCLOUD_SECRET_ID=',
          'TENCENTCLOUD_SECRET_KEY=from-env-key',
          'TENCENTCLOUD_SESSION_TOKEN=from-env-token',
          'CONTRACT_ATTACHMENT_ENCRYPTION_KEY=',
          'COS_CHANGE_INDEX_PATH=from-env-index',
          'ATTENDANCE_AUTOMATION_ENABLED=true',
          'DINGTALK_ATTENDANCE_CLIENT_ID=from-env-attendance-id',
          'DINGTALK_ATTENDANCE_CLIENT_SECRET=from-env-attendance-secret',
          'PURCHASE_WORKFLOW_PROGRAM_ENABLED=true',
          'PURCHASE_MANAGER_APPROVAL_CARD_ENABLED=true',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(
        join(fixtureDir, '.env.local'),
        [
          'NODE_ENV=local-development',
          'FORCE_FRAMEWORK_DISABLE_DATAPASS=true',
          'SERVER_HOST=local-host',
          'SERVER_PORT=3200',
          'LOCAL_ACCESS_DEPLOYMENT_ID=local-deployment',
          'SUDA_DATABASE_URL=',
          'FEISHU_APP_ID=from-local',
          'FEISHU_CARD_ACTION_CONSUMER_PROFILE=local-test',
          'FEISHU_CARD_ACTION_TEST_APP_ID=test-app-from-local',
          'FEISHU_CARD_ACTION_TEST_APP_SECRET=test-secret-from-local',
          'TENCENTCLOUD_SECRET_ID=',
          'TENCENTCLOUD_SECRET_KEY=',
          'TENCENTCLOUD_SESSION_TOKEN=from-local-token',
          'CONTRACT_ATTACHMENT_ENCRYPTION_KEY=   ',
          'COS_CHANGE_INDEX_PATH=from-local-index',
          'ATTENDANCE_AUTOMATION_ENABLED=true',
          'DINGTALK_ATTENDANCE_CLIENT_ID=from-local-attendance-id',
          'DINGTALK_ATTENDANCE_CLIENT_SECRET=from-local-attendance-secret',
          'PURCHASE_WORKFLOW_PROGRAM_ENABLED=TRUE',
          'PURCHASE_MANAGER_APPROVAL_CARD_ENABLED=TRUE',
        ].join('\n'),
        'utf8',
      );

      const runtimeEnvPath = resolve(__dirname, '../../server/runtime-env.ts');
      const childScript = `
        require(${JSON.stringify(runtimeEnvPath)});
        process.stdout.write(JSON.stringify({
          nodeEnv: process.env.NODE_ENV,
          datapass: process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS,
          host: process.env.SERVER_HOST,
          port: process.env.SERVER_PORT,
          deploymentId: process.env.LOCAL_ACCESS_DEPLOYMENT_ID,
          databaseUrl: process.env.SUDA_DATABASE_URL,
          feishuAppId: process.env.FEISHU_APP_ID,
          cardConsumerProfile: process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE,
          cardTestAppId: process.env.FEISHU_CARD_ACTION_TEST_APP_ID,
          cardTestSecretPreserved:
            process.env.FEISHU_CARD_ACTION_TEST_APP_SECRET ===
            'test-secret-from-process',
          inheritedSecretPreserved: process.env.TENCENTCLOUD_SECRET_ID === 'from-process-id',
          envSecretPreserved: process.env.TENCENTCLOUD_SECRET_KEY === 'from-env-key',
          localSecretApplied: process.env.TENCENTCLOUD_SESSION_TOKEN === 'from-local-token',
          contractKeyPreserved: process.env.CONTRACT_ATTACHMENT_ENCRYPTION_KEY === Buffer.alloc(32, 7).toString('base64'),
          changeAttachmentIndexPath: process.env.COS_CHANGE_INDEX_PATH,
          attendanceEnabled: process.env.ATTENDANCE_AUTOMATION_ENABLED,
          attendanceClientIdPreserved:
            process.env.DINGTALK_ATTENDANCE_CLIENT_ID ===
            'from-process-attendance-id',
          attendanceClientSecretPreserved:
            process.env.DINGTALK_ATTENDANCE_CLIENT_SECRET ===
            'from-process-attendance-secret',
          purchaseProgramWorkflow: process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED,
          purchaseManagerApprovalCard:
            process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED,
        }));
      `;
      const result = spawnSync(
        process.execPath,
        [
          '-r',
          require.resolve('ts-node/register/transpile-only'),
          '-e',
          childScript,
        ],
        {
          cwd: fixtureDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            TS_NODE_PROJECT: resolve(__dirname, '../../tsconfig.node.json'),
            NODE_ENV: 'production',
            FORCE_FRAMEWORK_DISABLE_DATAPASS: 'false',
            SERVER_HOST: 'process-host',
            SERVER_PORT: '49152',
            LOCAL_ACCESS_DEPLOYMENT_ID: 'process-deployment',
            SUDA_DATABASE_URL: 'postgres://process-only/database',
            FEISHU_APP_ID: 'from-process',
            FEISHU_CARD_ACTION_CONSUMER_PROFILE: 'disabled',
            FEISHU_CARD_ACTION_TEST_APP_ID: 'test-app-from-process',
            FEISHU_CARD_ACTION_TEST_APP_SECRET: 'test-secret-from-process',
            TENCENTCLOUD_SECRET_ID: 'from-process-id',
            TENCENTCLOUD_SECRET_KEY: 'from-process-key',
            TENCENTCLOUD_SESSION_TOKEN: 'from-process-token',
            CONTRACT_ATTACHMENT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString(
              'base64',
            ),
            COS_CHANGE_INDEX_PATH:
              'D:/persistent-state/change-attachment-cos-index.json',
            ATTENDANCE_AUTOMATION_ENABLED: 'false',
            DINGTALK_ATTENDANCE_CLIENT_ID: 'from-process-attendance-id',
            DINGTALK_ATTENDANCE_CLIENT_SECRET: 'from-process-attendance-secret',
            PURCHASE_WORKFLOW_PROGRAM_ENABLED: 'true',
            PURCHASE_MANAGER_APPROVAL_CARD_ENABLED: 'true',
          },
          timeout: 15_000,
        },
      );

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        nodeEnv: 'production',
        datapass: 'false',
        host: 'process-host',
        port: '49152',
        deploymentId: 'process-deployment',
        databaseUrl: 'postgres://process-only/database',
        feishuAppId: 'from-local',
        cardConsumerProfile: 'disabled',
        cardTestAppId: 'test-app-from-process',
        cardTestSecretPreserved: true,
        inheritedSecretPreserved: true,
        envSecretPreserved: true,
        localSecretApplied: true,
        contractKeyPreserved: true,
        changeAttachmentIndexPath:
          'D:/persistent-state/change-attachment-cos-index.json',
        attendanceEnabled: 'false',
        attendanceClientIdPreserved: true,
        attendanceClientSecretPreserved: true,
        purchaseProgramWorkflow: 'true',
        purchaseManagerApprovalCard: 'true',
      });
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'env value over inherited key',
      inherited: 7,
      envKey: 8,
      localKey: '',
      expected: 8,
    },
    {
      label: 'local value over env value',
      inherited: 7,
      envKey: 8,
      localKey: 9,
      expected: 9,
    },
    {
      label: 'missing key stays missing',
      inherited: '',
      envKey: '',
      localKey: '',
      expected: '',
    },
    {
      label: 'explicit invalid value is not silently replaced',
      inherited: 7,
      envKey: 'invalid',
      localKey: '',
      expected: 'invalid',
    },
  ])(
    'handles contract key configuration: $label',
    ({ inherited, envKey, localKey, expected }) => {
      const keyValue = (value: number | string) =>
        typeof value === 'number'
          ? Buffer.alloc(32, value).toString('base64')
          : value;
      const directory = mkdtempSync(
        join(tmpdir(), 'nantong-contract-key-env-'),
      );
      try {
        writeFileSync(
          join(directory, '.env'),
          `CONTRACT_ATTACHMENT_ENCRYPTION_KEY=${keyValue(envKey)}\n`,
          'utf8',
        );
        writeFileSync(
          join(directory, '.env.local'),
          `CONTRACT_ATTACHMENT_ENCRYPTION_KEY=${keyValue(localKey)}\n`,
          'utf8',
        );
        const script = `
        require(${JSON.stringify(resolve(__dirname, '../../server/runtime-env.ts'))});
        const value = process.env.CONTRACT_ATTACHMENT_ENCRYPTION_KEY || '';
        process.stdout.write(JSON.stringify({ matchesExpected: value === ${JSON.stringify(keyValue(expected))}, present: Boolean(value.trim()) }));
      `;
        const result = spawnSync(
          process.execPath,
          [
            '-r',
            require.resolve('ts-node/register/transpile-only'),
            '-e',
            script,
          ],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 15_000,
            env: {
              ...process.env,
              TS_NODE_PROJECT: resolve(__dirname, '../../tsconfig.node.json'),
              CONTRACT_ATTACHMENT_ENCRYPTION_KEY: keyValue(inherited),
            },
          },
        );
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual({
          matchesExpected: true,
          present: Boolean(keyValue(expected)),
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('forces the callback profile off during production-equivalent smoke mode', () => {
    process.env.NANTONG_HOTFIX_SMOKE_MODE = 'true';
    process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE = 'production';
    process.env.FEISHU_CARD_ACTION_CONSUMER_ENABLED = 'true';
    process.env.NANTONG_DAILY_PATROL_ENABLED = 'true';
    process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED = 'true';
    process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED = 'true';

    jest.isolateModules(() => {
      require('../../server/runtime-env');
    });

    expect(process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE).toBe('disabled');
    expect(process.env.FEISHU_CARD_ACTION_CONSUMER_ENABLED).toBe('false');
    expect(process.env.NANTONG_DAILY_PATROL_ENABLED).toBe('false');
    expect(process.env.PURCHASE_WORKFLOW_PROGRAM_ENABLED).toBe('false');
    expect(process.env.PURCHASE_MANAGER_APPROVAL_CARD_ENABLED).toBe('false');
  });
});
