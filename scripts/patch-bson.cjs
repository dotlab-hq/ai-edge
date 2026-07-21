const fs = require('fs');
const path = require('path');

const bsonFile = path.join(__dirname, '..', 'node_modules', 'bson', 'lib', 'bson.cjs');

if (!fs.existsSync(bsonFile)) {
    process.exit(0);
}

let content = fs.readFileSync(bsonFile, 'utf8');

if (content.includes('try { /* Bun')) {
    process.exit(0);
}

const old = `        const { startupSnapshot } = globalThis?.process?.getBuiltinModule?.('v8') ?? {};
        if ( startupSnapshot?.isBuildingSnapshot?.()) {
            startupSnapshot?.addDeserializeCallback?.(this.resetState);
        }`;

const rep = `        try {
            const { startupSnapshot } = globalThis?.process?.getBuiltinModule?.('v8') ?? {};
            if ( startupSnapshot?.isBuildingSnapshot?.()) {
                startupSnapshot?.addDeserializeCallback?.(this.resetState);
            }
        } catch { /* Bun does not implement node:v8 */ }`;

if (content.includes(old)) {
    content = content.replace(old, rep);
    fs.writeFileSync(bsonFile, content, 'utf8');
    console.log('bson patched for Bun compatibility');
}
