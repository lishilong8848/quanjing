import { dirname, join, resolve } from 'path';

interface DutyDailyReportStateDirectoryOptions {
  cwd?: string;
  nodeEnv?: string;
  configuredDirectory?: string;
}

interface DutyDailyReportStateFileOptions
  extends DutyDailyReportStateDirectoryOptions {
  fileName: string;
  explicitPath?: string;
}

const PRODUCTION_SHARED_STATE_DIRECTORY = 'nantong-schedule-state';

export function resolveDutyDailyReportStateDirectory(
  options: DutyDailyReportStateDirectoryOptions = {},
): string {
  const configuredDirectory = options.configuredDirectory?.trim();
  if (configuredDirectory) {
    return resolve(configuredDirectory);
  }

  const cwd = resolve(options.cwd || process.cwd());
  const nodeEnv = options.nodeEnv || process.env.NODE_ENV;
  return nodeEnv === 'production'
    ? join(dirname(cwd), PRODUCTION_SHARED_STATE_DIRECTORY)
    : join(cwd, 'data');
}

export function resolveDutyDailyReportStateFilePath(
  options: DutyDailyReportStateFileOptions,
): string {
  const explicitPath = options.explicitPath?.trim();
  if (explicitPath) {
    return resolve(explicitPath);
  }

  return join(
    resolveDutyDailyReportStateDirectory(options),
    options.fileName,
  );
}
