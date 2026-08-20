import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createDroidLogParser,
  parseDroidLogLines,
  readDroidSettings,
  readDroidTranscript,
} from '../../../src/inputs/droid/droid-parser.js';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../fixtures/droid/golden-v2/', import.meta.url),
);
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

describe('Droid parser', () => {
  it('reads the real v2 transcript envelope and sibling settings shape', async () => {
    const records = await readDroidTranscript(`${FIXTURE_DIR}/session.jsonl`);
    const settings = await readDroidSettings(`${FIXTURE_DIR}/session.settings.json`);

    expect(records).toHaveLength(11);
    expect(records[0]).toMatchObject({
      type: 'session_start',
      id: SESSION_ID,
      version: 2,
      cwd: '/workspace/droid-fixture',
    });
    expect(records.filter(record => record.message?.visibility === 'llm_only')).toHaveLength(1);
    expect(records.filter(record => record.message?.visibility === 'user_only')).toHaveLength(5);
    expect(settings).toMatchObject({
      model: 'claude-opus-4-7',
      apiProviderLock: 'bedrock_anthropic',
      tokenUsage: {
        inputTokens: 7,
        outputTokens: 203,
        cacheCreationTokens: 214,
        cacheReadTokens: 40380,
        thinkingTokens: 0,
      },
    });
  });

  it('turns Droid 0.199.0 log records into two orderable per-call observations', () => {
    const text = readFileSync(`${FIXTURE_DIR}/droid.log`, 'utf8');
    const observations = parseDroidLogLines(text);

    expect(observations).toHaveLength(2);
    expect(observations).toEqual([
      expect.objectContaining({
        sessionId: SESSION_ID,
        startedAtMs: Date.parse('2026-08-19T12:41:31.959Z'),
        completedAtMs: Date.parse('2026-08-19T12:41:35.558Z'),
        timeToFirstTokenNs: 2_867_000_000,
        modelId: 'claude-opus-4-7',
        apiProvider: 'bedrock_anthropic',
        logVersion: '0.199.0',
        responseId: '00000000-0000-4000-8000-000000000101',
        finishReason: 'tool_call',
        usage: {
          inputTokens: 20196,
          outputTokens: 162,
          totalTokens: 20358,
          cacheReadTokens: 20190,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        },
      }),
      expect.objectContaining({
        sessionId: SESSION_ID,
        startedAtMs: Date.parse('2026-08-19T12:41:35.783Z'),
        completedAtMs: Date.parse('2026-08-19T12:41:38.363Z'),
        timeToFirstTokenNs: 2_198_000_000,
        modelId: 'claude-opus-4-7',
        apiProvider: 'bedrock_anthropic',
        logVersion: '0.199.0',
        responseId: '00000000-0000-4000-8000-000000000102',
        finishReason: 'stop',
        usage: {
          inputTokens: 20405,
          outputTokens: 41,
          totalTokens: 20446,
          cacheReadTokens: 20190,
          cacheCreationTokens: 214,
          reasoningTokens: 0,
        },
      }),
    ]);

    expect(observations.reduce((sum, item) => sum + item.usage.inputTokens, 0)).toBe(40601);
    expect(observations.reduce((sum, item) => sum + item.usage.outputTokens, 0)).toBe(203);
    expect(observations.reduce((sum, item) => sum + item.usage.totalTokens, 0)).toBe(40804);
  });

  it('accepts the verified Droid 0.200.0 log schema with identical semantics', () => {
    const text = readFileSync(`${FIXTURE_DIR}/droid.log`, 'utf8')
      .replaceAll('0.199.0', '0.200.0');
    const observations = parseDroidLogLines(text);

    expect(observations).toHaveLength(2);
    expect(observations.every(item => item.logVersion === '0.200.0')).toBe(true);
    expect(observations.map(item => ({
      inputTokens: item.usage.inputTokens,
      outputTokens: item.usage.outputTokens,
      totalTokens: item.usage.totalTokens,
      timeToFirstTokenNs: item.timeToFirstTokenNs,
    }))).toEqual([
      {
        inputTokens: 20196,
        outputTokens: 162,
        totalTokens: 20358,
        timeToFirstTokenNs: 2_867_000_000,
      },
      {
        inputTokens: 20405,
        outputTokens: 41,
        totalTokens: 20446,
        timeToFirstTokenNs: 2_198_000_000,
      },
    ]);
  });

  it('deduplicates rotated-log overlap and ignores malformed unrelated lines', () => {
    const text = readFileSync(`${FIXTURE_DIR}/droid.log`, 'utf8');
    const observations = parseDroidLogLines(`${text}\nnot a log line\n${text}`);

    expect(observations).toHaveLength(2);
    expect(observations.map(item => item.responseId)).toEqual([
      '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000102',
    ]);
  });

  it('incrementally joins calls across rotated-file boundaries and filters sessions', () => {
    const lines = readFileSync(`${FIXTURE_DIR}/droid.log`, 'utf8')
      .trim()
      .split(/\r?\n/);
    const parser = createDroidLogParser({ sessionIds: [SESSION_ID] });

    for (const line of lines.slice(0, 2)) parser.pushLine(line);
    for (const line of lines.slice(2, 4)) {
      parser.pushLine(line.replaceAll(SESSION_ID, '99999999-9999-4999-8999-999999999999'));
      parser.pushLine(line);
    }
    for (const line of lines.slice(4)) parser.pushLine(line);
    // A fully overlapped rotation must not poison the next unique call.
    for (const line of lines) parser.pushLine(line);
    for (const line of lines.slice(4)) {
      parser.pushLine(line
        .replace('12:41:35.783', '12:41:45.783')
        .replace('12:41:37.981', '12:41:47.981')
        .replace('12:41:38.361', '12:41:48.361')
        .replace('12:41:38.363', '12:41:48.363')
        .replace('00000000-0000-4000-8000-000000000102',
          '00000000-0000-4000-8000-000000000103'));
    }

    expect(parser.finish().map(item => item.responseId)).toEqual([
      '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000102',
      '00000000-0000-4000-8000-000000000103',
    ]);
  });

  it('keeps a truncated session in resync across files until its next new sendMessage', () => {
    const lines = readFileSync(`${FIXTURE_DIR}/droid.log`, 'utf8')
      .trim()
      .split(/\r?\n/);
    const parser = createDroidLogParser({ sessionIds: [SESSION_ID] });

    parser.beginSegment({ truncated: true });
    parser.pushLine(lines[3]);
    parser.beginSegment({ truncated: false });
    parser.pushLine(lines[3]);
    for (const line of lines.slice(4)) parser.pushLine(line);

    expect(parser.finish().map(item => item.responseId)).toEqual([
      '00000000-0000-4000-8000-000000000102',
    ]);
  });

  it('fails closed for unverified Droid log schemas instead of misreporting token usage', () => {
    const text = readFileSync(`${FIXTURE_DIR}/droid.log`, 'utf8');

    expect(parseDroidLogLines(text.replaceAll('0.199.0', '0.201.0'))).toEqual([]);
  });

  it('fails closed when a Streaming result has no unique pending sendMessage', () => {
    const lines = readFileSync(`${FIXTURE_DIR}/droid.log`, 'utf8')
      .trim()
      .split(/\r?\n/);

    expect(parseDroidLogLines(lines[3])).toEqual([]);
    expect(parseDroidLogLines([
      lines[0],
      lines[4],
      lines[7],
      lines[3],
    ].join('\n'))).toEqual([]);
  });

  it('joins interleaved calls by model without guessing between same-model calls', () => {
    const lines = readFileSync(`${FIXTURE_DIR}/droid.log`, 'utf8')
      .trim()
      .split(/\r?\n/);
    const rootModel = 'glm-5.2-fast';
    const titleModel = 'claude-haiku-4-5';
    const forModel = (line: string, model: string) =>
      line.replaceAll('claude-opus-4-7', model);
    const at = (line: string, from: string, to: string) => line.replace(from, to);
    const titleResponseId = '00000000-0000-4000-8000-000000000201';
    const rootResponseId = '00000000-0000-4000-8000-000000000202';

    const observations = parseDroidLogLines([
      forModel(lines[0], rootModel),
      at(forModel(lines[0], titleModel), '12:41:31.959', '12:41:32.059'),
      at(forModel(lines[1], titleModel), '12:41:34.827', '12:41:33.000')
        .replace('"value":2.867', '"value":0.75'),
      at(forModel(lines[1], rootModel), '12:41:34.827', '12:41:33.100')
        .replace('"value":2.867', '"value":3.125'),
      at(forModel(lines[3], titleModel), '12:41:35.558', '12:41:35.000')
        .replace('00000000-0000-4000-8000-000000000101', titleResponseId),
      forModel(lines[3], rootModel)
        .replace('00000000-0000-4000-8000-000000000101', rootResponseId),
    ].join('\n'));

    expect(observations.map(item => ({
      modelId: item.modelId,
      responseId: item.responseId,
      timeToFirstTokenNs: item.timeToFirstTokenNs,
    }))).toEqual([
      {
        modelId: titleModel,
        responseId: titleResponseId,
        timeToFirstTokenNs: 750_000_000,
      },
      {
        modelId: rootModel,
        responseId: rootResponseId,
        timeToFirstTokenNs: 3_125_000_000,
      },
    ]);

    const sameModelAmbiguous = [
      forModel(lines[0], rootModel),
      at(forModel(lines[0], rootModel), '12:41:31.959', '12:41:32.059'),
      forModel(lines[3], rootModel),
    ].join('\n');
    expect(parseDroidLogLines(sameModelAmbiguous)).toEqual([]);

    const unrelatedModelSurvives = parseDroidLogLines([
      forModel(lines[0], rootModel),
      at(forModel(lines[0], rootModel), '12:41:31.959', '12:41:32.059'),
      at(forModel(lines[0], titleModel), '12:41:31.959', '12:41:32.159'),
      forModel(lines[3], rootModel),
      at(forModel(lines[3], titleModel), '12:41:35.558', '12:41:35.658')
        .replace('00000000-0000-4000-8000-000000000101', titleResponseId),
    ].join('\n'));
    expect(unrelatedModelSurvives.map(item => item.modelId)).toEqual([titleModel]);
  });
});
