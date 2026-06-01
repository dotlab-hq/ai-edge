import * as p from '@clack/prompts';
import chalk from 'chalk';
import path from 'path';
import net from 'node:net';
import { access } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { decodeConfigFromEnv, readConfig } from '../../utils/readConfig';
import { getConfigFileName } from '../utils/template';
import { createNodeServerFactoryWithNoDelay } from '../../utils/proxyFetch';

const DEFAULT_PORT = 25789;

async function isPortAvailable( port: number ): Promise<boolean> {
  return new Promise( ( resolve ) => {
    const server = net.createServer();
    server.once( 'error', () => resolve( false ) );
    server.once( 'listening', () => {
      server.close( () => resolve( true ) );
    } );
    server.listen( port );
  } );
}

async function findAvailablePort( startPort: number ): Promise<number> {
  if ( await isPortAvailable( startPort ) ) {
    return startPort;
  }
  for ( let port = startPort + 1; port < 65535; port++ ) {
    if ( await isPortAvailable( port ) ) {
      return port;
    }
  }
  return startPort;
}

export async function startCommand(): Promise<void> {
  p.intro( chalk.blue( '🚀 Starting LLM Proxy Server' ) );
  p.note(
    `Built for development. Not to be used for production`
  );

  try {
    const cwd = process.cwd();
    const configFileName = getConfigFileName();
    const configPath = path.join( cwd, configFileName );
    const encodedConfig = process.env.AI_EDGE_CONFIG?.trim();

    if ( !encodedConfig ) {
      const configExists = await access( configPath ).then( () => true ).catch( () => false );
      if ( !configExists ) {
        p.outro( chalk.red( `❌ ${configFileName} not found. Run "ai-edge init" first.` ) );
        process.exit( 1 );
      }
    }

    const s = p.spinner();
    s.start( 'Loading configuration...' );

    let configData;
    try {
      if ( encodedConfig ) {
        configData = decodeConfigFromEnv( encodedConfig );
      } else {
        configData = await readConfig( configPath );
      }
    } catch ( err: any ) {
      s.stop( '❌' );
      console.error( 'Config Error:', err?.message || err );
      p.outro( chalk.red( `❌ ${err?.message || 'Invalid configuration'}` ) );
      process.exit( 1 );
    }

    s.stop( '✅ Configuration loaded' );

    const skipPrompts = process.argv.includes( '--skip-prompts' );
    const debugEnabled = process.argv.includes( '--debug' );
    let portNum: number;

    if ( skipPrompts ) {
      portNum = await findAvailablePort( DEFAULT_PORT );
    } else {
      const suggestedPort = await findAvailablePort( DEFAULT_PORT );
      const port = await p.text( {
        message: 'Server port:',
        defaultValue: String( suggestedPort ),
        validate: ( v ) => {
          if ( v === undefined || v === '' ) return 'Port is required';
          const num = parseInt( v );
          return isNaN( num ) || num < 1 || num > 65535 ? 'Must be a valid port number' : undefined;
        },
      } );

      if ( p.isCancel( port ) ) {
        p.outro( chalk.gray( 'Cancelled' ) );
        process.exit( 0 );
      }

      portNum = parseInt( port! );
    }

    if ( debugEnabled ) {
      process.env.AI_EDGE_DEBUG = '1';
    }

    const accessKey = process.env.AI_EDGE_KEY?.trim();
    const apiKeyMessage = accessKey
      ? 'API Key: configured via AI_EDGE_KEY'
      : 'API Key: ai-edge [anything will work :) ]';

    p.note(
      `Base URL: http://localhost:${portNum}
${apiKeyMessage}
State Adapter: ${( configData as any )['state-adapter']}
Models Configured: ${( configData as any ).models.openai.length}
Debug: ${debugEnabled ? 'enabled' : 'disabled'}`,
      '🌐 Server Configuration'
    );

    const s2 = p.spinner();
    s2.start( 'Starting server...' );

    try {
      const { default: app } = await import( '../../../server' );

      serve( { fetch: app.fetch, port: portNum, createServer: createNodeServerFactoryWithNoDelay() } );

      s2.stop( `✅ Server running on http://localhost:${portNum}` );

      const exampleKey = accessKey || 'nlm-proxy';
      p.note(
        `curl -X GET http://localhost:${portNum}/ \\\n` +
        `  -H "Authorization: Bearer ${exampleKey}"`,
        '📚 Example Usage'
      );

      p.outro( chalk.green( '✅ LLM Proxy ready! Press Ctrl+C to stop' ) );

      // Graceful shutdown on Ctrl+C
      process.on( 'SIGINT', async () => {
        console.log( '\n' );
        p.outro( chalk.yellow( '👋 Shutting down server...' ) );
        process.exit( 0 );
      } );
    } catch ( err: any ) {
      s2.stop( '❌' );
      console.error( 'Server Startup Error:', err?.message || err );
      p.outro( chalk.red( `❌ ${err?.message || 'Server startup failed'}` ) );
      process.exit( 1 );
    }
  } catch ( error: any ) {
    console.error( 'Start Command Error:', error?.message || error );
    p.outro( chalk.red( `❌ ${error?.message || 'Failed to start server'}` ) );
    process.exit( 1 );
  }
}
