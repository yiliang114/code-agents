/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'memory-pressure-repro.mjs',
);

describe('memory-pressure-repro', () => {
  it('generates deterministic history clone pressure metrics', () => {
    const stdout = execFileSync(
      process.execPath,
      [
        scriptPath,
        '--turns=2',
        '--tool-result-kib=2',
        '--subagents=1',
        '--subagent-turns=2',
        '--clone-count=1',
        '--checkpoint-copies=1',
        '--mode=both',
        '--json',
      ],
      { encoding: 'utf8' },
    );

    const result = JSON.parse(stdout);

    expect(result.options.turns).toBe(2);
    expect(result.history.records).toBeGreaterThan(0);
    expect(result.history.toolResultBytes).toBeGreaterThan(0);
    expect(result.pressure.retainedCloneCount).toBe(1);
    expect(result.pressure.retainedCheckpointCount).toBe(1);
    expect(result.pressure.historyJsonBytes).toBeGreaterThan(0);
    expect(result.memory.end.heapUsedMiB).toBeGreaterThan(0);
  });
});
