import { describe, expect, it } from 'vitest';
import { CONTAINER_RUNTIME_BIN, readonlyMountArgs, stopContainer } from './container-runtime.js';

describe('container-runtime', () => {
  it('uses Apple Container CLI binary', () => {
    expect(CONTAINER_RUNTIME_BIN).toBe('container');
  });

  it('generates correct readonly mount args', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });

  it('generates correct stop command', () => {
    expect(stopContainer('nanoclaw-test-123')).toBe('container stop -t 1 nanoclaw-test-123');
  });
});
