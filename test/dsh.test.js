import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const installDir = process.env.DSH_INSTALL_DIR;
const workspace = fileURLToPath(new URL('..', import.meta.url));
const base = ['@deepseek-ai/dsh-web-app'];
const presets = ['preset-standard', 'preset-ptc', 'preset-cordis'];
const modes = ['read-only', 'workspace-write', 'danger-full-access'];
const shells = [
  { toolName: 'bash', suffix: '/bash', command: "printf 'ok\\n'" },
  { toolName: 'pwsh', suffix: '/pwsh', command: "Write-Output 'ok'" },
];

test('DSH composes the Shell compatibility bundle and runs both native tool pipelines', {
  skip: !installDir && 'Set DSH_INSTALL_DIR to run against an installed DSH.',
  timeout: 10_000,
}, async (t) => {
  const { name } = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
  const anchor = join(installDir, 'package.json');
  const require = createRequire(anchor);
  const fromDsh = (specifier) => import(pathToFileURL(require.resolve(specifier)).href);
  const [{ Context }, { ToolsService }, boot, executor, { interpolate }] = await Promise.all([
    fromDsh('@deepseek-ai/cordis'), fromDsh('@deepseek-ai/dsh-tools'),
    fromDsh('@deepseek-ai/dsh-app-boot'), fromDsh('@deepseek-ai/dsh-tool-executor-native'),
    fromDsh('@deepseek-ai/cordis-plugin-loader'),
  ]);
  const tempRoot = await realpath(tmpdir());
  const tempPrefix = join(tempRoot, 'dsh-shell-permission-test-');
  const testDir = await mkdtemp(tempPrefix);
  const profileDir = join(testDir, 'profiles', 'test');
  const manifest = join(profileDir, 'package.json');
  const ctx = new Context();
  try {
    const linkedPackage = join(profileDir, 'node_modules', name);
    await mkdir(dirname(linkedPackage), { recursive: true });
    await symlink(workspace, linkedPackage, 'junction');
    const loadProfile = async (bundles) => {
      await writeFile(manifest, JSON.stringify({ name: 'test-profile', dsh: { profile: { bundles } } }));
      const profile = boot.loadProfileDirectory('compat-test', profileDir, anchor);
      assert.deepEqual(profile.skippedBundles, []);
      return profile;
    };
    const before = await loadProfile(base);
    const profile = await loadProfile([...base, name]);
    const compose = (layer) => boot.composeEntries(layer.layers.map(({ patches }) => patches));
    const entries = compose(profile);
    const expected = compose(before).map((entry) => {
      if (!presets.includes(entry.id)) return entry;
      const plugins = entry.config.plugins.map((plugin) => {
        const shell = shells.find(({ toolName }) => plugin.id === `tool-${toolName}`);
        return shell
          ? { ...plugin, id: `${shell.toolName}-permission-compat`, name: name + shell.suffix }
          : plugin;
      });
      return { ...entry, config: { ...entry.config, plugins } };
    });
    // Parsed expression nodes include source URLs. Compare the expression and config, excluding provenance.
    const withoutProvenance = (entries) => JSON.parse(JSON.stringify(entries, (key, value) =>
      key === 'baseUrl' ? undefined : value));
    assert.deepEqual(withoutProvenance(entries), withoutProvenance(expected));

    await t.test('shipped presets select one compatible shell by host platform', () => {
      for (const id of presets) {
        const { plugins } = entries.find((entry) => entry.id === id).config;
        const rows = plugins.filter((row) => shells.some(({ suffix }) => row.name === name + suffix));
        assert.equal(rows.length, 2, id);
        for (const [platform, expectedShell] of [['win32', 'pwsh'], ['linux', 'bash'], ['darwin', 'bash']]) {
          const selected = rows.filter((row) => !interpolate({ process: { platform } }, row.disabled));
          assert.deepEqual(selected.map((row) => row.id), [`${expectedShell}-permission-compat`], `${id} ${platform}`);
        }
      }
    });

    const resolution = await boot.createRuntimeResolution({ installAnchor: anchor, profile, home: testDir });
    await ctx.plugin(boot.PluginPackages, { resolution }).await();
    const manifestUrl = pathToFileURL(manifest).href;
    const bundleMeta = boot.readPluginMeta(name, manifestUrl);
    assert.equal(bundleMeta.error, undefined);
    assert.equal(bundleMeta.title.zh, 'dsh-shell-permission-compat');
    assert.equal(bundleMeta.title.en, 'dsh-shell-permission-compat');
    assert.match(bundleMeta.icon, /^data:image\/svg\+xml;base64,/);
    // The copied Standard and Creator presets resolve their built-in skills from the patch's location.
    const requireFromPatch = createRequire(profile.layers.at(-1).patchPaths[0]);
    assert.equal(requireFromPatch.resolve('@deepseek-ai/dsh-agent-preset/package.json'),
      require.resolve('@deepseek-ai/dsh-agent-preset/package.json'));
    await ctx.plugin(ToolsService).await();
    await ctx.plugin(executor).await();

    for (const shell of shells) {
      const { toolName, suffix } = shell;
      const specifier = name + suffix;
      await t.test(`runs the ${toolName} tool pipeline`, async (t) => {
        assert.equal(ctx.pluginPackages.packageOf(specifier, manifestUrl)?.name, name);
        const metadata = boot.readPluginMeta(specifier, manifestUrl);
        assert.equal(metadata.error, undefined);
        assert.equal(metadata.title.zh, `dsh-shell-permission-compat${suffix}`);
        assert.equal(metadata.title.en, `dsh-shell-permission-compat${suffix}`);
        assert.match(metadata.icon, /^data:image\/svg\+xml;base64,/);
        const fixtureEntry = join(profileDir, `${toolName}.mjs`);
        await writeFile(fixtureEntry, `export * from ${JSON.stringify(specifier)};`);
        const [plugin, native] = await Promise.all([
          import(pathToFileURL(fixtureEntry)), fromDsh(`@deepseek-ai/dsh-tool-${toolName}`),
        ]);
        assert.equal(plugin.Config, native.Config);
        assert.equal(plugin.inject, native.inject);
        await verifyTool(t, { ctx, plugin, native, shell, cwd: profileDir });
      });
    }
  } finally {
    await ctx.fiber.dispose();
    // Only remove this test run's unique working directory.
    const resolved = await realpath(testDir);
    assert.equal(dirname(resolved), tempRoot);
    assert.ok(resolved.startsWith(tempPrefix));
    await rm(resolved, { recursive: true, force: true });
  }
});

async function verifyTool(t, { ctx, plugin, native, shell, cwd }) {
  const { toolName } = shell;
  const launches = [];
  const approvals = [];
  const promptSections = [];
  const session = { mode: 'danger-full-access' };
  const agent = { id: 'test-agent', session };
  const signal = new AbortController().signal;
  const command = { command: shell.command, description: 'Print a short test message' };
  let nextId = 0;
  const invoke = async (args) => {
    const id = `test-${toolName}-${++nextId}`;
    const { results } = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id, name: toolName, arguments: JSON.stringify(args) }],
      agent,
      signal,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].callId, id);
    return results[0].result;
  };
  const assertForeground = (result, mode, expectedCwd = cwd) => {
    assert.equal(result.isError, false, JSON.stringify(result.error));
    assert.equal(result.value.kind, 'foreground');
    assert.deepEqual(result.value.stdout, { text: 'ok\n', truncated: false });
    assert.equal(result.value.exitCode, 0);
    assert.equal(result.value.cwd, expectedCwd);
    assert.deepEqual(result.value.sandbox, { mode, denied: false });
    assert.deepEqual(result.content, [{ type: 'text', text: 'ok\n' }]);
    assert.deepEqual(result.meta, { cwd: expectedCwd });
  };
  let outcome = 'rejected';
  const stream = { readFrom: (offset) => ({ text: '', nextOffset: offset, lossy: false }) };
  const deps = ctx.plugin((services) => {
    services.provide('systemPrompt', {
      tools() {},
      section(section) { promptSections.push(section); },
      getSectionOrder() { return 0; },
    });
    services.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: session?.mode ?? 'read-only' }) });
    services.provide('approval', { request: async (request) => { approvals.push(request); return outcome; } });
    services.provide('workingDirectory', { ensure: async () => cwd });
    services.provide('shellEnv', { collect: () => ({}) });
    services.provide('shell', {
      sandboxMode: 'read-only',
      resolve: (request) => ({ timeoutMs: 1_000, onExpiry: 'kill', stdoutMaxBytes: 4_096, ...request }),
      execute: async (spec) => {
        assert.equal(spec.command, command.command);
        launches.push(spec);
        return {
          result: async () => ({
            stdout: { text: 'ok\n', truncated: false }, stderr: { text: '', truncated: false },
            exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs,
            sandbox: { mode: spec.sandboxPolicy.mode, denied: false },
          }),
          done: Promise.resolve(), status: 'completed', exitCode: 0,
          observed: { stdout: stream, stderr: stream },
        };
      },
    });
  });
  await deps.await();

  const stock = ctx.plugin(native, {});
  await stock.await();
  const stockSchema = ctx.tools.schemas()[0];
  const stockPromptSections = promptSections.splice(0);
  assert.ok(stockPromptSections.some(({ name }) => name === `tool:${toolName}`));
  assertForeground(await invoke(command), 'danger-full-access');
  const stockDenial = await invoke({ ...command, sandbox_permissions: 'workspace-write', justification: 'Reason.' });
  assert.equal(stockDenial.isError, true);
  assert.equal(stockDenial.error.info.code, 'SANDBOX_ESCALATION_INVALID_ARGUMENT');
  assert.match(stockDenial.error.message, /sandbox escalation to "workspace-write" is not strictly wider than this call's current "danger-full-access" mode/);
  assert.equal(launches.length, 1);
  assert.deepEqual(approvals, []);
  await stock.dispose();

  const replacement = ctx.plugin(plugin, {});
  try {
    await replacement.await();
    assert.deepEqual(ctx.tools.definitions().map((definition) => definition.name), [toolName]);
    assert.deepEqual(promptSections, stockPromptSections);
    const stockPermissions = stockSchema.parameters.properties.sandbox_permissions;
    assert.deepEqual(ctx.tools.schemas()[0], {
      ...stockSchema,
      parameters: {
        ...stockSchema.parameters,
        properties: {
          ...stockSchema.parameters.properties,
          sandbox_permissions: { ...stockPermissions, enum: [...stockPermissions.enum, 'read-only'] },
        },
      },
    });

    await t.test('foreground call returns output, exit status and working directory', async () => {
      const args = { ...command, sandbox_permissions: 'read-only', workdir: 'example' };
      const result = await invoke(args);
      assertForeground(result, 'danger-full-access', join(cwd, 'example'));
      const tool = ctx.tools.get(toolName);
      assert.deepEqual(tool.presentCall(args), {
        card: 'terminal', title: command.command, description: command.description, cwd: 'example',
      });
      assert.deepEqual(tool.presentResult(args, result), { card: 'terminal', output: 'ok\n', exitCode: 0 });
    });

    const reasons = [{}, { justification: '' }, { justification: 'Reason.' }];
    const assertSatisfied = async (current, requested) => {
      session.mode = current;
      for (const reason of reasons) {
        const before = launches.length;
        assertForeground(await invoke({ ...command, sandbox_permissions: requested, ...reason }), current);
        assert.equal(launches.length, before + 1);
        assert.equal(launches.at(-1).sandboxPolicy.mode, current);
      }
      assert.deepEqual(approvals, []);
    };
    await t.test('same-level requests use standing permissions without approval', async () => {
      for (const mode of modes) await assertSatisfied(mode, mode);
    });
    await t.test('lower requests use standing permissions without approval', async () => {
      for (const [i, current] of modes.entries()) {
        for (const requested of modes.slice(0, i)) await assertSatisfied(current, requested);
      }
    });
    await t.test('higher requests use native approval and apply only once', async () => {
      for (const [i, current] of modes.entries()) {
        for (const requested of modes.slice(i + 1)) {
          session.mode = current;
          let priorApprovals = approvals.length;
          const priorLaunches = launches.length;
          const missingReason = await invoke({ ...command, sandbox_permissions: requested });
          assert.equal(missingReason.isError, true);
          assert.match(missingReason.error.message, /justification/);
          assert.equal(approvals.length, priorApprovals);

          const widening = { ...command, sandbox_permissions: requested, justification: 'Reason.' };
          outcome = 'rejected';
          const denial = await invoke(widening);
          assert.equal(denial.isError, true);
          assert.equal(denial.error.info.code, 'SANDBOX_ESCALATION_REJECTED');
          assert.equal(launches.length, priorLaunches);
          assert.equal(approvals.length, ++priorApprovals);
          assert.equal(approvals.at(-1).reason, `escalate sandbox to ${requested}: Reason.`);

          outcome = 'allowed-once';
          assertForeground(await invoke(widening), requested);
          assert.equal(launches.length, priorLaunches + 1);
          assert.equal(approvals.length, ++priorApprovals);
          assertForeground(await invoke(command), current);
          assert.equal(launches.length, priorLaunches + 2);
          assert.equal(approvals.length, priorApprovals);
        }
      }
    });

    await t.test('background calls use the native job lifecycle', async () => {
      let activeJob;
      const jobs = ctx.plugin((services) => {
        services.provide('jobs', {
          start(spec) {
            assert.equal(spec.kind, toolName);
            activeJob = spec.run();
            return 'test-job';
          },
        });
      });
      try {
        await jobs.await();
        await new Promise(setImmediate);
        assert.ok(ctx.tools.get(toolName).parameters.properties.run_in_background);
        session.mode = 'read-only';
        const result = await invoke({ ...command, sandbox_permissions: 'read-only', run_in_background: true });
        assert.equal(result.isError, false, JSON.stringify(result.error));
        assert.deepEqual(result.value, { kind: 'background', jobId: 'test-job', cwd });
        assert.deepEqual(result.content, [{ type: 'text', text: 'started background job test-job' }]);
        assert.deepEqual(await activeJob.done, { status: 'completed', detail: 'exit code: 0' });
        assert.equal(launches.at(-1).sandboxPolicy.mode, 'read-only');
      } finally {
        await jobs.dispose();
      }
      assert.equal(ctx.tools.get(toolName).parameters.properties.run_in_background, undefined);
    });
  } finally {
    await replacement.dispose();
    assert.equal(ctx.tools.get(toolName), undefined);
    await deps.dispose();
  }
}
