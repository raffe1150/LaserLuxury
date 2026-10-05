import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = 'e634610c865d2baf654870f403adab754ce9deeb';
const previous = '693ecfc11e6b0deb7285957a93b18c00f2285f06';
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const baseline = (path: string) => git('show', `${base}:${path}`);
const current = (path: string) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const allowedExistingChanges = new Set(['server.ts', 'src/auth/supabase-auth.ts', 'src/auth/auth.test.ts']);

test('every pre-existing production file is preserved outside the three reviewed security integration files', () => {
  for (const entry of git('ls-tree', '-r', base).trim().split('\n')) {
    const [metadata, path] = entry.split('\t');
    if (!allowedExistingChanges.has(path)) {
      const contents = readFileSync(new URL('../../' + path, import.meta.url));
      const blob = createHash('sha1').update(`blob ${contents.length}\0`).update(contents).digest('hex');
      assert.equal(blob, metadata.split(' ')[2], `production file changed or removed: ${path}`);
    }
  }
});

type Span = { start: number; end: number; text: string };
function parse(source: string) {
  return ts.createSourceFile('server.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function nodes(source: ts.SourceFile) {
  const routes = new Map<string, ts.ExpressionStatement>();
  const functions = new Map<string, ts.FunctionDeclaration>();
  let bootstrap: ts.IfStatement | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.getText(source).includes('Supabase client initialized with')) bootstrap = node;
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.expression.getText(source) === 'app'
          && call.arguments[0] && ts.isStringLiteral(call.arguments[0])) {
        routes.set(`${call.expression.name.text}:${call.arguments[0].text}`, node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { routes, functions, bootstrap };
}
const oldServer = baseline('server.ts');
const newServer = current('server.ts');
const oldParsed = parse(oldServer);
const newParsed = parse(newServer);
const oldNodes = nodes(oldParsed);
const newNodes = nodes(newParsed);
const routeChanges = new Set(['post:/api/setup-telegram', 'get:/api/salons', 'post:/api/salons']);
const securityImports = new Set(['./src/auth/backend-supabase', './src/channels/telegram-setup', './src/business/salons-api']);

function preservedServer(source: string, parsed: ts.SourceFile, restore: boolean) {
  const edits: Span[] = [];
  const replace = (node: ts.Node, text: string) => edits.push({ start: node.getStart(parsed), end: node.end, text });
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
        && securityImports.has(node.moduleSpecifier.text)) { replace(node, ''); return; }
    if (ts.isVariableStatement(node)) {
      const names = node.declarationList.declarations.map(d => d.name.getText(parsed));
      if (names.includes('DASHBOARD_SALON_COLUMNS') || names.includes('salonDependencies')) { replace(node, ''); return; }
    }
    if (restore && ts.isIfStatement(node) && node.getText(parsed).includes('Supabase not configured for isolated tests.')) {
      assert.ok(oldNodes.bootstrap); replace(node, oldNodes.bootstrap.getText(oldParsed)); return;
    }
    if (restore && ts.isFunctionDeclaration(node) && node.name?.text === 'normalizeBusinessConfig') {
      replace(node, oldNodes.functions.get('normalizeBusinessConfig')!.getText(oldParsed)); return;
    }
    if (restore && ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (ts.isPropertyAccessExpression(call.expression) && call.expression.expression.getText(parsed) === 'app'
          && call.arguments[0] && ts.isStringLiteral(call.arguments[0])) {
        const key = `${call.expression.name.text}:${call.arguments[0].text}`;
        if (routeChanges.has(key)) { replace(node, oldNodes.routes.get(key)!.getText(oldParsed)); return; }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return ts.createPrinter({ removeComments: true }).printFile(parse(source));
}

test('the entire production server AST is unchanged outside backend bootstrap, authorized Telegram setup and salon handlers', () => {
  assert.equal(preservedServer(newServer, newParsed, true), preservedServer(oldServer, oldParsed, false));
});

test('business normalization retains every production field and default; only authorized setup can omit global fallback', () => {
  const oldFunction = oldNodes.functions.get('normalizeBusinessConfig')!.getText(oldParsed);
  const newFunction = newNodes.functions.get('normalizeBusinessConfig')!.getText(newParsed);
  assert.equal(newFunction
    .replace('row: any, fallbackConfig: any = activeConfig', 'row: any')
    .replace('...fallbackConfig,', '...activeConfig,'), oldFunction);
  const make = (source: string) => {
    const context: any = { activeConfig: { globalOnly: 'other-business-config', telegramToken: 'other-token', language: 'sv' },
      normalizeTelegramBotToken: (v: unknown) => String(v ?? '').trim(), normalizeBusinessToneConfig: (v: unknown) => v ?? {} };
    runInNewContext(ts.transpileModule(source + '\nthis.normalize=normalizeBusinessConfig;',
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    return context.normalize;
  };
  const before = make(oldFunction); const after = make(newFunction);
  const row = { id: 2, business_name: 'Synthetic', description: 'Details', address: 'Address', website: 'https://example.test',
    phone: 'synthetic', email: 'synthetic@example.test', timezone: 'Europe/Stockholm', telegram_bot_token: 'tenant-token',
    google_calendar_id: 'tenant-calendar', services: [{ name: 'Service', duration: 30 }] };
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(after(row)), plain(before(row)));
  const scoped = after(row, {});
  assert.equal(scoped.globalOnly, undefined);
  assert.equal(scoped.telegramToken, 'tenant-token');
  assert.equal(scoped.language, 'en');
  for (const field of ['description', 'address', 'website', 'phone', 'email', 'googleCalendarId', 'services']) {
    assert.deepEqual(plain(scoped[field]), plain(before(row)[field]));
  }
  const setup = newNodes.routes.get('post:/api/setup-telegram')!.getText(newParsed);
  assert.match(setup, /hydrateBusinessCalendarConfig\(normalizeBusinessConfig\(row, \{\}\)\)/);
});

test('production Auth verification and its error classification remain unchanged', () => {
  const source = current('src/auth/supabase-auth.ts');
  const undo = source
    .replace("import { getBackendSupabaseConfiguration } from './backend-supabase';\n", '')
    .replace('  const { url, serviceRoleKey } = getBackendSupabaseConfiguration();\n', '')
    .replace('    url,\n    serviceRoleKey,', "    requiredEnvironment('SUPABASE_URL'),\n    requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY'),");
  assert.equal(undo, baseline('src/auth/supabase-auth.ts'));
});

test('the validated security migrations and all rollback scripts are byte-identical to the previous artifact', () => {
  const paths = [
    'supabase/migrations/20261005095355_harden_business_membership_integrity.sql',
    'supabase/migrations/20261005111021_restrict_salons_to_backend_access.sql',
    'supabase/migrations/20261005111029_prepare_businesses_backend_only_rls.sql',
    'tests/security/rollback-businesses.sql', 'tests/security/rollback-salons.sql', 'tests/security/rollback-memberships.sql',
  ];
  for (const path of paths) assert.equal(current(path), git('show', `${previous}:${path}`), path);
  for (const name of ['20261004130125_add_chat_history_provider_event_time.sql', '20261004201036_add_whatsapp_reminder_template_config.sql']) {
    assert.equal(existsSync(new URL('../../supabase/migrations/' + name, import.meta.url)), false, name);
  }
});
