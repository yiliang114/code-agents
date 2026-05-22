/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import v8 from 'node:v8';

const DEFAULTS = {
  turns: 12,
  toolResultKib: 256,
  subagents: 2,
  subagentTurns: 12,
  cloneCount: 2,
  checkpointCopies: 1,
  mode: 'both',
  json: false,
  retainSubagentTranscripts: true,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };

  for (const arg of argv) {
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--no-retain-subagent-transcripts') {
      options.retainSubagentTranscripts = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }

    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const [, key, value] = match;
    switch (key) {
      case 'turns':
      case 'tool-result-kib':
      case 'subagents':
      case 'subagent-turns':
      case 'clone-count':
      case 'checkpoint-copies': {
        const normalizedKey = key.replace(/-([a-z])/g, (_, char) =>
          char.toUpperCase(),
        );
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error(`Invalid numeric value for --${key}: ${value}`);
        }
        options[normalizedKey] = parsed;
        break;
      }
      case 'mode':
        if (!['build', 'clone', 'checkpoint', 'both'].includes(value)) {
          throw new Error(`Invalid --mode: ${value}`);
        }
        options.mode = value;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/memory-pressure-repro.mjs [options]

Builds a synthetic Qwen-like long-session history and applies clone/checkpoint
pressure to reproduce full-history structuredClone / serialization peaks.

Options:
  --turns=N                         Root review turns. Default: 12
  --tool-result-kib=N               Tool output size per tool result. Default: 256
  --subagents=N                     Subagent calls per root turn. Default: 2
  --subagent-turns=N                Tool turns per subagent. Default: 12
  --clone-count=N                   Retained structuredClone copies. Default: 2
  --checkpoint-copies=N             Retained checkpoint JSON copies. Default: 1
  --mode=build|clone|checkpoint|both
  --no-retain-subagent-transcripts  Keep only agent summaries in parent history
  --json                            Print JSON result only
`);
}

function mib(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(1));
}

function memorySnapshot(label) {
  const memory = process.memoryUsage();
  const heap = v8.getHeapStatistics();

  return {
    label,
    rssMiB: mib(memory.rss),
    heapUsedMiB: mib(memory.heapUsed),
    heapTotalMiB: mib(memory.heapTotal),
    externalMiB: mib(memory.external),
    arrayBuffersMiB: mib(memory.arrayBuffers),
    heapLimitMiB: mib(heap.heap_size_limit),
  };
}

function buildSizedText(bytes, label) {
  if (bytes <= 0) return '';

  const chunks = [];
  let remaining = bytes;
  let index = 0;

  while (remaining > 0) {
    const prefix = `${label}:${index.toString(36)}:`;
    const fillerLength = Math.max(0, Math.min(remaining, 512) - prefix.length);
    const chunk = `${prefix}${'x'.repeat(fillerLength)}`;
    chunks.push(chunk.slice(0, remaining));
    remaining -= chunk.length;
    index += 1;
  }

  return chunks.join('');
}

function makeUserTurn(turn) {
  return {
    role: 'user',
    parts: [
      {
        text:
          `Review PR batch turn ${turn}. Read diffs, inspect files, ` +
          'launch subagents, and summarize findings.',
      },
    ],
  };
}

function makeToolCallMessage(id, name, args) {
  return {
    role: 'model',
    parts: [
      {
        text: `Calling ${name} for ${id}`,
        thought: true,
      },
      {
        functionCall: {
          id,
          name,
          args,
        },
      },
    ],
  };
}

function makeFunctionResponse(id, name, output) {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id,
          name,
          response: {
            output,
            exitCode: 0,
          },
        },
      },
    ],
  };
}

function buildSubagentHistory({ turn, agent, subagentTurns, toolResultBytes }) {
  const history = [
    {
      role: 'user',
      parts: [
        {
          text:
            `Subagent ${agent} for root turn ${turn}: perform deep static ` +
            'review and inspect all relevant files.',
        },
      ],
    },
  ];

  let capturedBytes = 0;
  for (let step = 0; step < subagentTurns; step += 1) {
    const callId = `subagent-${turn}-${agent}-${step}`;
    history.push(
      makeToolCallMessage(callId, step % 2 === 0 ? 'read_file' : 'grep_search', {
        path: `synthetic/pr-${turn}/file-${agent}-${step}.ts`,
      }),
    );

    const output = buildSizedText(
      toolResultBytes,
      `subagent-output:${turn}:${agent}:${step}`,
    );
    capturedBytes += output.length;
    history.push(makeFunctionResponse(callId, 'read_file', output));
  }

  history.push({
    role: 'model',
    parts: [
      {
        text: buildSizedText(
          Math.min(toolResultBytes, 16 * 1024),
          `subagent-summary:${turn}:${agent}`,
        ),
      },
    ],
  });

  return { history, capturedBytes };
}

function buildHistory(options) {
  const history = [];
  let toolResultBytes = 0;
  let subagentHistoryRecords = 0;
  let agentCalls = 0;

  for (let turn = 0; turn < options.turns; turn += 1) {
    history.push(makeUserTurn(turn));

    const rootCallId = `root-read-${turn}`;
    history.push(
      makeToolCallMessage(rootCallId, 'run_shell_command', {
        command: `gh pr diff ${1000 + turn} --patch`,
      }),
    );

    const rootOutput = buildSizedText(
      options.toolResultKib * 1024,
      `root-output:${turn}`,
    );
    toolResultBytes += rootOutput.length;
    history.push(makeFunctionResponse(rootCallId, 'run_shell_command', rootOutput));

    for (let agent = 0; agent < options.subagents; agent += 1) {
      const agentCallId = `agent-${turn}-${agent}`;
      history.push(
        makeToolCallMessage(agentCallId, 'agent', {
          description: `Synthetic subagent ${agent} for turn ${turn}`,
        }),
      );

      const subagent = buildSubagentHistory({
        turn,
        agent,
        subagentTurns: options.subagentTurns,
        toolResultBytes: options.toolResultKib * 1024,
      });
      subagentHistoryRecords += subagent.history.length;
      toolResultBytes += subagent.capturedBytes;
      agentCalls += 1;

      const agentOutput = {
        summary: buildSizedText(
          Math.min(options.toolResultKib * 1024, 32 * 1024),
          `agent-summary:${turn}:${agent}`,
        ),
        stats: {
          turn,
          agent,
          subagentRecords: subagent.history.length,
          capturedBytes: subagent.capturedBytes,
        },
        transcript: options.retainSubagentTranscripts
          ? subagent.history
          : undefined,
      };

      history.push(
        makeFunctionResponse(
          agentCallId,
          'agent',
          JSON.stringify(agentOutput),
        ),
      );
    }
  }

  return {
    history,
    stats: {
      records: history.length,
      agentCalls,
      subagentHistoryRecords,
      toolResultBytes,
    },
  };
}

function runPressure(options) {
  const snapshots = [memorySnapshot('start')];
  const { history, stats } = buildHistory(options);
  snapshots.push(memorySnapshot('after-history-build'));

  const historyJson = JSON.stringify(history);
  snapshots.push(memorySnapshot('after-history-json'));

  const retainedClones = [];
  const retainedCheckpoints = [];

  if (options.mode === 'clone' || options.mode === 'both') {
    for (let index = 0; index < options.cloneCount; index += 1) {
      retainedClones.push(structuredClone(history));
      snapshots.push(memorySnapshot(`after-structured-clone-${index + 1}`));
    }
  }

  if (options.mode === 'checkpoint' || options.mode === 'both') {
    for (let index = 0; index < options.checkpointCopies; index += 1) {
      const clientHistory = structuredClone(history);
      snapshots.push(memorySnapshot(`after-checkpoint-clone-${index + 1}`));
      retainedCheckpoints.push(
        JSON.stringify({
          kind: 'synthetic-checkpoint',
          index,
          history,
          clientHistory,
        }),
      );
      snapshots.push(memorySnapshot(`after-checkpoint-json-${index + 1}`));
    }
  }

  return {
    options,
    history: {
      ...stats,
      historyJsonBytes: Buffer.byteLength(historyJson),
      retainedSubagentTranscripts: options.retainSubagentTranscripts,
    },
    pressure: {
      retainedCloneCount: retainedClones.length,
      retainedCheckpointCount: retainedCheckpoints.length,
      retainedCheckpointBytes: retainedCheckpoints.reduce(
        (sum, checkpoint) => sum + Buffer.byteLength(checkpoint),
        0,
      ),
      historyJsonBytes: Buffer.byteLength(historyJson),
    },
    memory: {
      snapshots,
      end: memorySnapshot('end'),
    },
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = runPressure(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('Synthetic memory pressure reproduction completed.');
  console.log(JSON.stringify(result, null, 2));
}

main();
