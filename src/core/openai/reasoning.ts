import { stripFreeModifier } from '@/utils/modelIds';
import type { OpenAIModelConfig, ReasoningEffort } from './types';

export function hasExplicitReasoningRequest( body: any ): boolean {
    return typeof body?.reasoning_effort === 'string'
        || typeof body?.reasoning?.effort === 'string'
        || typeof body?.thinking?.effort === 'string'
        || body?.include_reasoning === true
        || body?.output_reasoning === true;
}

export function resolveReasoningEffort( body: any, config: OpenAIModelConfig, selectedModel: string ): ReasoningEffort | undefined {
    if ( !isReasoningConfiguredForModel( config, selectedModel ) ) return undefined;

    if ( typeof body?.reasoning_effort === 'string' ) return body.reasoning_effort as ReasoningEffort;
    if ( typeof body?.reasoning?.effort === 'string' ) return body.reasoning.effort as ReasoningEffort;

    const modelEntry = config.models.find( model => {
        const modelName = typeof model === 'string' ? model : model.model;
        return stripFreeModifier( modelName ).normalizedId === stripFreeModifier( selectedModel ).normalizedId;
    } );

    if ( modelEntry && typeof modelEntry === 'object' && modelEntry.default_reasoning ) return modelEntry.default_reasoning;
    return config.default_reasoning;
}

export function isReasoningConfiguredForModel( config: OpenAIModelConfig, selectedModel: string ): boolean {
    const hasProviderReasoning = Object.prototype.hasOwnProperty.call( config, 'reasoning_efforts' )
        || Object.prototype.hasOwnProperty.call( config, 'default_reasoning' );
    if ( hasProviderReasoning ) return true;

    const modelEntry = config.models.find( model => {
        const modelName = typeof model === 'string' ? model : model.model;
        return stripFreeModifier( modelName ).normalizedId === stripFreeModifier( selectedModel ).normalizedId;
    } );

    return !!modelEntry
        && typeof modelEntry === 'object'
        && ( Object.prototype.hasOwnProperty.call( modelEntry, 'reasoning_efforts' )
            || Object.prototype.hasOwnProperty.call( modelEntry, 'default_reasoning' ) );
}

export function stripReasoningFields( body: any ): any {
    if ( !body || typeof body !== 'object' ) return body;
    const { reasoning_effort, reasoning, thinking, include_reasoning, output_reasoning, ...rest } = body;
    return rest;
}

export function withReasoningEffort( body: any, config: OpenAIModelConfig, selectedModel: string ): any {
    if ( !isReasoningConfiguredForModel( config, selectedModel ) ) return stripReasoningFields( body );
    if ( body?.stream === true && !hasExplicitReasoningRequest( body ) ) return body;

    const effort = resolveReasoningEffort( body, config, selectedModel );
    if ( !effort || effort === 'none' ) return body;

    return { ...body, reasoning_effort: effort };
}

export function withGeminiThinking( body: any, selectedModel: string ): any {
    if ( !body || typeof body !== 'object' ) return body;
    const { reasoning_effort, reasoning, thinking, include_reasoning, output_reasoning, ...rest } = body;
    const effort = typeof reasoning_effort === 'string' ? reasoning_effort : typeof reasoning?.effort === 'string' ? reasoning.effort : undefined;
    if ( !effort ) return rest;
    const isGemini25 = /gemini-2\.5/i.test( selectedModel );
    if ( effort === 'none' && !isGemini25 ) throw new Error( 'reasoning_effort=none is only supported by Gemini 2.5 models' );
    const config = rest.extra_body?.google?.thinking_config || {};
    return { ...rest, extra_body: { ...( rest.extra_body || {} ), google: { ...( rest.extra_body?.google || {} ), thinking_config: { ...config, include_thoughts: true, ...( isGemini25 ? { thinking_budget: effort === 'none' ? 0 : ({ low: 1024, medium: 8192, high: 24576 } as Record<string, number>)[effort] ?? 8192 } : { thinking_level: effort === 'minimal' ? 'minimal' : effort } ) } } } };
}

