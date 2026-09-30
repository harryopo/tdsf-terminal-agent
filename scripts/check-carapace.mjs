import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifest = JSON.parse(readFileSync(join(root, 'src-tauri/bin/carapace-manifest.json'), 'utf8'));

export function checkResources(binDir, assets = manifest.assets) {
  for (const asset of assets) {
    const path = join(binDir, asset.output);
    if (!existsSync(path)) throw new Error(`Missing completion resource: ${asset.output}. Run pnpm fetch:carapace.`);
    const data = readFileSync(path);
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (data.length !== asset.size || sha256 !== asset.binarySha256) {
      throw new Error(`Invalid completion resource: ${asset.output} (size/SHA-256 mismatch). Run pnpm fetch:carapace.`);
    }
  }
}

export function checkInstallerListing(listing, assets = manifest.assets) {
  const entries = listing.split(/\r?\n\r?\n/).map((block) => ({
    path: block.match(/^Path = (.+)$/m)?.[1].trim().replaceAll('\\', '/'),
    size: Number(block.match(/^Size = (\d+)\r?$/m)?.[1]),
  }));
  for (const asset of assets) {
    const matches = entries.filter((entry) => entry.path === `bin/${asset.output}`);
    if (matches.length !== 1 || matches[0].size !== asset.size) {
      throw new Error(`Installer missing or invalid completion resource: bin/${asset.output}`);
    }
  }
}

export function main(args) {
  if (args.length === 1 && args[0] === '--built-installer') {
    const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    args = ['--installer', join(root, `src-tauri/target/release/bundle/nsis/${config.productName}_${config.version}_x64-setup.exe`)];
  }
  if (args.length === 1 && args[0] === '--resources') {
    checkResources(join(root, 'src-tauri/bin'));
  } else if (args.length === 2 && args[0] === '--installer') {
    const installer = resolve(args[1]);
    if (!existsSync(installer)) throw new Error(`Installer not found: ${installer}`);
    const installed7z = join(process.env.ProgramFiles || 'C:/Program Files', '7-Zip/7z.exe');
    const result = spawnSync(existsSync(installed7z) ? installed7z : '7z', ['l', '-slt', '--', installer], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error(`Cannot inspect installer with 7-Zip: ${result.error?.message || result.stderr}`);
    checkInstallerListing(result.stdout);
  } else {
    throw new Error('Usage: check-carapace.mjs --resources | --built-installer | --installer <NSIS.exe>');
  }
  console.info('Completion resource check passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
