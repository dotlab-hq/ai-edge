import type { Config } from '@/schema';

type AnthropicModelConfig = Config['models']['anthropic'] extends Array<infer T> ? T : never;

interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock = 
  | { type: 'text'; text: string }
  | { type: 'image'; image: { data: string; media_type: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | { messages: Array<{role: string, content: string}> };
  max_tokens?: number;
  max_tokens_to_sample?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, any>;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string;
  stop_sequence?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface OpenAIChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class AnthropicAdapter {
  private anthropicConfig: AnthropicModelConfig | null = null;

  setAnthropicConfig(config: AnthropicModelConfig): void {
    this.anthropicConfig = config;
  }

  convertRequestToOpenAI(
    anthropicRequest: AnthropicRequest,
    openAIModel: string,
    provider?: 'openai' | 'native'
  ): any {
    const openAIRequest: any = {
      model: openAIModel,
      messages: [],
      stream: anthropicRequest.stream,
    };

    // Handle system message
    if (anthropicRequest.system) {
      if (typeof anthropicRequest.system === 'string') {
        openAIRequest.messages.push({
          role: 'system',
          content: anthropicRequest.system,
        });
      } else if (anthropicRequest.system.messages) {
        for (const msg of anthropicRequest.system.messages) {
          openAIRequest.messages.push({
            role: msg.role as 'system' | 'user' | 'assistant',
            content: msg.content,
          });
        }
      }
    }

    // Convert messages
    for (const msg of anthropicRequest.messages) {
      if (msg.role === 'system') {
        // Anthropic system messages are already handled above
        continue;
      }

      const openAIMessage: any = {
        role: msg.role,
        content: this.convertAnthropicContentToOpenAI(msg.content),
      };

      openAIRequest.messages.push(openAIMessage);
    }

    // Handle tools
    if (anthropicRequest.tools && anthropicRequest.tools.length > 0) {
      openAIRequest.tools = anthropicRequest.tools.map(this.convertAnthropicToolToOpenAI);
    }

    // Handle sampling parameters
    if (anthropicRequest.max_tokens) {
      openAIRequest.max_tokens = anthropicRequest.max_tokens;
    } else if (anthropicRequest.max_tokens_to_sample) {
      openAIRequest.max_tokens = anthropicRequest.max_tokens_to_sample;
    }

    if (anthropicRequest.temperature !== undefined) {
      openAIRequest.temperature = anthropicRequest.temperature;
    }

    if (anthropicRequest.top_p !== undefined) {
      openAIRequest.top_p = anthropicRequest.top_p;
    }

    if (anthropicRequest.stop_sequences && anthropicRequest.stop_sequences.length > 0) {
      openAIRequest.stop = anthropicRequest.stop_sequences;
    }

    return openAIRequest;
  }

  convertResponseToAnthropic(openAIResponse: OpenAIChatCompletion, anthropicModel: string): AnthropicResponse {
    const contentBlocks: AnthropicContentBlock[] = [];
    let stopReason = 'end_turn';

    for (const choice of openAIResponse.choices) {
      if (choice.message.content) {
        contentBlocks.push({
          type: 'text',
          text: choice.message.content,
        });
      }

      if (choice.message.tool_calls) {
        for (const toolCall of choice.message.tool_calls) {
          contentBlocks.push({
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments),
          });
        }
      }

      if (choice.finish_reason === 'stop') {
        stopReason = 'end_turn';
      } else if (choice.finish_reason === 'length') {
        stopReason = 'max_tokens';
      } else if (choice.finish_reason === 'tool_calls') {
        stopReason = 'tool_use';
      }
    }

    return {
      id: openAIResponse.id,
      type: 'message',
      role: 'assistant',
      content: contentBlocks,
      model: anthropicModel,
      stop_reason: stopReason,
      usage: {
        input_tokens: openAIResponse.usage?.prompt_tokens ?? 0,
        output_tokens: openAIResponse.usage?.completion_tokens ?? 0,
      },
    };
  }

  private convertAnthropicContentToOpenAI(content: string | AnthropicContentBlock[]): string {
    if (typeof content === 'string') {
      return content;
    }

    return content
      .map((block) => {
        if (block.type === 'text') {
          return block.text;
        }
        return '';
      })
      .join('\n');
  }

  private convertAnthropicToolToOpenAI(tool: AnthropicTool): any {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema,
      },
    };
  }

  buildAnthropicHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
}

export const anthropicAdapter = new AnthropicAdapter();