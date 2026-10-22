import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(fs.realpathSync(new URL('../apps/desktop/node_modules/vite/dist/node/index.js', import.meta.url)));
const { build } = require('esbuild');
await build({ entryPoints: ['memory/mobile/nativeEntry.js'], outfile: 'mobile/transport/memory-runtime.js',
  bundle: true, platform: 'neutral', format: 'iife', target: 'safari16', minify: false,
  alias: { 'node:crypto': path.resolve('memory/mobile/nativeCrypto.js') } });
console.log('MOBILE_MEMORY_GOVERNANCE_BUNDLE_BUILT');
