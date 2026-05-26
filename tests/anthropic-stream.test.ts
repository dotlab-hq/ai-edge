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

function openAIReasoningChunk(reasoning: string): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl_test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'upstream-model',
    choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
  })}\n\n`;
}

function openAIReasoningSignatureChunk(signature: string): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl_test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'upstream-model',
    choices: [{ index: 0, delta: { reasoning_signature: signature }, finish_reason: null }],
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

function parseAnthropicEvents(body: string): Array<{ type: string; index?: number; deltaType?: string; contentBlockType?: string }> {
  return body
    .split('\n\n')
    .filter((part) => part.includes('data: '))
    .map((part) => {
      const dataLine = part.split('\n').find((line) => line.startsWith('data: '));
      if (!dataLine) return null;
      try {
        const payload = JSON.parse(dataLine.slice(6));
        return {
          type: payload.type,
          index: payload.index,
          deltaType: payload.delta?.type,
          contentBlockType: payload.content_block?.type,
        };
      } catch {
        return null;
      }
    })
    .filter((value): value is { type: string; index?: number; deltaType?: string; contentBlockType?: string } => value !== null);
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

test('Anthropic stream keeps delta type aligned with declared block type', async () => {
  const encoder = new TextEncoder();
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(toolCallChunk({
          index: 0,
          id: 'call_text_tool',
          type: 'function',
          function: { name: 'search', arguments: '{"query":"tes' },
        })));
        controller.enqueue(encoder.encode(toolCallChunk({
          index: 0,
          function: { arguments: 't"}' },
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
    const response = await fetch(`http://127.0.0.1:${port}/stream`);
    const body = await response.text();
    const events = parseAnthropicEvents(body);

    const startedBlocks = new Map<number, string>();
    for (const event of events) {
      if (event.type === 'content_block_start' && typeof event.index === 'number' && event.contentBlockType) {
        startedBlocks.set(event.index, event.contentBlockType);
      }
      if (event.type === 'content_block_delta' && typeof event.index === 'number' && event.deltaType) {
        const blockType = startedBlocks.get(event.index);
        if (blockType === 'text') {
          expect(event.deltaType).toBe('text_delta');
        }
        if (blockType === 'tool_use' || blockType === 'server_tool_use') {
          expect(event.deltaType).toBe('input_json_delta');
        }
      }
      if (event.type === 'content_block_stop' && typeof event.index === 'number') {
        startedBlocks.delete(event.index);
      }
    }

    expect(body).toContain('"type":"tool_use"');
    expect(body).toContain('"type":"input_json_delta"');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('Anthropic reasoning streams as thinking blocks instead of think-tag text', async () => {
  const encoder = new TextEncoder();
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(openAIReasoningChunk('first thought')));
        controller.enqueue(encoder.encode(openAIReasoningChunk(' second thought')));
        controller.enqueue(encoder.encode(openAIReasoningSignatureChunk('sig-test')));
        controller.enqueue(encoder.encode(openAIChunk('final answer')));
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
    const response = await fetch(`http://127.0.0.1:${port}/stream`);
    const body = await response.text();

    expect(body).not.toContain('<think>');
    expect(body).not.toContain('</think>');
    expect(body).toContain('"content_block":{"type":"thinking","thinking":""}');
    expect(body).toContain('"type":"thinking_delta","thinking":"first thought"');
    expect(body).toContain('"type":"signature_delta","signature":"sig-test"');
    expect(body).toContain('"content_block":{"type":"text","text":""}');
    expect(body).toContain('"type":"text_delta","text":"final answer"');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('Anthropic reasoning streams a signature when upstream omits it', async () => {
  const encoder = new TextEncoder();
  const upstream = new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(openAIReasoningChunk('some thought')));
        controller.enqueue(encoder.encode(openAIChunk('final answer')));
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
    const response = await fetch(`http://127.0.0.1:${port}/stream`);
    const body = await response.text();

    expect(body).toContain('"type":"thinking_delta"');
    expect(body).toMatch(/"type":"signature_delta","signature":"[^"]+"/);
    expect(body).toContain('"type":"text_delta","text":"final answer"');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('Anthropic tool use preserves hidden google thought signature', async () => {
  const adapter = await import('../src/package/claude-adapter');
  const { convertRequestToOpenAI, convertResponseToAnthropic } = adapter as typeof import('../src/package/claude-adapter');

  const anthropicRequest = {
    model: 'claude-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'session_store_sql',
            input: { query: 'select 1' },
            _google: { thought_signature: 'ZXhhbXBsZQ==' },
          },
        ],
      },
    ],
  };

  const openaiRequest = convertRequestToOpenAI(anthropicRequest as any, 'gpt-test', 'native');
  const toolCall = openaiRequest.messages[0] as any;
  expect(toolCall.tool_calls?.[0]?.extra_content?.google?.thought_signature).toBe('ZXhhbXBsZQ==');
  expect(toolCall.tool_calls?.[0]?.thought_signature).toBeUndefined();

  const openaiResponse = {
    id: 'chatcmpl_test',
    object: 'chat.completion',
    created: 1,
    model: 'upstream-model',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'session_store_sql', arguments: '{"query":"select 1"}' },
              thought_signature: 'ZXhhbXBsZQ==',
            },
          ],
        },
      },
    ],
  };

  const anthropicResponse = convertResponseToAnthropic(openaiResponse as any, 'claude-test');
  const toolUseBlock = anthropicResponse.content.find((block: any) => block.type === 'tool_use');
  expect(toolUseBlock?._google?.thought_signature).toBe('ZXhhbXBsZQ==');
});

test('preserves Gemini native parts through thinking block for exact replay', async () => {
  const adapter = await import('../src/package/claude-adapter');
  const {
    convertRequestToOpenAI,
    convertResponseToAnthropic,
    convertRequestToGemini,
  } = adapter as typeof import('../src/package/claude-adapter');

  // Simulate a Gemini response with native contents.parts structure
  const geminiNativeParts = [
    {
      text: 'I will help you with that.',
    },
    {
      functionCall: {
        name: 'database_query',
        args: { query: 'SELECT * FROM users' },
        thought_signature: 'gemini-signature-v1-abc123',
      },
    },
  ];

  const geminiOpenAITransformed = {
    id: 'chatcmpl_gemini',
    object: 'chat.completion',
    created: 1,
    model: 'gemini-native',
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: 'I will help you with that.',
          reasoning: 'Analyzing the database query request...',
          tool_calls: [
            {
              id: 'call_db_1',
              type: 'function',
              function: { name: 'database_query', arguments: '{"query":"SELECT * FROM users"}' },
              thought_signature: 'gemini-signature-v1-abc123',
            },
          ],
        },
      },
    ],
  };

  // Step 1: Convert OpenAI response to Anthropic, embedding Gemini parts in thinking block
  const anthropicResponse = convertResponseToAnthropic(
    geminiOpenAITransformed as any,
    'claude-test',
    geminiNativeParts as any
  );

  // Verify Gemini parts are embedded in thinking block _provider_state
  const thinkingBlock = anthropicResponse.content.find((b: any) => b.type === 'thinking');
  expect(thinkingBlock).toBeDefined();
  expect(thinkingBlock?._provider_state?.google?.parts).toBeDefined();
  expect(thinkingBlock?._provider_state?.google?.parts).toEqual(geminiNativeParts);

  // Step 2: Simulate multi-turn by creating an Anthropic request with the response as context
  const multiTurnRequest = {
    model: 'claude-test',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Give me the users from the database',
          },
        ],
      },
      {
        role: 'assistant',
        content: anthropicResponse.content,
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_db_1',
            content: JSON.stringify([{ id: 1, name: 'Alice' }]),
          },
        ],
      },
    ],
  };

  // Step 3: Convert back to Gemini format - thinking block's _provider_state should be used for reconstruction
  const geminiRequest = convertRequestToGemini(multiTurnRequest as any, 'gemini-2.0-flash');

  // Verify the conversion preserves the native Gemini parts
  expect(geminiRequest.contents).toHaveLength(3); // user, assistant (model), user
  expect(geminiRequest.contents[0].role).toBe('user');
  expect(geminiRequest.contents[1].role).toBe('model');
  expect(geminiRequest.contents[2].role).toBe('user');

  // Most importantly: verify the assistant message uses the original Gemini parts verbatim
  // This is reconstructed from the thinking block's _provider_state
  const assistantContent = geminiRequest.contents[1];
  expect(assistantContent.parts).toEqual(geminiNativeParts);

  // Verify thought_signature is preserved exactly as it was in the native parts
  const functionCallPart = assistantContent.parts.find((p: any) => p.functionCall);
  expect(functionCallPart?.functionCall?.thought_signature).toBe('gemini-signature-v1-abc123');
});

