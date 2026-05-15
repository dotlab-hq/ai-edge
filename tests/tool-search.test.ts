import { expect, test } from 'bun:test';
import { OpenAIProxy } from '../src/core/OpenAIProxy';
import { convertAnthropicRequestToOpenAI } from '../src/core/AnthropicOpenAIBridge';

test( 'chat/completions strips OpenAI tool_search and defer_loading fields', () => {
  const proxy = new OpenAIProxy() as any;
  const body = {
    model: 'gpt-5.4',
    tools: [
      {
        type: 'tool_search',
      },
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string' },
            },
            required: ['location'],
          },
        },
        defer_loading: true,
      },
    ],
    tool_choice: {
      type: 'function',
      function: {
        name: 'get_weather',
      },
    },
  };

  const normalized = proxy.normalizeToolSearchForEndpoint( body, 'chat/completions' );

  expect( Array.isArray( normalized.tools ) ).toBe( true );
  expect( normalized.tools.length ).toBe( 1 );
  expect( normalized.tools[0]?.type ).toBe( 'function' );
  expect( normalized.tools[0]?.function?.name ).toBe( 'get_weather' );
  expect( 'defer_loading' in normalized.tools[0] ).toBe( false );
  expect( normalized.tool_choice?.function?.name ).toBe( 'get_weather' );
} );

test( 'Anthropic tool_search definitions are dropped while deferred tools remain callable', () => {
  const converted = convertAnthropicRequestToOpenAI(
    {
      model: 'claude-sonnet-4-0',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: 'What is the weather in San Francisco?',
        },
      ],
      tools: [
        {
          type: 'tool_search_tool_regex_20251119',
          name: 'tool_search_tool_regex',
        },
        {
          name: 'get_weather',
          description: 'Get weather at a location',
          input_schema: {
            type: 'object',
            properties: {
              location: { type: 'string' },
            },
            required: ['location'],
          },
          defer_loading: true,
        },
      ],
    } as any,
    'gpt-5.4'
  ) as any;

  expect( Array.isArray( converted.tools ) ).toBe( true );
  expect( converted.tools.length ).toBe( 1 );
  expect( converted.tools[0]?.type ).toBe( 'function' );
  expect( converted.tools[0]?.function?.name ).toBe( 'get_weather' );
} );

test( 'Anthropic tool_choice targeting tool_search is removed after proxy normalization', () => {
  const converted = convertAnthropicRequestToOpenAI(
    {
      model: 'claude-sonnet-4-0',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: 'Find tools for weather then call weather tool',
        },
      ],
      tools: [
        {
          type: 'tool_search_tool_bm25_20251119',
          name: 'tool_search_tool_bm25',
        },
        {
          name: 'get_weather',
          description: 'Get weather at a location',
          input_schema: {
            type: 'object',
            properties: {
              location: { type: 'string' },
            },
            required: ['location'],
          },
          defer_loading: true,
        },
      ],
      tool_choice: {
        type: 'tool',
        name: 'tool_search_tool_bm25',
      },
    } as any,
    'gpt-5.4'
  ) as any;

  expect( Array.isArray( converted.tools ) ).toBe( true );
  expect( converted.tools.length ).toBe( 1 );
  expect( converted.tools[0]?.function?.name ).toBe( 'get_weather' );
  expect( converted.tool_choice ).toBeUndefined();
} );
