import {
    convertRequestToOpenAI as convertReq,
    convertResponseToAnthropic as convertResp,
} from '@/package/claude-adapter';
import type {
    AnthropicMessageRequest,
    AnthropicMessageResponse,
} from '@/package/claude-adapter';
import { normalizeAnthropicRequest } from './normalize';
import {
    streamOpenAIResponseAsAnthropic,
    relayUpstreamToStreamWriter,
} from './stream';

// Conversion request entrypoint — normalizes the Anthropic request, then forwards to the adapter.
export function convertAnthropicRequestToOpenAI(
    anthropicRequest: AnthropicMessageRequest,
    targetModel: string,
    toolFormat: 'native' | 'xml' = 'native'
) {
    return convertReq( normalizeAnthropicRequest( anthropicRequest ), targetModel, toolFormat );
}

export function convertOpenAIResponseToAnthropic(
    openAIResponse: any,
    originalModelRequested: string
): AnthropicMessageResponse {
    return convertResp( openAIResponse, originalModelRequested );
}

export {
    streamOpenAIResponseAsAnthropic,
    relayUpstreamToStreamWriter,
};
