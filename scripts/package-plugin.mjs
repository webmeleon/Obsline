import { execSync } from 'child_process';
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'plugin');
const { version } = JSON.parse(readFileSync(join(pluginDir, 'manifest.json'), 'utf8'));
const releaseDir = join(root, 'releases');
const zipPath = join(releaseDir, `obsline-v${version}.zip`);

mkdirSync(releaseDir, { recursive: true });

const files = ['main.js', 'manifest.json', 'styles.css'].map(f => join(pluginDir, f));

if (platform === 'win32') {
  const list = files.map(f => `'${f}'`).join(',');
  execSync(`powershell -Command "Compress-Archive -Path @(${list}) -DestinationPath '${zipPath}' -Force"`);
} else {
  execSync(`zip -j "${zipPath}" ${files.join(' ')}`);
}

console.log(`✓ ${zipPath}`);
