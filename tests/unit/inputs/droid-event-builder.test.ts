import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  OtlpTraceFlusher,
  type TraceExporterLike,
} from '../../../src/flushers/otlp-trace-flusher.js';
import { buildDroidEvents } from '../../../src/inputs/droid/droid-event-builder.js';
import {
  parseDroidLogLines,
  readDroidSettings,
  readDroidTranscript,
} from '../../../src/inputs/droid/droid-parser.js';
import type { DroidRecord } from '../../../src/inputs/droid/droid-types.js';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../fixtures/droid/golden-v2/', import.meta.url),
);
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const USER_MESSAGE_ID = '00000000-0000-4000-8000-000000000003';

function spanId(parts: string[], length: 16 | 32 = 16): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, length);
}

async function convertWithPilot(entries: Awaited<ReturnType<typeof buildDroidEvents>>['entries']) {
  const captured: ReadableSpan[] = [];
  const exporter: TraceExporterLike = {
    export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
      captured.push(...spans);
      callback({ code: ExportResultCode.SUCCESS });
    },
    shutdown: () => Promise.resolve(),
  };
  const flusher = new OtlpTraceFlusher({
    enabled: true,
    endpoints: [{ name: 'test', endpoint: 'http://localhost:4318/v1/traces', headers: {} }],
    protocol: 'http/protobuf',
    serviceName: 'droid-fixture',
    debug: false,
  }, undefined, () => exporter);
  try {
    await flusher.sendBatch(entries);
    await flusher.flush();
    return captured;
  } finally {
    await flusher.shutdown();
  }
}

async function convertStrictWithPilot(
  entries: Awaited<ReturnType<typeof buildDroidEvents>>['entries'],
) {
  const captured: ReadableSpan[] = [];
  const dataDir = await mkdtemp(path.join(tmpdir(), 'droid-strict-convert-'));
  const exporter: TraceExporterLike = {
    export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
      captured.push(...spans);
      callback({ code: ExportResultCode.SUCCESS });
    },
    shutdown: () => Promise.resolve(),
  };
  const flusher = new OtlpTraceFlusher({
    enabled: true,
    endpoints: [{ name: 'test', endpoint: 'http://localhost:4318/v1/traces', headers: {} }],
    protocol: 'http/protobuf',
    serviceName: 'droid-strict-fixture',
    debug: false,
    dataDir,
  }, undefined, () => exporter);
  try {
    await flusher.sendBatchStrict(entries);
    await flusher.flush();
    return captured;
  } finally {
    await flusher.shutdown();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function goldenInputs() {
  const records = await readDroidTranscript(`${FIXTURE_DIR}/session.jsonl`);
  const settings = await readDroidSettings(`${FIXTURE_DIR}/session.settings.json`);
  const observations = parseDroidLogLines(
    await import('node:fs/promises').then(fs => fs.readFile(`${FIXTURE_DIR}/droid.log`, 'utf8')),
  );
  return { records, settings, observations };
}

function identityProjection(entries: Array<Record<string, unknown>>) {
  return entries.map(entry => ({
    eventId: entry['event.id'],
    eventName: entry['event.name'],
    traceId: entry.trace_id,
    spanId: entry.span_id,
    parentSpanId: entry.parent_span_id,
    turnId: entry['gen_ai.turn.id'],
    stepId: entry['gen_ai.step.id'],
  }));
}

describe('Droid event builder', () => {
  it('builds the sanitized 2-LLM/1-tool golden into a deterministic AgentLoop topology', async () => {
    const { records, settings, observations } = await goldenInputs();
    const first = await buildDroidEvents(records, {
      sessionId: SESSION_ID,
      settings,
      observations,
    });
    const second = await buildDroidEvents(records, {
      sessionId: SESSION_ID,
      settings,
      observations,
    });
    const entries = first.entries;

    expect(entries.map(entry => entry['event.name'])).toEqual([
      'other',
      'llm.request',
      'llm.response',
      'tool.call',
      'tool.result',
      'llm.request',
      'llm.response',
    ]);
    expect(identityProjection(entries)).toEqual(identityProjection(second.entries));
    expect(new Set(entries.map(entry => entry['event.id'])).size).toBe(entries.length);
    expect(new Set(entries.map(entry => entry.trace_id)).size).toBe(1);
    expect(entries.every(entry => entry['gen_ai.session.id'] === SESSION_ID)).toBe(true);
    expect(entries.every(entry => entry['gen_ai.agent.type'] === 'droid')).toBe(true);
    expect(entries.every(entry => entry['user.id'] === '')).toBe(true);
    expect(entries.every(entry => entry['workspace.path'] === '/workspace/droid-fixture')).toBe(true);

    const prompt = entries[0];
    const requests = entries.filter(entry => entry['event.name'] === 'llm.request');
    const responses = entries.filter(entry => entry['event.name'] === 'llm.response');
    const toolCall = entries.find(entry => entry['event.name'] === 'tool.call')!;
    const toolResult = entries.find(entry => entry['event.name'] === 'tool.result')!;

    const turnId = String(prompt['gen_ai.turn.id']);
    const expectedTraceId = spanId([SESSION_ID, USER_MESSAGE_ID, 'turn'], 32);
    const expectedEntrySpanId = spanId([SESSION_ID, turnId, 'entry', '1']);
    const expectedAgentSpanId = spanId([SESSION_ID, turnId, 'agent', '1']);
    const expectedStep1SpanId = spanId([SESSION_ID, turnId, 'step', '1']);
    const expectedStep2SpanId = spanId([SESSION_ID, turnId, 'step', '2']);
    const expectedLlm1SpanId = spanId([SESSION_ID, turnId, 'llm', '1']);
    const expectedLlm2SpanId = spanId([SESSION_ID, turnId, 'llm', '2']);
    const expectedToolSpanId = spanId([
      SESSION_ID,
      turnId,
      'tool',
      'toolu_fixture_001',
    ]);

    expect(entries.every(entry => entry.trace_id === expectedTraceId)).toBe(true);
    expect(entries.every(entry => entry['agent.droid.entry.span_id'] === expectedEntrySpanId))
      .toBe(true);
    expect(entries.every(entry => entry['agent.droid.agent.span_id'] === expectedAgentSpanId))
      .toBe(true);
    expect(prompt.span_id).toBe(expectedAgentSpanId);
    expect(prompt.parent_span_id).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(responses).toHaveLength(2);
    expect(requests.map(entry => entry['gen_ai.step.id'])).toEqual(responses.map(
      entry => entry['gen_ai.step.id'],
    ));
    expect(requests.map(entry => entry.span_id)).toEqual(responses.map(entry => entry.span_id));
    expect(requests.map(entry => entry.span_id)).toEqual([
      expectedLlm1SpanId,
      expectedLlm2SpanId,
    ]);
    expect(requests.map(entry => entry.parent_span_id)).toEqual(responses.map(
      entry => entry.parent_span_id,
    ));
    expect(requests.map(entry => entry.parent_span_id)).toEqual([
      expectedStep1SpanId,
      expectedStep2SpanId,
    ]);
    expect(requests.map(entry => entry['agent.droid.step.span_id'])).toEqual([
      expectedStep1SpanId,
      expectedStep2SpanId,
    ]);
    expect(toolCall.span_id).toBe(toolResult.span_id);
    expect(toolCall.span_id).toBe(expectedToolSpanId);
    expect(toolCall.parent_span_id).toBe(expectedStep1SpanId);
    expect(toolCall['gen_ai.step.id']).toBe(requests[0]['gen_ai.step.id']);
    expect(requests[0]['gen_ai.turn.start']).toBe(true);
    expect(responses[0]['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
    expect(responses[0]['gen_ai.turn.end']).toBeUndefined();
    expect(responses[1]['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(responses[1]['gen_ai.turn.end']).toBe(true);

    expect(requests.map(entry => entry['gen_ai.request.model'])).toEqual([
      'claude-opus-4-7',
      'claude-opus-4-7',
    ]);
    expect(responses.map(entry => entry['gen_ai.response.model'])).toEqual([
      'claude-opus-4-7',
      'claude-opus-4-7',
    ]);
    expect(responses.map(entry => entry['gen_ai.provider.name'])).toEqual([
      'aws.bedrock',
      'aws.bedrock',
    ]);
    expect(responses.map(entry => entry['agent.droid.api_provider'])).toEqual([
      'bedrock_anthropic',
      'bedrock_anthropic',
    ]);

    expect(toolCall).toMatchObject({
      time_unix_nano: '1787143295621000000',
      'gen_ai.tool.name': 'Execute',
      'gen_ai.tool.call.id': 'toolu_fixture_001',
      'gen_ai.tool.call.arguments': {
        command: 'pwd',
        summary: 'Print the current directory',
      },
    });
    expect(toolResult).toMatchObject({
      time_unix_nano: '1787143295738000000',
      'gen_ai.tool.name': 'Execute',
      'gen_ai.tool.call.id': 'toolu_fixture_001',
      'gen_ai.tool.call.duration': 117,
      'tool.result.status': 'success',
    });
    expect(String(toolResult['gen_ai.tool.call.result'])).toContain('/workspace/droid-fixture');

    const serialized = JSON.stringify(entries);
    expect(serialized).toContain('Run pwd once and report the working directory.');
    expect(serialized).toContain('The current directory is /workspace/droid-fixture.');
    expect(serialized).not.toContain('INTERNAL_CONTEXT_MUST_NOT_BE_REPORTED');
    expect(serialized).not.toContain('fixture-user');
    expect(serialized).not.toContain('SessionStart');
    expect(serialized).not.toContain('SessionEnd');

    expect((requests[1]['gen_ai.input.messages_delta'] as any[]).map(message => message.role))
      .toEqual(['assistant', 'tool']);
    const toolResponse = (requests[1]['gen_ai.input.messages_delta'] as any[])
      .find(message => message.role === 'tool').parts[0];
    expect(toolResponse).toMatchObject({
      type: 'tool_call_response',
      id: 'toolu_fixture_001',
    });
    expect(toolResponse).toHaveProperty('response');
    expect(toolResponse).not.toHaveProperty('result');
  });

  it('joins exact per-call usage, TTFT, response IDs, and model-call timestamps from Droid logs', async () => {
    const { records, settings, observations } = await goldenInputs();
    const { entries, finalUsage } = await buildDroidEvents(records, {
      sessionId: SESSION_ID,
      settings,
      observations,
    });
    const requests = entries.filter(entry => entry['event.name'] === 'llm.request');
    const responses = entries.filter(entry => entry['event.name'] === 'llm.response');

    expect(requests.map(entry => entry.time_unix_nano)).toEqual([
      '1787143291959000000',
      '1787143295783000000',
    ]);
    expect(responses.map(entry => entry['gen_ai.response.id'])).toEqual([
      '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000102',
    ]);
    expect(responses.map(entry => ({
      input: entry['gen_ai.usage.input_tokens'],
      output: entry['gen_ai.usage.output_tokens'],
      total: entry['gen_ai.usage.total_tokens'],
      cacheRead: entry['gen_ai.usage.cache_read.input_tokens'],
      cacheCreation: entry['gen_ai.usage.cache_creation.input_tokens'],
      reasoning: entry['gen_ai.usage.reasoning_tokens'],
      ttft: entry['gen_ai.response.time_to_first_token'],
      completeness: entry['agent.droid.usage.completeness'],
    }))).toEqual([
      {
        input: 20196,
        output: 162,
        total: 20358,
        cacheRead: 20190,
        cacheCreation: 0,
        reasoning: 0,
        ttft: 2_867_000_000,
        completeness: 'per_call',
      },
      {
        input: 20405,
        output: 41,
        total: 20446,
        cacheRead: 20190,
        cacheCreation: 214,
        reasoning: 0,
        ttft: 2_198_000_000,
        completeness: 'per_call',
      },
    ]);
    expect(finalUsage).toEqual({
      inputTokens: 40601,
      outputTokens: 203,
      totalTokens: 40804,
      cacheReadTokens: 40380,
      cacheCreationTokens: 214,
      reasoningTokens: 0,
    });
  });

  it('converts the reserved topology into the exact ENTRY -> AGENT -> STEP -> LLM/TOOL tree', async () => {
    const { records, settings, observations } = await goldenInputs();
    const firstBuild = await buildDroidEvents(records, {
      sessionId: SESSION_ID,
      settings,
      observations,
    });
    const secondBuild = await buildDroidEvents(records, {
      sessionId: SESSION_ID,
      settings,
      observations,
    });
    const entries = firstBuild.entries;
    const turnId = String(entries[0]['gen_ai.turn.id']);
    const expected = {
      trace: spanId([SESSION_ID, USER_MESSAGE_ID, 'turn'], 32),
      entry: spanId([SESSION_ID, turnId, 'entry', '1']),
      agent: spanId([SESSION_ID, turnId, 'agent', '1']),
      step1: spanId([SESSION_ID, turnId, 'step', '1']),
      step2: spanId([SESSION_ID, turnId, 'step', '2']),
      llm1: spanId([SESSION_ID, turnId, 'llm', '1']),
      llm2: spanId([SESSION_ID, turnId, 'llm', '2']),
      tool: spanId([SESSION_ID, turnId, 'tool', 'toolu_fixture_001']),
    };
    const converted = await convertWithPilot(entries);
    const convertedAgain = await convertWithPilot(secondBuild.entries);
    expect(converted).toHaveLength(7);
    expect(new Set(converted.map(span => span.spanContext().traceId)))
        .toEqual(new Set([expected.trace]));

    const byKind = (kind: string) => converted.filter(
      span => span.attributes['gen_ai.span.kind'] === kind,
    );
    const entry = byKind('ENTRY')[0];
    const agent = byKind('AGENT')[0];
    const steps = byKind('STEP');
    const llms = byKind('LLM');
    const tools = byKind('TOOL');
    expect({
      ENTRY: byKind('ENTRY').length,
      AGENT: byKind('AGENT').length,
      STEP: steps.length,
      LLM: llms.length,
      TOOL: tools.length,
    }).toEqual({ ENTRY: 1, AGENT: 1, STEP: 2, LLM: 2, TOOL: 1 });

    expect(entry.spanContext().spanId).toBe(expected.entry);
    expect(agent.spanContext().spanId).toBe(expected.agent);
    expect(new Set(steps.map(span => span.spanContext().spanId))).toEqual(new Set([
      expected.step1,
      expected.step2,
    ]));
    expect(new Set(llms.map(span => span.spanContext().spanId))).toEqual(new Set([
      expected.llm1,
      expected.llm2,
    ]));
    expect(tools[0].spanContext().spanId).toBe(expected.tool);

    expect(agent.parentSpanId).toBe(expected.entry);
    expect(steps.every(span => span.parentSpanId === expected.agent)).toBe(true);
    const llmBySpanId = new Map(llms.map(span => [span.spanContext().spanId, span]));
    expect(llmBySpanId.get(expected.llm1)?.parentSpanId).toBe(expected.step1);
    expect(llmBySpanId.get(expected.llm2)?.parentSpanId).toBe(expected.step2);
    expect(tools[0].parentSpanId).toBe(expected.step1);

    const firstIds = converted.map(span => span.spanContext().spanId).sort();
    const secondIds = convertedAgain.map(span => span.spanContext().spanId).sort();
    expect(secondIds).toEqual(firstIds);
  });

  it('keeps every turn hierarchy deterministic in one strict live batch and replay', async () => {
    const sessionId = '77777777-7777-4777-8777-777777777777';
    const records: DroidRecord[] = [
      { type: 'session_start', id: sessionId, version: 2 },
      ...['alpha', 'beta'].flatMap((suffix, index): DroidRecord[] => {
        const startedAt = 1_800_000_100_000 + index * 1_000;
        const turnId = `multi-turn-${suffix}`;
        return [{
          type: 'message',
          id: turnId,
          timestamp: startedAt,
          message: { role: 'user', content: [{ type: 'text', text: suffix }] },
        }, {
          type: 'message',
          id: `${turnId}-response`,
          timestamp: startedAt + 100,
          message: {
            role: 'assistant',
            modelId: 'fixture-model',
            content: [{ type: 'text', text: `answer-${suffix}` }],
          },
        }, {
          type: 'message',
          id: `${turnId}-stop`,
          timestamp: startedAt + 120,
          message: {
            role: 'user',
            visibility: 'user_only',
            hookEventName: 'Stop',
            content: [],
          },
        }];
      }),
    ];
    const { entries } = await buildDroidEvents(records, { sessionId });

    const firstLive = await convertStrictWithPilot(entries);
    const retriedLive = await convertStrictWithPilot(entries);
    const replay = (await Promise.all(['multi-turn-alpha', 'multi-turn-beta'].map(turnId =>
      convertWithPilot(entries.filter(entry => entry['gen_ai.turn.id'] === turnId)))))
      .flat();
    const identity = (spans: ReadableSpan[]) => spans
      .map(span => `${span.spanContext().traceId}:${span.spanContext().spanId}`)
      .sort();

    expect(identity(retriedLive)).toEqual(identity(firstLive));
    expect(identity(replay)).toEqual(identity(firstLive));
    for (const turnId of ['multi-turn-alpha', 'multi-turn-beta']) {
      const traceId = spanId([sessionId, turnId, 'turn'], 32);
      const turnSpanIds = new Set(firstLive
        .filter(span => span.spanContext().traceId === traceId)
        .map(span => span.spanContext().spanId));
      expect(turnSpanIds).toEqual(new Set([
        spanId([sessionId, turnId, 'entry', '1']),
        spanId([sessionId, turnId, 'agent', '1']),
        spanId([sessionId, turnId, 'step', '1']),
        spanId([sessionId, turnId, 'llm', '1']),
      ]));
    }
  });

  it('does not fabricate per-call token usage when only the final settings aggregate exists', async () => {
    const { records, settings } = await goldenInputs();
    const { entries, finalUsage } = await buildDroidEvents(records, {
      sessionId: SESSION_ID,
      settings,
    });
    const responses = entries.filter(entry => entry['event.name'] === 'llm.response');

    expect(responses).toHaveLength(2);
    for (const response of responses) {
      expect(response['gen_ai.usage.input_tokens']).toBeUndefined();
      expect(response['gen_ai.usage.output_tokens']).toBeUndefined();
      expect(response['gen_ai.usage.total_tokens']).toBeUndefined();
      expect(response['gen_ai.response.time_to_first_token']).toBeUndefined();
    }
    expect(responses.map(response => response['agent.droid.usage.completeness']))
      .toEqual(['missing', 'session_aggregate']);
    expect(responses[1]).toMatchObject({
      'agent.droid.session.usage.input_tokens': 40601,
      'agent.droid.session.usage.output_tokens': 203,
      'agent.droid.session.usage.total_tokens': 40804,
    });
    expect(finalUsage).toEqual({
      inputTokens: 40601,
      outputTokens: 203,
      totalTokens: 40804,
      cacheReadTokens: 40380,
      cacheCreationTokens: 214,
      reasoningTokens: 0,
    });
  });

  it('exposes a new single-call settings aggregate as canonical usage without claiming per-call precision', async () => {
    const sessionId = '12121212-3434-4567-8899-121212121212';
    const turnId = 'single-call-new-session';
    const { entries, finalUsage } = await buildDroidEvents([{
      type: 'session_start',
      id: sessionId,
      version: 2,
    }, {
      type: 'message',
      id: turnId,
      timestamp: 1_800_000_040_000,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Return one short response.' }],
      },
    }, {
      type: 'message',
      id: 'single-call-new-session-response',
      timestamp: 1_800_000_040_100,
      message: {
        role: 'assistant',
        modelId: 'fixture-model',
        content: [{ type: 'text', text: 'Done.' }],
      },
    }, {
      type: 'message',
      id: 'single-call-new-session-stop',
      timestamp: 1_800_000_040_120,
      message: {
        role: 'user',
        visibility: 'user_only',
        hookEventName: 'Stop',
        hookEndTime: 1_800_000_040_120,
        content: [],
      },
    }], {
      sessionId,
      settingsUsageScope: 'complete_transcript',
      settings: {
        tokenUsage: {
          inputTokens: 32_321,
          outputTokens: 7,
          cacheReadTokens: 768,
          cacheCreationTokens: 0,
          thinkingTokens: 0,
        },
      },
    });
    const responses = entries.filter(entry => entry['event.name'] === 'llm.response');

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      'agent.droid.usage.completeness': 'session_aggregate',
      'gen_ai.usage.input_tokens': 33_089,
      'gen_ai.usage.output_tokens': 7,
      'gen_ai.usage.total_tokens': 33_096,
      'gen_ai.usage.cache_read.input_tokens': 768,
      'gen_ai.usage.cache_creation.input_tokens': 0,
      'gen_ai.usage.reasoning_tokens': 0,
      'agent.droid.session.usage.input_tokens': 33_089,
      'agent.droid.session.usage.output_tokens': 7,
      'agent.droid.session.usage.total_tokens': 33_096,
    });
    expect(responses[0]['agent.droid.response.synthetic']).toBeUndefined();
    expect(finalUsage).toEqual({
      inputTokens: 33_089,
      outputTokens: 7,
      totalTokens: 33_096,
      cacheReadTokens: 768,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    });

    const spans = await convertWithPilot(entries);
    const llm = spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM')!;
    expect(llm.attributes).toMatchObject({
      'agent.droid.usage.completeness': 'session_aggregate',
      'gen_ai.usage.input_tokens': 33_089,
      'gen_ai.usage.output_tokens': 7,
      'gen_ai.usage.total_tokens': 33_096,
    });
  });

  it('keeps a full-session settings total diagnostic for a single-call incremental segment', async () => {
    const sessionId = '13131313-3434-4567-8899-131313131313';
    const turnId = 'single-call-after-unknown-baseline';
    const { entries, finalUsage } = await buildDroidEvents([{
      type: 'session_start',
      id: sessionId,
      version: 2,
    }, {
      type: 'message',
      id: turnId,
      timestamp: 1_800_000_041_000,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'One call after an unmetered baseline.' }],
      },
    }, {
      type: 'message',
      id: 'single-call-after-unknown-baseline-response',
      timestamp: 1_800_000_041_100,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
      },
    }, {
      type: 'message',
      id: 'single-call-after-unknown-baseline-stop',
      timestamp: 1_800_000_041_120,
      message: {
        role: 'user',
        visibility: 'user_only',
        hookEventName: 'Stop',
        hookEndTime: 1_800_000_041_120,
        content: [],
      },
    }], {
      sessionId,
      settingsUsageScope: 'session_aggregate',
      settings: {
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 9,
          cacheReadTokens: 20,
          cacheCreationTokens: 3,
        },
      },
    });
    const response = entries.find(entry => entry['event.name'] === 'llm.response')!;

    expect(response).toMatchObject({
      'agent.droid.usage.completeness': 'session_aggregate',
      'agent.droid.session.usage.input_tokens': 123,
      'agent.droid.session.usage.output_tokens': 9,
      'agent.droid.session.usage.total_tokens': 132,
    });
    expect(response['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(response['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(response['gen_ai.usage.total_tokens']).toBeUndefined();
    expect(finalUsage).toMatchObject({
      inputTokens: 123,
      outputTokens: 9,
      totalTokens: 132,
    });
  });

  it('does not treat one visible response as the only session LLM when an llm-only response exists', async () => {
    const sessionId = '14141414-3434-4567-8899-141414141414';
    const { entries } = await buildDroidEvents([{
      type: 'session_start',
      id: sessionId,
      version: 2,
    }, {
      type: 'message',
      id: 'visible-prompt-with-internal-call',
      timestamp: 1_800_000_042_000,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'One visible response.' }],
      },
    }, {
      type: 'message',
      id: 'internal-llm-only-response',
      timestamp: 1_800_000_042_050,
      message: {
        role: 'assistant',
        visibility: 'llm_only',
        content: [{ type: 'text', text: 'Internal model output.' }],
      },
    }, {
      type: 'message',
      id: 'visible-response-after-internal-call',
      timestamp: 1_800_000_042_100,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Visible output.' }],
      },
    }, {
      type: 'message',
      id: 'visible-response-stop',
      timestamp: 1_800_000_042_120,
      message: {
        role: 'user',
        visibility: 'user_only',
        hookEventName: 'Stop',
        hookEndTime: 1_800_000_042_120,
        content: [],
      },
    }], {
      sessionId,
      settingsUsageScope: 'complete_transcript',
      settings: { tokenUsage: { inputTokens: 100, outputTokens: 9 } },
    });
    const response = entries.find(entry => entry['event.name'] === 'llm.response')!;

    expect(response['agent.droid.usage.completeness']).toBe('session_aggregate');
    expect(response['agent.droid.session.usage.total_tokens']).toBe(109);
    expect(response['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(response['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(response['gen_ai.usage.total_tokens']).toBeUndefined();
  });

  it('does not attribute an incremental settings delta to one visible response when an llm-only response exists', async () => {
    const sessionId = '15151515-3434-4567-8899-151515151515';
    const { entries } = await buildDroidEvents([{
      type: 'session_start',
      id: sessionId,
      version: 2,
    }, {
      type: 'message',
      id: 'incremental-visible-prompt-with-internal-call',
      timestamp: 1_800_000_043_000,
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'One visible response after the baseline.' }],
      },
    }, {
      type: 'message',
      id: 'incremental-internal-llm-only-response',
      timestamp: 1_800_000_043_050,
      message: {
        role: 'assistant',
        visibility: 'llm_only',
        content: [{ type: 'text', text: 'Internal model output.' }],
      },
    }, {
      type: 'message',
      id: 'incremental-visible-response-after-internal-call',
      timestamp: 1_800_000_043_100,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Visible output.' }],
      },
    }, {
      type: 'message',
      id: 'incremental-visible-response-stop',
      timestamp: 1_800_000_043_120,
      message: {
        role: 'user',
        visibility: 'user_only',
        hookEventName: 'Stop',
        hookEndTime: 1_800_000_043_120,
        content: [],
      },
    }], {
      sessionId,
      settingsUsageScope: 'session_aggregate',
      initialUsage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
      settings: { tokenUsage: { inputTokens: 100, outputTokens: 9 } },
    });
    const response = entries.find(entry => entry['event.name'] === 'llm.response')!;

    expect(response).toMatchObject({
      'agent.droid.usage.completeness': 'turn_aggregate',
      'agent.droid.turn.usage.input_tokens': 90,
      'agent.droid.turn.usage.output_tokens': 7,
      'agent.droid.turn.usage.total_tokens': 97,
    });
    expect(response['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(response['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(response['gen_ai.usage.total_tokens']).toBeUndefined();
  });

  it('carries settings aggregate diagnostics to LLM and AGENT spans without fabricating standard usage', async () => {
    const { records, settings } = await goldenInputs();
    const { entries } = await buildDroidEvents(records, {
      sessionId: SESSION_ID,
      settings,
    });

    const spans = await convertWithPilot(entries);
    const llms = spans
      .filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')
      .sort((left, right) => String(left.attributes['gen_ai.response.id'])
        .localeCompare(String(right.attributes['gen_ai.response.id'])));
    const agent = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT')!;

    expect(llms).toHaveLength(2);
    expect(llms.map(span => span.attributes['agent.droid.usage.completeness']))
      .toEqual(['missing', 'session_aggregate']);
    expect(llms[0].attributes).not.toHaveProperty('agent.droid.session.usage.input_tokens');
    expect(llms[1].attributes).toMatchObject({
      'agent.droid.session.usage.input_tokens': 40601,
      'agent.droid.session.usage.output_tokens': 203,
      'agent.droid.session.usage.total_tokens': 40804,
      'agent.droid.session.usage.cache_read_tokens': 40380,
      'agent.droid.session.usage.cache_creation_tokens': 214,
      'agent.droid.session.usage.reasoning_tokens': 0,
    });
    expect(agent.attributes).toMatchObject({
      'agent.droid.usage.completeness': 'session_aggregate',
      'agent.droid.session.usage.input_tokens': 40601,
      'agent.droid.session.usage.output_tokens': 203,
      'agent.droid.session.usage.total_tokens': 40804,
    });
    for (const span of [...llms, agent]) {
      expect(span.attributes).not.toHaveProperty('gen_ai.usage.input_tokens');
      expect(span.attributes).not.toHaveProperty('gen_ai.usage.output_tokens');
      expect(span.attributes).not.toHaveProperty('gen_ai.usage.total_tokens');
    }
  });

  it('marks a multi-call settings delta as a turn aggregate instead of assigning it to one call', async () => {
    const { records, settings } = await goldenInputs();
    const { entries } = await buildDroidEvents(records, {
      sessionId: SESSION_ID,
      settings,
      initialUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      },
    });
    const responses = entries.filter(entry => entry['event.name'] === 'llm.response');

    expect(responses.map(response => response['agent.droid.usage.completeness']))
      .toEqual(['missing', 'turn_aggregate']);
    expect(responses[1]).toMatchObject({
      'agent.droid.turn.usage.input_tokens': 40601,
      'agent.droid.turn.usage.output_tokens': 203,
      'agent.droid.turn.usage.total_tokens': 40804,
    });
    expect(responses.every(response => response['gen_ai.usage.input_tokens'] === undefined))
      .toBe(true);

    const spans = await convertWithPilot(entries);
    const aggregateLlm = spans.find(span =>
      span.attributes['gen_ai.span.kind'] === 'LLM'
      && span.attributes['agent.droid.usage.completeness'] === 'turn_aggregate')!;
    const agent = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT')!;
    for (const span of [aggregateLlm, agent]) {
      expect(span.attributes).toMatchObject({
        'agent.droid.usage.completeness': 'turn_aggregate',
        'agent.droid.turn.usage.input_tokens': 40601,
        'agent.droid.turn.usage.output_tokens': 203,
        'agent.droid.turn.usage.total_tokens': 40804,
      });
      expect(span.attributes).not.toHaveProperty('gen_ai.usage.input_tokens');
      expect(span.attributes).not.toHaveProperty('gen_ai.usage.output_tokens');
      expect(span.attributes).not.toHaveProperty('gen_ai.usage.total_tokens');
    }
  });

  it('does not label a settings delta spanning distinct turns as one turn aggregate', async () => {
    const sessionId = '33333333-4444-4555-8666-777777777777';
    const records: DroidRecord[] = [{ type: 'session_start', id: sessionId }];
    for (const [index, turnId] of ['aggregate-turn-one', 'aggregate-turn-two'].entries()) {
      const timestamp = 1_800_000_090_000 + index * 1_000;
      records.push({
        type: 'message',
        id: turnId,
        timestamp,
        message: { role: 'user', content: [{ type: 'text', text: turnId }] },
      }, {
        type: 'message',
        id: `${turnId}-response`,
        timestamp: timestamp + 100,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `answer-${turnId}` }],
        },
      }, {
        type: 'message',
        id: `${turnId}-stop`,
        timestamp: timestamp + 120,
        message: {
          role: 'user',
          visibility: 'user_only',
          hookEventName: 'Stop',
          content: [],
        },
      });
    }

    const result = await buildDroidEvents(records, {
      sessionId,
      settings: { tokenUsage: { inputTokens: 20, outputTokens: 5 } },
      initialUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    const responses = result.entries.filter(entry => entry['event.name'] === 'llm.response');

    expect(responses.map(entry => entry['agent.droid.usage.completeness']))
      .toEqual(['missing', 'missing']);
    expect(responses.every(entry =>
      entry['agent.droid.turn.usage.input_tokens'] === undefined)).toBe(true);
    expect(result.finalUsage).toMatchObject({
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
    });
  });

  it('uses a settings delta as canonical usage when the turn contains exactly one LLM call', async () => {
    const { records, settings } = await goldenInputs();
    const singleCallRecords = records.filter(record =>
      record.type === 'session_start'
      || record.id === USER_MESSAGE_ID
      || record.id === '00000000-0000-4000-8000-000000000008'
      || record.id === '00000000-0000-4000-8000-000000000009');
    const { entries } = await buildDroidEvents(singleCallRecords, {
      sessionId: SESSION_ID,
      settings,
      initialUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      },
    });
    const response = entries.find(entry => entry['event.name'] === 'llm.response')!;

    expect(response).toMatchObject({
      'agent.droid.usage.completeness': 'single_call_delta',
      'gen_ai.usage.input_tokens': 40601,
      'gen_ai.usage.output_tokens': 203,
      'gen_ai.usage.total_tokens': 40804,
      'gen_ai.usage.cache_read.input_tokens': 40380,
      'gen_ai.usage.cache_creation.input_tokens': 214,
      'gen_ai.usage.reasoning_tokens': 0,
    });
    expect(response['agent.droid.turn.usage.input_tokens']).toBeUndefined();
  });

  it('only advances cumulative usage from observations when an absolute baseline is known', async () => {
    const { records, observations } = await goldenInputs();
    const initialUsage = {
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 80,
      cacheCreationTokens: 15,
      reasoningTokens: 5,
    };

    const withBaseline = await buildDroidEvents(records, {
      sessionId: SESSION_ID,
      observations,
      initialUsage,
    });
    expect(withBaseline.finalUsage).toEqual({
      inputTokens: 40_701,
      outputTokens: 213,
      totalTokens: 40_914,
      cacheReadTokens: 40_460,
      cacheCreationTokens: 229,
      reasoningTokens: 5,
    });

    const withoutBaseline = await buildDroidEvents(records, {
      sessionId: SESSION_ID,
      observations,
    });
    expect(withoutBaseline.finalUsage).toBeUndefined();
    expect(withoutBaseline.entries
      .filter(entry => entry['event.name'] === 'llm.response')
      .map(entry => entry['agent.droid.usage.completeness']))
      .toEqual(['per_call', 'per_call']);
  });

  it('advances a stale settings checkpoint with exact per-call observations', async () => {
    const { records, observations } = await goldenInputs();
    const initialUsage = {
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 80,
      cacheCreationTokens: 15,
      reasoningTokens: 5,
    };
    const staleSettings = {
      tokenUsage: {
        inputTokens: 5,
        outputTokens: 10,
        cacheReadTokens: 80,
        cacheCreationTokens: 15,
        thinkingTokens: 5,
      },
    };

    const result = await buildDroidEvents(records, {
      sessionId: SESSION_ID,
      settings: staleSettings,
      observations,
      initialUsage,
    });

    expect(result.finalUsage).toEqual({
      inputTokens: 40_701,
      outputTokens: 213,
      totalTokens: 40_914,
      cacheReadTokens: 40_460,
      cacheCreationTokens: 229,
      reasoningTokens: 5,
    });
    expect(result.entries
      .filter(entry => entry['event.name'] === 'llm.response')
      .map(entry => entry['agent.droid.usage.completeness']))
      .toEqual(['per_call', 'per_call']);
  });

  it('synthesizes a cancelled LLM boundary when Stop arrives before any assistant record', async () => {
    const sessionId = '44444444-5555-4666-8777-888888888888';
    const turnId = 'prompt-cancelled-before-response';
    const { entries } = await buildDroidEvents([
      { type: 'session_start', id: sessionId },
      {
        type: 'message',
        id: turnId,
        timestamp: 1_800_000_015_000,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Cancel before the assistant responds.' }],
        },
      },
      {
        type: 'message',
        id: 'stop-before-response',
        timestamp: 1_800_000_015_050,
        message: {
          role: 'user',
          visibility: 'user_only',
          content: [],
          hookEventName: 'Stop',
          hookEndTime: 1_800_000_015_050,
        },
      },
    ], { sessionId });

    expect(entries.map(entry => entry['event.name'])).toEqual([
      'other',
      'llm.request',
      'llm.response',
    ]);
    expect(entries[1]).toMatchObject({
      'gen_ai.turn.id': turnId,
      'gen_ai.turn.start': true,
    });
    expect(entries[2]).toMatchObject({
      'gen_ai.turn.id': turnId,
      'gen_ai.response.finish_reasons': ['cancelled'],
      'gen_ai.turn.end': true,
      'agent.droid.usage.completeness': 'missing',
      'agent.droid.response.synthetic': 'cancelled_boundary',
    });
    expect(entries[2]['gen_ai.output.messages']).toBeUndefined();
    expect(entries[1].span_id).toBe(entries[2].span_id);
    expect(entries[1].parent_span_id).toBe(entries[2].parent_span_id);
  });

  it('closes a prompt-only turn before beginning the next visible prompt', async () => {
    const sessionId = '44444444-5555-4666-8777-999999999999';
    const firstTurnId = 'prompt-only-first-turn';
    const secondTurnId = 'prompt-only-second-turn';
    const { entries } = await buildDroidEvents([
      { type: 'session_start', id: sessionId },
      {
        type: 'message',
        id: firstTurnId,
        timestamp: 1_800_000_016_000,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'First prompt without a response.' }],
        },
      },
      {
        type: 'message',
        id: secondTurnId,
        timestamp: 1_800_000_016_100,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Second prompt replaces it.' }],
        },
      },
    ], { sessionId });

    expect(entries.map(entry => entry['event.name'])).toEqual([
      'other',
      'llm.request',
      'llm.response',
      'other',
    ]);
    expect(entries[2]).toMatchObject({
      'gen_ai.turn.id': firstTurnId,
      'gen_ai.response.finish_reasons': ['cancelled'],
      'gen_ai.turn.end': true,
      'agent.droid.response.synthetic': 'cancelled_boundary',
    });
    expect(entries[3]['gen_ai.turn.id']).toBe(secondTurnId);
  });

  it('closes an interrupted tool step as cancelled when Stop arrives before a tool result', async () => {
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const turnId = 'cancelled-tool-turn';
    const toolCallId = 'toolu_cancelled_001';
    const records: DroidRecord[] = [
      {
        type: 'session_start',
        id: sessionId,
        cwd: '/workspace/cancelled-tool',
      },
      {
        type: 'message',
        id: turnId,
        timestamp: 1_800_000_020_000,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Start a tool and then stop.' }],
        },
      },
      {
        type: 'message',
        id: 'cancelled-tool-assistant',
        parentId: turnId,
        timestamp: 1_800_000_020_100,
        message: {
          role: 'assistant',
          modelId: 'claude-opus-fixture',
          apiProvider: 'bedrock_anthropic',
          content: [{
            type: 'tool_use',
            id: toolCallId,
            name: 'Execute',
            input: { command: 'sleep 10' },
          }],
        },
      },
      {
        type: 'message',
        id: 'cancelled-tool-stop',
        timestamp: 1_800_000_020_250,
        message: {
          role: 'user',
          visibility: 'user_only',
          content: [],
          hookEventName: 'Stop',
          hookEndTime: 1_800_000_020_250,
        },
      },
    ];

    const { entries } = await buildDroidEvents(records, { sessionId });
    expect(entries.map(entry => entry['event.name'])).toEqual([
      'other',
      'llm.request',
      'llm.response',
      'tool.call',
      'tool.result',
    ]);
    const response = entries.find(entry => entry['event.name'] === 'llm.response')!;
    expect(response).toMatchObject({
      'gen_ai.response.finish_reasons': ['cancelled'],
      'gen_ai.turn.end': true,
    });
    expect(response['gen_ai.output.messages']).toEqual([{
      role: 'assistant',
      parts: [{
        type: 'tool_call',
        id: toolCallId,
        name: 'Execute',
        arguments: { command: 'sleep 10' },
      }],
      finish_reason: 'cancelled',
    }]);

    const toolCall = entries.find(entry => entry['event.name'] === 'tool.call')!;
    const toolResult = entries.find(entry => entry['event.name'] === 'tool.result')!;
    expect(toolResult).toMatchObject({
      'gen_ai.tool.call.id': toolCallId,
      'gen_ai.tool.call.duration': 150,
      'tool.result.status': 'cancelled',
    });
    expect(toolResult['gen_ai.tool.call.result']).toBeUndefined();
    expect(toolResult.span_id).toBe(toolCall.span_id);
    expect(toolResult.parent_span_id).toBe(toolCall.parent_span_id);
  });

  it('cancels an unfinished turn before starting the next visible user turn', async () => {
    const sessionId = '66666666-6666-4666-8666-666666666666';
    const firstTurnId = 'unfinished-first-turn';
    const secondTurnId = 'replacement-second-turn';
    const records: DroidRecord[] = [
      { type: 'session_start', id: sessionId },
      {
        type: 'message',
        id: firstTurnId,
        timestamp: 1_800_000_030_000,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'First prompt.' }],
        },
      },
      {
        type: 'message',
        id: 'unfinished-first-response',
        parentId: firstTurnId,
        timestamp: 1_800_000_030_100,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Partial first response.' }],
        },
      },
      {
        type: 'message',
        id: secondTurnId,
        timestamp: 1_800_000_030_200,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Second prompt.' }],
        },
      },
    ];

    const { entries } = await buildDroidEvents(records, { sessionId });
    expect(entries.map(entry => entry['event.name'])).toEqual([
      'other',
      'llm.request',
      'llm.response',
      'other',
    ]);
    const firstResponse = entries.find(entry => entry['event.name'] === 'llm.response')!;
    expect(firstResponse).toMatchObject({
      'gen_ai.turn.id': firstTurnId,
      'gen_ai.response.finish_reasons': ['cancelled'],
      'gen_ai.turn.end': true,
    });
    expect(firstResponse['gen_ai.output.messages']).toEqual([{
      role: 'assistant',
      parts: [{ type: 'text', content: 'Partial first response.' }],
      finish_reason: 'cancelled',
    }]);

    const prompts = entries.filter(entry => entry['event.name'] === 'other');
    expect(prompts.map(entry => entry['gen_ai.turn.id'])).toEqual([
      firstTurnId,
      secondTurnId,
    ]);
    expect(prompts[0].trace_id).toBe(spanId([sessionId, firstTurnId, 'turn'], 32));
    expect(prompts[1].trace_id).toBe(spanId([sessionId, secondTurnId, 'turn'], 32));
    expect(prompts[1].trace_id).not.toBe(prompts[0].trace_id);
  });

  it('bounds oversized tool arguments and results with valid truncation objects', async () => {
    const sessionId = '77777777-7777-4777-8777-777777777777';
    const turnId = 'oversized-tool-turn';
    const toolCallId = 'toolu_oversized_001';
    const oversizedArguments = 'a'.repeat(70 * 1024);
    const oversizedResult = 'r'.repeat(70 * 1024);
    const records: DroidRecord[] = [
      { type: 'session_start', id: sessionId },
      {
        type: 'message',
        id: turnId,
        timestamp: 1_800_000_040_000,
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Produce oversized tool payloads.' }],
        },
      },
      {
        type: 'message',
        id: 'oversized-tool-assistant',
        parentId: turnId,
        timestamp: 1_800_000_040_100,
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: toolCallId,
            name: 'Execute',
            input: { payload: oversizedArguments },
          }],
        },
      },
      {
        type: 'message',
        id: 'oversized-tool-result',
        parentId: 'oversized-tool-assistant',
        timestamp: 1_800_000_040_200,
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: oversizedResult,
            is_error: false,
          }],
        },
      },
    ];

    const { entries } = await buildDroidEvents(records, { sessionId });
    const toolCall = entries.find(entry => entry['event.name'] === 'tool.call')!;
    const toolResult = entries.find(entry => entry['event.name'] === 'tool.result')!;
    const argumentsValue = toolCall['gen_ai.tool.call.arguments'] as Record<string, unknown>;
    const resultValue = toolResult['gen_ai.tool.call.result'] as Record<string, unknown>;

    for (const value of [argumentsValue, resultValue]) {
      expect(value).toMatchObject({ truncated: true });
      expect(value.original_bytes).toBeGreaterThan(64 * 1024);
      expect(typeof value.preview).toBe('string');
      expect(String(value.preview)).toMatch(/\.\.\.\[truncated]$/);
      expect(Buffer.byteLength(String(value.preview), 'utf8')).toBeLessThan(9 * 1024);
      expect(() => JSON.stringify(value)).not.toThrow();
    }
    expect(JSON.stringify(entries)).not.toContain(oversizedArguments);
    expect(JSON.stringify(entries)).not.toContain(oversizedResult);
  });
});
