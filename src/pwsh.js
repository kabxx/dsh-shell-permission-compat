import { apply as applyNativePwsh } from '@deepseek-ai/dsh-tool-pwsh';
import { applyWithPermissionCompatibility } from './permission.js';

export { Config, inject } from '@deepseek-ai/dsh-tool-pwsh';

export function apply(ctx, config) {
  return applyWithPermissionCompatibility(ctx, config, applyNativePwsh, 'pwsh');
}
