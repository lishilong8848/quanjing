const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { isBuiltin } = require('node:module');
function verifyServerRuntimeImports(root = process.cwd()) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  const config = ts.readConfigFile(
    path.join(root, 'tsconfig.node.json'),
    ts.sys.readFile,
  );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const production = new Set(Object.keys(pkg.dependencies || {}));
  const failures = [];
  let files = 0;
  for (const file of parsed.fileNames) {
    if (
      file.endsWith('.d.ts') ||
      file.endsWith('.spec.ts') ||
      !/[/\\](?:server|shared)[/\\]/.test(file)
    )
      continue;
    const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: parsed.options,
    }).outputText;
    const tree = ts.createSourceFile(
      file + '.js',
      js,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    files++;
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === 'require'))
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          const name = arg.text;
          if (
            !name.startsWith('.') &&
            !name.startsWith('@server/') &&
            !name.startsWith('@shared/') &&
            !name.startsWith('@/') &&
            !isBuiltin(name)
          ) {
            const packageName = name.startsWith('@')
              ? name.split('/').slice(0, 2).join('/')
              : name.split('/')[0];
            if (!production.has(packageName))
              failures.push({
                file: path.relative(root, file).replaceAll('\\', '/'),
                dependency: name,
                declaredDevOnly: !!pkg.devDependencies?.[packageName],
              });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  return { files, failures };
}
module.exports = { verifyServerRuntimeImports };
if (require.main === module) {
  const report = verifyServerRuntimeImports();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.failures.length ? 1 : 0;
}
