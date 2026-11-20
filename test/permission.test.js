import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWithPermissionCompatibility, withPermissionCompatibility } from '../src/permission.js';

const modes = ['read-only', 'workspace-write', 'danger-full-access'];
const definition = {
  name: 'bash',
  parameters: {
    type: 'object',
    properties: {
      sandbox_permissions: { enum: modes.slice(1), description: 'Original permission description.' },
      justification: { description: 'Original justification description.' },
    },
  },
  execute: (args, exec) => ({ args, exec }),
};
const exec = { agent: { session: {} } };
const command = { command: 'pwd', description: 'Show directory' };

for (let i = 0; i < modes.length; i++) {
  const current = modes[i];
  test(`normalizes satisfied requests under ${current}`, () => {
    const tool = withPermissionCompatibility(definition, {
      resolve(target) {
        assert.equal(target.session, exec.agent.session);
        return { mode: current };
      },
    });
    assert.deepEqual(tool.parameters, {
      ...definition.parameters,
      properties: {
        ...definition.parameters.properties,
        sandbox_permissions: {
          ...definition.parameters.properties.sandbox_permissions,
          enum: [...modes.slice(1), 'read-only'],
        },
      },
    });
    assert.deepEqual(definition.parameters.properties.sandbox_permissions.enum, modes.slice(1));
    for (const [j, requested] of modes.entries()) {
      for (const reason of [{}, { justification: '' }, { justification: 'A reason.' }]) {
        const args = Object.freeze({ ...command, sandbox_permissions: requested, ...reason });
        assert.deepEqual(tool.execute(args, exec), { args: j <= i ? command : args, exec });
      }
    }
  });
}

test('wraps only the requested shell definition at registration', () => {
  const policy = { resolve: () => ({ mode: 'danger-full-access' }) };
  const pwsh = { ...definition, name: 'pwsh' };
  const options = {};
  const registrations = [];
  const ctx = {
    shell: { sandboxMode: 'read-only' },
    get: (key) => key === 'sandboxPolicy' ? policy : undefined,
    tools: { register: (...args) => registrations.push(args) },
    extend(overrides) { return { ...this, ...overrides }; },
  };
  applyWithPermissionCompatibility(ctx, {}, (wrapped) => {
    wrapped.tools.register(definition, options);
    wrapped.tools.register(pwsh, options);
  }, 'pwsh');
  assert.equal(registrations[0][0], definition);
  assert.equal(registrations[0][1], options);
  assert.notEqual(registrations[1][0], pwsh);
  assert.deepEqual(registrations[1][0].parameters.properties.sandbox_permissions.enum, [...modes.slice(1), 'read-only']);
  assert.equal(registrations[1][1], options);
});

test('passes unsandboxed definitions and invalid or unrecognized requests through', () => {
  const policy = { resolve: () => ({ mode: 'danger-full-access' }) };
  const unsandboxed = { ...definition, parameters: {} };
  assert.equal(withPermissionCompatibility(unsandboxed, policy), unsandboxed);
  const tool = withPermissionCompatibility(definition, policy);
  for (const args of [command, { ...command, sandbox_permissions: 'unknown' },
    { ...command, sandbox_permissions: 'read-only', justification: false }]) {
    assert.equal(tool.execute(args, exec).args, args);
  }
  const unrecognized = withPermissionCompatibility(definition, { resolve: () => ({ mode: 'unknown' }) });
  const args = { ...command, sandbox_permissions: 'workspace-write' };
  assert.equal(unrecognized.execute(args, exec).args, args);
});
