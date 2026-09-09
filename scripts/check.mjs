import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const folder of ['scripts', 'apps/console/server', 'apps/console/public']) {
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(m?js)$/.test(file)) {
        const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
        if (result.status !== 0) process.exit(result.status || 1);
      }
    }
  };
  visit(path.join(root, folder));
}
console.log('JavaScript syntax checks passed.');
