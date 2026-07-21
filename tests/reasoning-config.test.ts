import { expect, test } from 'bun:test';
import { OpenAIProxy } from '../src/core/OpenAIProxy';
import { AnthropicProxy } from '../src/core/AnthropicProxy';
import { CONFIG } from '../src/utils/schema.lookup';
import { resetTextModelProbeStateForTests } from '../src/utils/textModelProbe';

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

test('OpenAIProxy excludes embeddings-only providers from chat fallback routing', () => {
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
    const backends = proxy.getBackendsForModel('unknown-model', 'chat/completions');
    expect(backends.map((backend: any) => backend.id)).toEqual(['text-only']);
  } finally {
    CONFIG.models.openai = originalOpenAI;
  }
});

test('OpenAIProxy ranks fallback models with fast model hints before heavier preview models', () => {
  const proxy = new OpenAIProxy() as any;
  const config = baseProviderConfig([
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite',
  ]);

  const candidates = proxy.getCandidateModelsForProvider(config, 'claude-sonnet-4-20250514');
  expect(candidates[0]).toBe('gemini-3.1-flash-lite');
});

test('AnthropicProxy excludes embeddings-only providers from message routing fallback', () => {
  const proxy = new AnthropicProxy() as any;
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
    const backends = proxy.getBackendsForModel('unknown-model');
    expect(backends.map((backend: any) => backend.id)).toEqual(['text-only']);
  } finally {
    CONFIG.models.openai = originalOpenAI;
  }
});

test('AnthropicProxy filters message routing by required media modalities', () => {
  const proxy = new AnthropicProxy() as any;
  const originalOpenAI = CONFIG.models.openai;

  CONFIG.models.openai = [
    {
      ...baseProviderConfig(['text-model']),
      id: 'text-only',
      embeddings: false,
      modalities: { input: ['text'], output: ['text'] },
    },
    {
      ...baseProviderConfig(['vision-model']),
      id: 'vision',
      embeddings: false,
      modalities: { input: ['text', 'image'], output: ['text'] },
    },
  ] as any;

  try {
    const modalities = proxy.getRequiredModalities({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
            { type: 'text', text: 'describe' },
          ],
        },
      ],
    });
    const backends = proxy.getBackendsForModel('unknown-model', modalities);
    expect(modalities).toEqual(['text', 'image']);
    expect(backends.map((backend: any) => backend.id)).toEqual(['vision']);
  } finally {
    CONFIG.models.openai = originalOpenAI;
  }
});

test('AnthropicProxy treats omitted modalities as text image audio file capable', () => {
  const proxy = new AnthropicProxy() as any;
  const originalOpenAI = CONFIG.models.openai;

  CONFIG.models.openai = [
    {
      ...baseProviderConfig(['default-modalities-model']),
      id: 'default-modalities',
      embeddings: false,
    },
  ] as any;

  try {
    const backends = proxy.getBackendsForModel('unknown-model', ['text', 'image']);
    expect(backends.map((backend: any) => backend.id)).toEqual(['default-modalities']);
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

test('OpenAIProxy never routes text chat to image_generation/image_editing providers', () => {
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
      ...baseProviderConfig(['flux']),
      id: 'image-both',
      embeddings: false,
      imageModels: { image_generation: true, image_editing: true },
    },
    {
      ...baseProviderConfig(['img-gen-only']),
      id: 'image-gen',
      embeddings: false,
      imageModels: { image_generation: true },
    },
    {
      ...baseProviderConfig(['img-edit-only']),
      id: 'image-edit',
      embeddings: false,
      imageModels: { image_editing: true },
    },
  ] as any;

  try {
    for ( const endpoint of ['chat/completions', 'completions', 'responses', undefined] as const ) {
      const backends = proxy.getBackendsForModel('unknown-model', endpoint);
      expect(backends.map((backend: any) => backend.id)).toEqual(['text-only']);
    }
  } finally {
    CONFIG.models.openai = originalOpenAI;
  }
});

test('AnthropicProxy never routes messages to image_generation/image_editing providers', () => {
  const proxy = new AnthropicProxy() as any;
  const originalOpenAI = CONFIG.models.openai;

  CONFIG.models.openai = [
    {
      ...baseProviderConfig(['text-model']),
      id: 'text-only',
      embeddings: false,
      imageModels: false,
    },
    {
      ...baseProviderConfig(['flux']),
      id: 'image-both',
      embeddings: false,
      imageModels: { image_generation: true, image_editing: true },
    },
  ] as any;

  try {
    const backends = proxy.getBackendsForModel('unknown-model');
    expect(backends.map((backend: any) => backend.id)).toEqual(['text-only']);
  } finally {
    CONFIG.models.openai = originalOpenAI;
  }
});

test('OpenAIProxy text routing only uses models that passed startup probe', () => {
  const proxy = new OpenAIProxy() as any;
  const originalOpenAI = CONFIG.models.openai;

  CONFIG.models.openai = [
    {
      ...baseProviderConfig(['healthy-model', 'sick-model']),
      id: 'primary',
      embeddings: false,
      imageModels: false,
    },
    {
      ...baseProviderConfig(['other-healthy']),
      id: 'secondary',
      embeddings: false,
      imageModels: false,
    },
  ] as any;

  resetTextModelProbeStateForTests( {
    completed: true,
    skipped: false,
    healthy: [
      { providerId: 'primary', model: 'healthy-model' },
      { providerId: 'secondary', model: 'other-healthy' },
    ],
  } );

  try {
    const backends = proxy.getBackendsForModel( 'unknown-model', 'chat/completions' );
    expect( backends.map( ( backend: any ) => backend.id ).sort() ).toEqual( ['primary', 'secondary'] );

    const primaryCandidates = proxy.getCandidateModelsForProvider(
      CONFIG.models.openai!.find( ( c: any ) => c.id === 'primary' ),
      'unknown-model',
    );
    expect( primaryCandidates ).toEqual( ['healthy-model'] );

    const exactSick = proxy.getBackendsForModel( 'sick-model', 'chat/completions' );
    expect( exactSick.map( ( backend: any ) => backend.id ) ).not.toContain( 'primary' );
  } finally {
    resetTextModelProbeStateForTests();
    CONFIG.models.openai = originalOpenAI;
  }
});
