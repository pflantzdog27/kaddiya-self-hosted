import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = path.join(root, 'apps', 'console');

try {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Kaddiya needs Node.js 22 or newer. Install your company-approved Node.js LTS release, then run setup again.');
  console.log('Installing Kaddiya dependencies. No Docker or database installation is needed.');
  // Invoke npm through Node on Windows: npm.cmd requires a shell, and paths
  // on work computers commonly contain spaces. No PowerShell script needed.
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (process.platform === 'win32' && !existsSync(npmCli)) throw new Error('Could not find npm beside Node.js. Run npm.cmd run setup from the repository folder.');
  const command = existsSync(npmCli) ? process.execPath : 'npm';
  const args = [...(existsSync(npmCli) ? [npmCli] : []), 'ci', '--omit=dev', '--no-audit', '--no-fund'];
  await new Promise((resolve, reject) => {
    const install = spawn(command, args, { cwd: app, stdio: 'inherit' });
    install.on('error', reject);
    install.on('exit', code => code === 0 ? resolve() : reject(new Error('Dependency installation failed. Check access to your approved npm registry, then rerun setup.')));
  });
  const { startWorkspace } = await import('./start.mjs');
  await startWorkspace({ initialize: true });
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}
