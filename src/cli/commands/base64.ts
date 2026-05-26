import path from 'path';
import { access, readFile } from 'node:fs/promises';
import { getConfigFileName } from '../utils/template';
import { parseConfigContent } from '../../utils/readConfig';

export async function base64Command(): Promise<void> {
    try {
        const cwd = process.cwd();
        const configFileName = getConfigFileName();
        const configPath = path.join( cwd, configFileName );

        const configExists = await access( configPath ).then( () => true ).catch( () => false );
        if ( !configExists ) {
            console.error( `❌ ${configFileName} not found. Run "ai-edge init" first.` );
            process.exit( 1 );
        }

        const content = await readFile( configPath, 'utf-8' );
        const parsed = parseConfigContent( content );
        const normalized = JSON.stringify( parsed, null, 2 );
        const encoded = Buffer.from( normalized, 'utf-8' ).toString( 'base64' );
        process.stdout.write( encoded );
    } catch ( error: any ) {
        console.error( `❌ ${error?.message || 'Failed to encode config'}` );
        process.exit( 1 );
    }
}
