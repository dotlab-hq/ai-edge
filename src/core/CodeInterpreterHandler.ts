import {
  type CodeInterpreterExecutionResult,
  codeInterpreterManager,
} from './CodeInterpreterManager';
import {
  runCodeInterpreterToolLoop,
  type OpenAIToolCall,
  type CodeInterpreterToolRun,
  stripCodeInterpreterTools,
  buildCodeInterpreterToolDefinition,
  normalizeToolChoice,
  isCodeInterpreterTool,
  isCodeInterpreterToolName,
} from './codeInterpreterFlow';
import { stripFreeModifier } from '@/utils/modelIds';
import { backendCooldownManager, isRetryableUpstreamStatus } from './BackendCooldownManager';
const AUTO_MODEL_ID = 'auto';

export type ProxyBackendConfig = {
  id: string;
  apiKey: string;
  baseUrl: string;
};

export type RateLimitConfig = {
  requestsPerMinute?: number;
  requestsPerDay?: number;
  requestsPerMonth?: number;
};

export type ModelSelectionConfig = {
  individualLimit?: boolean;
  rateLimit?: RateLimitConfig;
  models: Array<string | { model: string; params?: any }>;
  randomRouting?: boolean;
  embeddings?: boolean;
};

export class CodeInterpreterHandler {
  async executeToolLoop(
    request: any,
    config: ProxyBackendConfig & ModelSelectionConfig,
    requestedModel: string,
    callModel: ( request: any ) => Promise<{ payload: any; response: Response }>,
    calculateTokenCount: ( body: any ) => number,
    rateLimitManager: { checkAndConsume: ( id: string, tokens: number, limit?: RateLimitConfig, model?: string ) => Promise<{ allowed: boolean }> },
    会话Id?: string
  ): Promise<{ payload: any; toolRuns: CodeInterpreterToolRun[] }> {
    const matchingBackends = this.getBackendsForModel( config, requestedModel );
    if ( !matchingBackends.length ) {
      throw new Error( `No OpenAI backends found for model: ${requestedModel}` );
    }

    const backends = this.getRoundRobinBackends( requestedModel, matchingBackends );

    let lastFailure: { status: number; payload: any } | null = null;

    for ( const backendConfig of backends ) {
      const candidateModels = this.getCandidateModelsForProvider( backendConfig, requestedModel );

      for ( const selectedModel of candidateModels ) {
        const cooldownRemainingMs = backendCooldownManager.getRemainingMs( backendConfig.id, selectedModel );
        if ( cooldownRemainingMs > 0 ) {
          console.warn( `[Code Interpreter] cooldown_active provider=${backendConfig.id} model=${selectedModel} remainingMs=${cooldownRemainingMs}` );
          continue;
        }

        try {
          const filteredBody = this.stripAnthropicCodeInterpreterTools( request );
          const openAIRequest = this.convertAnthropicToOpenAI( filteredBody, selectedModel );
          const { tools } = stripCodeInterpreterTools( openAIRequest.tools );
          const toolDefinition = buildCodeInterpreterToolDefinition();
          const toolChoice = normalizeToolChoice( openAIRequest.tool_choice ?? filteredBody.tool_choice );
          const sessionId = 会话Id || this.buildCodeInterpreterSessionId();

          const onBeforeRequest = async ( req: any ) => {
            const tokens = calculateTokenCount( req );
            const rateLimit = config.individualLimit && config.rateLimit ? config.rateLimit : undefined;
            const rateCheck = await rateLimitManager.checkAndConsume(
              config.id,
              tokens,
              rateLimit,
              selectedModel
            );

            if ( !rateCheck.allowed ) {
              const error = new Error( 'Rate limit exceeded' );
              ( error as any ).rateLimitExceeded = true;
              throw error;
            }
          };

          const { payload } = await runCodeInterpreterToolLoop( {
            request: {
              ...openAIRequest,
              tools,
              stream: false,
            },
            toolDefinition,
            toolChoice,
            callModel,
            onBeforeRequest,
            executeCode: async ( code: string, toolSessionId?: string ) =>
              codeInterpreterManager.executePython( code, toolSessionId ),
            sessionId,
          } );

          if ( !payload || typeof payload !== 'object' || Array.isArray( payload ) ) {
            lastFailure = {
              status: 502,
              payload: {
                error: {
                  message: 'Upstream returned invalid OpenAI response',
                  type: 'upstream_error',
                },
              },
            };
            continue;
          }

          return { payload, toolRuns: [] };
        } catch ( error: any ) {
          if ( error?.rateLimitExceeded ) {
            continue;
          }

          if ( isRetryableUpstreamStatus( error?.status ) ) {
            backendCooldownManager.markFromStatus( backendConfig.id, selectedModel, error.status );
          }

          lastFailure = {
            status: error?.status ?? 502,
            payload: error?.payload ?? {
              error: {
                message: error?.message || 'Upstream request failed',
                type: 'upstream_error',
              },
            },
          };
          console.error( `[Code Interpreter] Error from ${config?.id ?? ( config as any ).name}: ${error?.message || String( error )}` );
        }
      }
    }

    if ( lastFailure ) {
      const error = new Error( 'Code interpreter upstream failure' );
      ( error as any ).status = lastFailure.status;
      ( error as any ).payload = lastFailure.payload;
      throw error;
    }

    throw new Error( 'All providers failed for code interpreter' );
  }

  shouldUseCodeInterpreter( body: any ): boolean {
    if ( !codeInterpreterManager.isEnabled() ) {
      return false;
    }

    const tools = Array.isArray( body?.tools ) ? body.tools : [];
    return tools.some( ( tool: any ) => this.isCodeInterpreterTool( tool ) );
  }

  isCodeInterpreterTool( tool: any ): boolean {
    if ( isCodeInterpreterTool( tool ) ) {
      return true;
    }

    const type = typeof tool?.type === 'string' ? tool.type : '';
    if ( type.startsWith( 'code_execution' ) ) {
      return true;
    }

    return tool?.name === 'code_execution';
  }

  buildCodeInterpreterSessionId(): string {
    return `ci_${Date.now().toString( 36 )}_${Math.random().toString( 36 ).slice( 2, 8 )}`;
  }

  private getBackendsForModel( config: ProxyBackendConfig & ModelSelectionConfig, modelName: string ): any[] {
    const requestedNormalized = stripFreeModifier( modelName ).normalizedId;
    if ( config.embeddings === true ) {
      return [];
    }

    return requestedNormalized === AUTO_MODEL_ID || config.models.some( m => {
      const candidate = typeof m === 'string' ? m : ( m as any ).model;
      return stripFreeModifier( candidate ).normalizedId === requestedNormalized;
    } ) || config.randomRouting !== false
      ? [config]
      : [];
  }

  private getRoundRobinBackends( modelName: string, backends: any[] ): any[] {
    if ( backends.length <= 1 ) {
      return backends;
    }
    const startIndex = Math.floor( Math.random() * backends.length );
    return [
      ...backends.slice( startIndex ),
      ...backends.slice( 0, startIndex ),
    ];
  }

  private getCandidateModelsForProvider( config: ModelSelectionConfig, requestedModel: string ): string[] {
    const requestedNormalized = stripFreeModifier( requestedModel ).normalizedId;
    const explicitlyAuto = requestedNormalized === AUTO_MODEL_ID;
    const modelInThisProvider = config.models.some( m => {
      const candidate = typeof m === 'string' ? m : ( m as any ).model;
      return stripFreeModifier( candidate ).normalizedId === requestedNormalized;
    } );
    // Unlisted models treated as auto-edge: pick best model from provider.
    const isAutoModel = explicitlyAuto || !modelInThisProvider;

    if ( config.randomRouting === false && !isAutoModel ) {
      return [requestedModel];
    }

    const modelNames = config.models.map( m => ( typeof m === 'string' ? m : ( m as any ).model ) );
    if ( !isAutoModel ) {
      return [requestedModel];
    }
    const uniqueModels: string[] = Array.from( new Set( modelNames ) );
    if ( !uniqueModels.length ) {
      return [requestedModel];
    }

    const startIndex = Math.floor( Math.random() * uniqueModels.length );
    return [
      ...uniqueModels.slice( startIndex ),
      ...uniqueModels.slice( 0, startIndex ),
    ];
  }

  private convertAnthropicToOpenAI( body: any, selectedModel: string ): any {
    // This will be imported from AnthropicOpenAIBridge
    return body;
  }

  private stripAnthropicCodeInterpreterTools( body: any ): any {
    if ( !Array.isArray( body?.tools ) ) {
      return body;
    }

    return {
      ...body,
      tools: body.tools.filter( ( tool: any ) => !this.isCodeInterpreterTool( tool ) ),
    };
  }
}

export const codeInterpreterHandler = new CodeInterpreterHandler();
