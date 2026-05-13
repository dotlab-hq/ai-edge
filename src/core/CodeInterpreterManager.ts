import { DaytonaSandbox } from '@langchain/daytona';
import { randomUUID } from 'node:crypto';
import { CONFIG } from '@/utils/schema.lookup';

const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_LANGUAGE = 'python';
const SESSION_TTL_MS = 20 * 60 * 1000;
const MAX_OUTPUT_CHARS = 20_000;

export type CodeInterpreterConfig = {
    type: 'daytona';
    apiKey: string;
    apiUrl?: string;
    language?: 'python' | 'typescript' | 'javascript';
    timeout?: number;
    target?: 'us' | 'eu';
    image?: string;
    snapshot?: string;
    resources?: {
        cpu?: number;
        memory?: number;
        disk?: number;
    };
    autoStopInterval?: number;
    labels?: Record<string, string>;
    initialFiles?: Record<string, string>;
};

export type CodeInterpreterExecutionResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
    sessionId: string;
};

type CodeInterpreterSession = {
    sandbox: DaytonaSandbox;
    lastUsed: number;
};

class CodeInterpreterManager {
    private readonly sessions = new Map<string, CodeInterpreterSession>();

    isEnabled(): boolean {
        return !!this.getConfig();
    }

    getConfig(): CodeInterpreterConfig | undefined {
        const tools = CONFIG.tools as Record<string, unknown> | undefined;
        const config = ( tools?.codeInterpreter ?? ( tools as any )?.code_interpreter ) as CodeInterpreterConfig | undefined;
        return config?.type === 'daytona' ? config : undefined;
    }

    async executePython( code: string, sessionId?: string ): Promise<CodeInterpreterExecutionResult> {
        const { sandbox, sessionId: resolvedSession } = await this.getOrCreateSession( sessionId );
        const command = buildPythonCommand( code );
        const result = await sandbox.execute( command );
        const normalized = normalizeExecutionResult( result );

        return {
            ...normalized,
            sessionId: resolvedSession,
        };
    }

    private async getOrCreateSession( sessionId?: string ): Promise<{ sandbox: DaytonaSandbox; sessionId: string }> {
        await this.pruneExpiredSessions();

        if ( sessionId && this.sessions.has( sessionId ) ) {
            const existing = this.sessions.get( sessionId )!;
            existing.lastUsed = Date.now();
            return { sandbox: existing.sandbox, sessionId };
        }

        const config = this.getConfig();
        if ( !config ) {
            throw new Error( 'Code interpreter is not configured' );
        }

        const sandbox = await DaytonaSandbox.create( buildSandboxOptions( config ) );
        const newSessionId = sessionId || randomUUID();
        this.sessions.set( newSessionId, { sandbox, lastUsed: Date.now() } );

        return { sandbox, sessionId: newSessionId };
    }

    private async pruneExpiredSessions(): Promise<void> {
        const now = Date.now();
        const expired: Array<[string, CodeInterpreterSession]> = [];

        for ( const entry of this.sessions.entries() ) {
            const [id, session] = entry;
            if ( now - session.lastUsed > SESSION_TTL_MS ) {
                expired.push( [id, session] );
            }
        }

        for ( const [id, session] of expired ) {
            this.sessions.delete( id );
            try {
                await session.sandbox.close();
            } catch {
                // ignore cleanup errors
            }
        }
    }
}

function buildSandboxOptions( config: CodeInterpreterConfig ): Record<string, unknown> {
    const options: Record<string, unknown> = {
        language: config.language ?? DEFAULT_LANGUAGE,
        timeout: config.timeout ?? DEFAULT_TIMEOUT_SECONDS,
        auth: {
            apiKey: config.apiKey,
            ...( config.apiUrl ? { apiUrl: config.apiUrl } : {} ),
        },
    };

    if ( config.target ) options.target = config.target;
    if ( config.image ) options.image = config.image;
    if ( config.snapshot ) options.snapshot = config.snapshot;
    if ( config.resources ) options.resources = config.resources;
    if ( typeof config.autoStopInterval === 'number' ) options.autoStopInterval = config.autoStopInterval;
    if ( config.labels ) options.labels = config.labels;
    if ( config.initialFiles ) options.initialFiles = config.initialFiles;

    return options;
}

function buildPythonCommand( code: string ): string {
    const encoded = Buffer.from( code ?? '', 'utf-8' ).toString( 'base64' );
    return [
        "python - <<'PY'",
        'import base64',
        'import sys',
        'import traceback',
        `code = base64.b64decode("${encoded}").decode("utf-8")`,
        'globals_dict = {"__name__": "__main__"}',
        'try:',
        '    exec(compile(code, "<code-interpreter>", "exec"), globals_dict)',
        'except Exception:',
        '    traceback.print_exc()',
        '    sys.exit(1)',
        'PY',
    ].join( '\n' );
}

function normalizeExecutionResult( result: any ): { stdout: string; stderr: string; exitCode: number } {
    const stdout = pickString( result?.stdout ) || pickString( result?.output ) || '';
    const stderr = pickString( result?.stderr ) || '';
    const exitCode = pickNumber( result?.exitCode )
        ?? pickNumber( result?.returnCode )
        ?? pickNumber( result?.status )
        ?? 0;

    return {
        stdout: truncateOutput( stdout ),
        stderr: truncateOutput( stderr ),
        exitCode,
    };
}

function pickString( value: unknown ): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function pickNumber( value: unknown ): number | undefined {
    return typeof value === 'number' && Number.isFinite( value ) ? value : undefined;
}

function truncateOutput( value: string ): string {
    if ( value.length <= MAX_OUTPUT_CHARS ) {
        return value;
    }
    return `${value.slice( 0, MAX_OUTPUT_CHARS )}\n...output truncated...`;
}

export const codeInterpreterManager = new CodeInterpreterManager();
