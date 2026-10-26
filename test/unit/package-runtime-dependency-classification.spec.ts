import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type PackageLock = {
  packages?: Record<
    string,
    {
      dev?: boolean;
      devOptional?: boolean;
    }
  >;
};

describe('runtime dependency classification', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
  ) as PackageManifest;
  const lock = JSON.parse(
    readFileSync(resolve(__dirname, '../../package-lock.json'), 'utf8'),
  ) as PackageLock;
  const runtimeDependencies = Object.keys(manifest.dependencies ?? {});
  const developmentDependencies = new Set(
    Object.keys(manifest.devDependencies ?? {}),
  );

  it('does not declare the same package as both runtime and development', () => {
    const duplicateDeclarations = runtimeDependencies.filter((dependency) =>
      developmentDependencies.has(dependency),
    );

    expect(duplicateDeclarations).toEqual([]);
  });

  it('does not let npm omit a declared runtime dependency', () => {
    const omittedRuntimeDependencies = runtimeDependencies.filter(
      (dependency) => {
        const lockEntry = lock.packages?.[`node_modules/${dependency}`];
        return !lockEntry || lockEntry.dev || lockEntry.devOptional;
      },
    );

    expect(omittedRuntimeDependencies).toEqual([]);
  });
});
