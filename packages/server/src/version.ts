import { createRequire } from 'node:module';

// `src/` and `dist/` sit at the same depth under the package root, so this
// resolves identically whether the source or the build output is running.
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION = pkg.version;
