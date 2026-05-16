import { expect, test } from 'bun:test';
import { OpenAIProxy } from '../src/core/OpenAIProxy';
import { AnthropicProxy } from '../src/core/AnthropicProxy';
import { CONFIG } from '../src/utils/schema.lookup';

function baseProviderConfig(models: any[]): any {
  return {
    id: 'cfg-1',
    name: 'cfg-1',
    models,
    individualLimit: true,
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    randomRouting: true,
  };
}

test('OpenAIProxy strips reasoning fields when model has no explicit reasoning config', () => {
  const proxy = new OpenAIProxy() as any;
  const config = baseProviderConfig(['gpt-4.1']);
  const body = {
    model: 'gpt-4.1',
    reasoning_effort: 'high',
    reasoning: { effort: 'high' },
    include_reasoning: true,
    output_reasoning: true,
    messages: [{ role: 'user', content: 'hello' }],
  };

  const normalized = proxy.withReasoningEffort(body, config, 'gpt-4.1');
  expect(normalized.reasoning_effort).toBeUndefined();
  expect(normalized.reasoning).toBeUndefined();
  expect(normalized.include_reasoning).toBeUndefined();
  expect(normalized.output_reasoning).toBeUndefined();
});

test('OpenAIProxy injects configured provider default reasoning effort', () => {
  const proxy = new OpenAIProxy() as any;
  const config = {
    ...baseProviderConfig(['gpt-4.1']),
    reasoning_efforts: ['low', 'medium', 'high'],
    default_reasoning: 'low',
  };

  const normalized = proxy.withReasoningEffort({ model: 'gpt-4.1' }, config, 'gpt-4.1');
  expect(normalized.reasoning_effort).toBe('low');
});

test('OpenAIProxy injects configured model-level default reasoning effort', () => {
  const proxy = new OpenAIProxy() as any;
  const config = baseProviderConfig([
    {
      model: 'gpt-4.1',
      rateLimit: { requestsPerMinute: 10 },
      reasoning_efforts: ['low', 'medium'],
      default_reasoning: 'medium',
    },
  ]);

  const normalized = proxy.withReasoningEffort({ model: 'gpt-4.1' }, config, 'gpt-4.1');
  expect(normalized.reasoning_effort).toBe('medium');
});

test('AnthropicProxy strips reasoning fields when model has no explicit reasoning config', () => {
  const proxy = new AnthropicProxy() as any;
  const config = baseProviderConfig(['gpt-4.1']);
  const request = {
    model: 'gpt-4.1',
    reasoning_effort: 'high',
    reasoning: { effort: 'high' },
    thinking: { effort: 'high' },
  };

  const normalized = proxy.withReasoningEffort(request, request, config, 'gpt-4.1');
  expect(normalized.reasoning_effort).toBeUndefined();
  expect(normalized.reasoning).toBeUndefined();
  expect(normalized.thinking).toBeUndefined();
});

test('OpenAIProxy only routes embeddings endpoint to embeddings-enabled providers', () => {
  const proxy = new OpenAIProxy() as any;
  const originalOpenAI = CONFIG.models.openai;

  CONFIG.models.openai = [
    {
      ...baseProviderConfig(['text-model']),
      id: 'text-only',
      embeddings: false,
      imageModels: false,
    },
    {
      ...baseProviderConfig(['embed-model']),
      id: 'embed-only',
      embeddings: true,
      imageModels: false,
    },
  ] as any;

  try {
    const backends = proxy.getBackendsForModel('unknown-model', 'embeddings');
    expect(backends.map((backend: any) => backend.id)).toEqual(['embed-only']);
  } finally {
    CONFIG.models.openai = originalOpenAI;
  }
});

test('OpenAIProxy only routes image generation endpoint to image-enabled providers', () => {
  const proxy = new OpenAIProxy() as any;
  const originalOpenAI = CONFIG.models.openai;

  CONFIG.models.openai = [
    {
      ...baseProviderConfig(['text-model']),
      id: 'text-only',
      embeddings: false,
      imageModels: false,
    },
    {
      ...baseProviderConfig(['img-gen-model']),
      id: 'image-gen',
      embeddings: false,
      imageModels: { image_generation: true },
    },
    {
      ...baseProviderConfig(['img-edit-model']),
      id: 'image-edit',
      embeddings: false,
      imageModels: { image_editing: true },
    },
  ] as any;

  try {
    const backends = proxy.getBackendsForModel('unknown-model', 'images/generations');
    expect(backends.map((backend: any) => backend.id)).toEqual(['image-gen']);
  } finally {
    CONFIG.models.openai = originalOpenAI;
  }
});

test('OpenAIProxy image endpoints require explicit imageModels fields', () => {
  const proxy = new OpenAIProxy() as any;
  const originalOpenAI = CONFIG.models.openai;

  CONFIG.models.openai = [
    {
      ...baseProviderConfig(['legacy-image-model']),
      id: 'legacy-image-boolean',
      embeddings: false,
      imageModels: true,
    },
    {
      ...baseProviderConfig(['img-gen-model']),
      id: 'image-gen',
      embeddings: false,
      imageModels: { image_generation: true },
    },
    {
      ...baseProviderConfig(['img-edit-model']),
      id: 'image-edit',
      embeddings: false,
      imageModels: { image_editing: true },
    },
  ] as any;

  try {
    const generationBackends = proxy.getBackendsForModel('unknown-model', 'images/generations');
    const editBackends = proxy.getBackendsForModel('unknown-model', 'images/edits');

    expect(generationBackends.map((backend: any) => backend.id)).toEqual(['image-gen']);
    expect(editBackends.map((backend: any) => backend.id)).toEqual(['image-edit']);
  } finally {
    CONFIG.models.openai = originalOpenAI;
  }
});
