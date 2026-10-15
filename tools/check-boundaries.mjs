import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const files = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (!['node_modules', 'dist', 'generated', '.next'].includes(entry.name)) walk(full); }
    else if (/\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(full);
  }
}
for (const area of ['apps', 'packages']) walk(path.join(root, area));
const known = new Set(files);
const edges = new Map(files.map(file => [file, []]));
const errors = [];
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const client = ts.isExpressionStatement(source.statements[0]) && source.statements[0].expression.text === 'use client';
  const owner = path.relative(root, file).split(path.sep).slice(0, 2).join('/');
  const specs = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specs.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) specs.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const spec of specs) {
    if (owner === 'apps/api' && spec === '@veyrobot/moderation') errors.push(`${path.relative(root, file)}: API must use the Discord-free @veyrobot/moderation/service entrypoint`);
    if (client && /^(@veyrobot\/(db|moderation)|discord\.js|bullmq|pg|@prisma\/)/.test(spec)) errors.push(`${path.relative(root, file)}: client bundle imports ${spec}`);
    if (owner === 'packages/contracts' && /^@veyrobot\//.test(spec)) errors.push(`${path.relative(root, file)}: contracts depend on ${spec}`);
    if (owner === 'packages/db' && spec === '@veyrobot/moderation') errors.push(`${path.relative(root, file)}: database depends on moderation`);
    if (!spec.startsWith('.')) continue;
    const base = path.resolve(path.dirname(file), spec.replace(/\.js$/, ''));
    const resolved = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')].find(candidate => known.has(candidate));
    if (!resolved) continue;
    const target = path.relative(root, resolved).split(path.sep).slice(0, 2).join('/');
    if (owner !== target && owner.startsWith('apps/') && target.startsWith('apps/')) errors.push(`${path.relative(root, file)}: cross-app import ${spec}`);
    if (owner.startsWith('packages/') && target.startsWith('apps/')) errors.push(`${path.relative(root, file)}: package imports an app`);
    edges.get(file).push(resolved);
  }
}
const visiting = new Set();
const visited = new Set();
function visit(file, stack) {
  if (visiting.has(file)) { errors.push(`cycle: ${[...stack, file].map(item => path.relative(root, item)).join(' -> ')}`); return; }
  if (visited.has(file)) return;
  visiting.add(file);
  for (const next of edges.get(file)) visit(next, [...stack, file]);
  visiting.delete(file);
  visited.add(file);
}
for (const file of files) visit(file, []);
if (errors.length) { for (const error of errors) console.error(error); process.exitCode = 1; }
else console.log(`Dependency boundaries and local import cycles: ${files.length} source files checked.`);
