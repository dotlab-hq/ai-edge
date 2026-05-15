import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import { expect, test } from 'bun:test';
import { streamOpenAIResponseAsAnthropic } from '../src/core/AnthropicOpenAIBridge';

function openAIChunk(content: string): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl_test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'upstream-model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

function finishChunk(): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl_test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'upstream-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  })}\n\ndata: [DONE]\n\n`;
}

function toolCallChunk(toolCall: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl_test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'upstream-model',
    choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: finishReason }],
  })}\n\n`;
}

test('Anthropic SSE chunks are flushed as upstream chunks arrive', async () => {
  const encoder = new TextEncoder();
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(openAIChunk('first')));
        await new Promise((resolve) => setTimeout(resolve, 250));
        controller.enqueue(encoder.encode(openAIChunk('second')));
        controller.enqueue(encoder.encode(finishChunk()));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } }
  );

  const app = new Hono();
  app.get('/stream', (c) => streamOpenAIResponseAsAnthropic(c, upstream, 'claude-test'));

  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/stream`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    let body = '';
    let firstContentAt = Number.POSITIVE_INFINITY;
    while (!body.includes('second')) {
      const next = await reader!.read();
      if (next.done) break;
      body += new TextDecoder().decode(next.value);
      if (body.includes('first') && firstContentAt === Number.POSITIVE_INFINITY) {
        firstContentAt = Date.now() - startedAt;
      }
    }

    expect(firstContentAt).toBeLessThan(200);
    expect(body).toContain('stream-start');
    expect(body).toContain('first');
    expect(body).toContain('second');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('Anthropic tool-call argument deltas stream without dropping repeated chunks', async () => {
  const encoder = new TextEncoder();
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(toolCallChunk({
          index: 0,
          id: 'call_test',
          type: 'function',
          function: { name: 'write_file', arguments: '{"text":"' },
        })));
        await new Promise((resolve) => setTimeout(resolve, 250));
        controller.enqueue(encoder.encode(toolCallChunk({
          index: 0,
          function: { arguments: 'ha' },
        })));
        controller.enqueue(encoder.encode(toolCallChunk({
          index: 0,
          function: { arguments: 'ha' },
        })));
        controller.enqueue(encoder.encode(toolCallChunk({
          index: 0,
          function: { arguments: '"}' },
        }, 'tool_calls')));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } }
  );

  const app = new Hono();
  app.get('/stream', (c) => streamOpenAIResponseAsAnthropic(c, upstream, 'claude-test'));

  const server = createAdaptorServer({ fetch: app.fetch });
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/stream`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    let body = '';
    let firstToolArgAt = Number.POSITIVE_INFINITY;
    while (!body.includes('message_stop')) {
      const next = await reader!.read();
      if (next.done) break;
      body += new TextDecoder().decode(next.value);
      if (body.includes('"partial_json":"{\\\"text\\\":\\\""') && firstToolArgAt === Number.POSITIVE_INFINITY) {
        firstToolArgAt = Date.now() - startedAt;
      }
    }

    const repeatedToolArgDeltas = body.match(/"partial_json":"ha"/g) ?? [];
    expect(firstToolArgAt).toBeLessThan(200);
    expect(body).toContain('"type":"tool_use"');
    expect(body).toContain('"type":"input_json_delta"');
    expect(repeatedToolArgDeltas.length).toBe(2);
    expect(body).toContain('"stop_reason":"tool_use"');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
