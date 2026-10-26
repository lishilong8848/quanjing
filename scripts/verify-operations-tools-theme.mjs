import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import ts from 'typescript';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--client-dir') {
  throw new Error(
    'Usage: node scripts/verify-operations-tools-theme.mjs --client-dir <compiled client directory>',
  );
}
const root = resolve(args[1]);
const files = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Unexpected symbolic link: ${path}`);
    if (entry.isDirectory()) collect(path);
    else if (/\.(?:css|js)$/.test(entry.name)) files.push(path);
  }
}
collect(root);
const variables = new Set();
for (const path of files.filter((path) => path.endsWith('.css'))) {
  for (const match of readFileSync(path, 'utf8').matchAll(
    /var\(\s*(--tools-[\w-]+)/g,
  ))
    variables.add(match[1]);
}
if (!variables.size)
  throw new Error('No operations tools CSS variable consumers found');
const verified = new Set();
const evidence = [];
const keyOf = (node) =>
  node && (ts.isIdentifier(node) || ts.isStringLiteral(node))
    ? node.text
    : undefined;
for (const path of files.filter((path) => path.endsWith('.js'))) {
  const bytes = readFileSync(path);
  const code = bytes.toString('utf8');
  if (!code.includes('--tools-blue')) continue;
  const source = ts.createSourceFile(
    path,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const themes = [];
  const roots = [];
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const properties = new Set(
        node.initializer.properties.map((property) => keyOf(property.name)),
      );
      if ([...variables].every((name) => properties.has(name))) {
        let scope = node.parent;
        while (scope && !ts.isBlock(scope) && !ts.isSourceFile(scope))
          scope = scope.parent;
        themes.push({ name: node.name.text, scope });
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const className = node.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) &&
          keyOf(property.name) === 'className',
      );
      const style = node.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) && keyOf(property.name) === 'style',
      );
      if (className && ts.isStringLiteral(className.initializer)) {
        for (const name of ['tools-page', 'tools-dialog']) {
          if (className.initializer.text.split(/\s+/).includes(name))
            roots.push({ name, style, node });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const { name, style, node } of roots) {
    if (!style || !ts.isIdentifier(style.initializer)) continue;
    if (
      themes.some(
        (theme) =>
          theme.name === style.initializer.text &&
          theme.scope.pos <= node.pos &&
          theme.scope.end >= node.end,
      )
    )
      verified.add(name);
  }
  if (themes.length)
    evidence.push({
      asset: relative(root, path).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
}
for (const name of ['tools-page', 'tools-dialog']) {
  if (!verified.has(name))
    throw new Error(
      `${name} does not bind a complete operations tools theme in compiled JS`,
    );
}
console.log(
  JSON.stringify(
    {
      result: 'PASS',
      variables: [...variables].sort(),
      roots: [...verified],
      evidence,
    },
    null,
    2,
  ),
);
