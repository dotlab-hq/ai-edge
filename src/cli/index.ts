#!/usr/bin/env node

import chalk from 'chalk';
import * as p from '@clack/prompts';
import { initCommand } from './commands/init';
import { startCommand } from './commands/start';
import { resetCommand } from './commands/reset';
import { base64Command } from './commands/base64';

async function main() {
  const command = process.argv[2];

  try {
    switch ( command ) {
      case 'init':
        await initCommand();
        break;
      case 'start':
      case 'serve':
        await startCommand();
        break;
      case 'reset':
        await resetCommand();
        break;
      case 'base64':
        await base64Command();
        break;
      default:
        p.intro( chalk.blue( '🚀 LLM Proxy CLI' ) );
        p.note(
          'init      - Initialize model.jsonc\n' +
          'start     - Start the server\n' +
          'reset     - Reset configuration\n' +
          'base64    - Print base64-encoded config',
          'Commands'
        );
        p.note(
          '--skip-prompts  - Skip interactive prompts',
          'Options'
        );
        p.outro( 'Visit: https://github.com/dotlab-hq/ai-edge' );
    }
  } catch ( err ) {
    p.outro( chalk.red( `❌ ${( err as any ).message || 'Unexpected error'}` ) );
    process.exit( 1 );
  }
}

main();
