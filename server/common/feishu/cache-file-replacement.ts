import { rename } from 'node:fs/promises';

type Options = {
  strict: boolean;
  assertCurrentRead: () => void;
  platform?: NodeJS.Platform;
  replace?: typeof rename;
  wait?: (milliseconds: number) => Promise<void>;
};

/** Windows can briefly lock a cache file during atomic replacement. */
export async function replaceCacheFile(source: string, target: string, options: Options): Promise<void> {
  const delays = [100, 300, 700];
  const replace = options.replace || rename;
  const wait = options.wait || ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const isWindows = (options.platform || process.platform) === 'win32';
  for (let attempt = 0; ; attempt++) {
    options.assertCurrentRead();
    try {
      await replace(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (!options.strict || !isWindows || !code || !['EPERM', 'EACCES', 'EBUSY'].includes(code) || attempt >= delays.length) throw error;
      await wait(delays[attempt]);
    }
  }
}
