// Loads .env before any other module is evaluated.
//
// ES module imports are hoisted: every `import` in a file runs before that
// file's own statements. Calling dotenv.config() inline in index.js therefore
// ran AFTER ./agent.js had already been imported and constructed its client.
// Importing this module first makes the load order explicit and correct.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'),
  quiet: true,
});
