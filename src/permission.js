const PERMISSION_LEVELS = new Map([
  ['read-only', 0],
  ['workspace-write', 1],
  ['danger-full-access', 2],
]);

function withoutPermission(args) {
  const { sandbox_permissions, justification, ...rest } = args;
  return rest;
}

function isPermissionRequest(args) {
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    && PERMISSION_LEVELS.has(args.sandbox_permissions)
    && (args.justification === undefined || typeof args.justification === 'string');
}

function presentationArgs(args) {
  // Native presenters validate replayed arguments against the original enum.
  return isPermissionRequest(args) && args.sandbox_permissions === 'read-only' ? withoutPermission(args) : args;
}

export function applyWithPermissionCompatibility(ctx, config, nativeApply, toolName) {
  const sandboxPolicy = ctx.shell.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy');
  if (!sandboxPolicy) return nativeApply(ctx, config);

  // Delegate registration at the original scope, including re-registrations when jobs mount.
  return nativeApply(ctx.extend({
    tools: {
      register(definition, options) {
        const tool = definition.name === toolName ? withPermissionCompatibility(definition, sandboxPolicy) : definition;
        return ctx.tools.register(tool, options);
      },
    },
  }), config);
}

export function withPermissionCompatibility(definition, sandboxPolicy) {
  const properties = definition.parameters?.properties;
  const permissions = properties?.sandbox_permissions;
  if (!Array.isArray(permissions?.enum)) return definition;

  return {
    ...definition,
    parameters: {
      ...definition.parameters,
      properties: {
        ...properties,
        sandbox_permissions: {
          ...permissions,
          enum: [...permissions.enum, 'read-only'],
        },
      },
    },
    execute(args, exec) {
      if (isPermissionRequest(args)) {
        const target = exec.agent === undefined ? {} : { session: exec.agent.session };
        const effectiveLevel = PERMISSION_LEVELS.get(sandboxPolicy.resolve(target).mode);
        if (effectiveLevel !== undefined && PERMISSION_LEVELS.get(args.sandbox_permissions) <= effectiveLevel) {
          return definition.execute(withoutPermission(args), exec);
        }
      }
      return definition.execute(args, exec);
    },
    ...(definition.presentCall && {
      presentCall: (args) => definition.presentCall(presentationArgs(args)),
    }),
    ...(definition.presentResult && {
      presentResult: (args, result) => definition.presentResult(presentationArgs(args), result),
    }),
  };
}
