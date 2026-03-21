/**
 * Container runtime abstraction for NanoClaw.
 * Uses Apple Container CLI (`container`) on macOS.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns CLI args for a writable bind mount. */
export function writableMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`;
}

/** Ensure the container runtime is available. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} --version`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime available');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Apple Container CLI not found                         ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Container agents require Apple Container. To fix:            ║',
    );
    console.error(
      '║  1. Install: brew install container                            ║',
    );
    console.error(
      '║  2. Run: container --version                                   ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but not available', {
      cause: err,
    });
  }
}

/** Stop orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ls --format json`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const containers = JSON.parse(output || '[]') as Array<{
      configuration: { id: string };
      status: string;
    }>;
    const orphans = containers.filter(
      (c) =>
        c.configuration.id.startsWith('nanoclaw-') &&
        c.status === 'running',
    );
    for (const c of orphans) {
      try {
        execSync(stopContainer(c.configuration.id), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        {
          count: orphans.length,
          names: orphans.map((c) => c.configuration.id),
        },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
