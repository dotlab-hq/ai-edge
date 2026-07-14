/**
 * Converts between OpenAI Responses API and Chat Completions formats.
 *
 * When an upstream backend only supports `/chat/completions`, these utilities
 * translate a `/responses` request into chat/completions format and rebuild
 * the upstream response in Responses shape so the caller never notices.
 *
 * This file re-exports the implementation split across `./responses/*`.
 */

export {
    convertResponsesRequestToChat,
} from './responses/requestToChat';

export {
    convertChatResponseToResponses,
} from './responses/chatToResponses';

export {
    createResponsesStreamState,
    emitResponsesStreamPreamble,
    emitResponsesEvent,
    sseEventsToWsFrames,
    emitResponsesDoneSentinel,
} from './responses/streamState';

export {
    processChatStreamChunkForResponses,
} from './responses/streamChunk';

export {
    emitResponsesCompleted,
    buildStreamOutputItems,
} from './responses/events';

export type {
    FileSearchCallItem,
    ResponsesStreamState,
} from './responses/types';
