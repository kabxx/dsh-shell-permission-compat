import { apply as applyNativeBash } from '@deepseek-ai/dsh-tool-bash';
import { applyWithPermissionCompatibility } from './permission.js';

export { Config, inject } from '@deepseek-ai/dsh-tool-bash';

export function apply(ctx, config) {
  return applyWithPermissionCompatibility(ctx, config, applyNativeBash, 'bash');
}
