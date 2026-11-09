// The dev containers stones ships, one per supported stack, and which one a
// detected project gets. Each `devcontainer/<id>/devcontainer.json` is
// generated from its Dockerfile; run this file to regenerate them.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { renderDevcontainer } from '../hooks/devcontainer.mjs';
import { PACKAGE_ROOT } from './catalog.mjs';

export const DEVCONTAINER_STACKS = ['node-pnpm', 'python', 'go'];

// First match wins for repos with several stacks.
export function devcontainerStack(stack) {
  if (stack.packageManagers?.includes('pnpm')) return 'node-pnpm';
  if (stack.ecosystems?.includes('python')) return 'python';
  if (stack.ecosystems?.includes('go')) return 'go';
  return null;
}

export const shippedDockerfile = (id, root = PACKAGE_ROOT) => readFileSync(join(root, 'devcontainer', id, 'Dockerfile'), 'utf8');

export function buildShipped(root = PACKAGE_ROOT) {
  for (const id of DEVCONTAINER_STACKS) {
    writeFileSync(join(root, 'devcontainer', id, 'devcontainer.json'), renderDevcontainer(shippedDockerfile(id, root), { name: id }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) buildShipped();
