import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInstallerListing, checkResources, main, manifest } from './check-carapace.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const binaries = ['windows-binary', 'linux-binary'];
const assets = binaries.map((data, index) => ({
  output: index === 0 ? 'carapace.exe' : 'carapace-linux-amd64',
  size: Buffer.byteLength(data),
  binarySha256: createHash('sha256').update(data).digest('hex'),
}));
const listing = assets.map((asset) => `Path = bin\\${asset.output}\nSize = ${asset.size}`).join('\n\n');

function withResources(run) {
  const dir = mkdtempSync(join(tmpdir(), 'tdsf-carapace-test-'));
  try {
    assets.forEach((asset, index) => writeFileSync(join(dir, asset.output), binaries[index]));
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('accepts both verified binaries and is idempotent', () => {
  withResources((dir) => {
    checkResources(dir, assets);
    checkResources(dir, assets);
  });
});

test('rejects a missing binary even when other resources are present', () => {
  withResources((dir) => {
    rmSync(join(dir, assets[1].output));
    assert.throws(() => checkResources(dir, assets), /Missing completion resource.*linux/);
  });
});

test('rejects wrong size and same-size wrong hash', () => {
  withResources((dir) => {
    writeFileSync(join(dir, assets[0].output), 'short');
    assert.throws(() => checkResources(dir, assets), /size\/SHA-256 mismatch/);
    writeFileSync(join(dir, assets[0].output), 'x'.repeat(assets[0].size));
    assert.throws(() => checkResources(dir, assets), /size\/SHA-256 mismatch/);
  });
});

test('accepts Windows and Unix listing paths with CRLF or LF', () => {
  checkInstallerListing(listing, assets);
  checkInstallerListing(listing.replaceAll('\\', '/').replaceAll('\n', '\r\n'), assets);
});

test('rejects metadata-only installer, wrong directory, size, or duplicate binaries', () => {
  assert.throws(() => checkInstallerListing('Path = bin\\CHECKSUMS.txt\nSize = 900', assets), /Installer missing/);
  assert.throws(() => checkInstallerListing(listing.replace('bin\\carapace.exe', 'other\\carapace.exe'), assets), /Installer missing/);
  assert.throws(() => checkInstallerListing(listing.replace(`Size = ${assets[0].size}`, 'Size = 0'), assets), /Installer missing/);
  assert.throws(() => checkInstallerListing(`${listing}\n\n${listing}`, assets), /Installer missing/);
});

test('invalid arguments and nonexistent installer fail closed', () => {
  for (const args of [[], ['--typo'], ['--resources', 'extra'], ['--installer']]) {
    assert.throws(() => main(args), /Usage:/);
  }
  assert.throws(() => main(['--installer', join(root, 'missing-installer.exe')]), /Installer not found/);
});

test('build and CI require restore, resource check and actual installer inspection', () => {
  const pkg = JSON.parse(read('package.json'));
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  const workflow = read('.github/workflows/release-windows.yml');
  assert.match(pkg.scripts['build:win'], /fetch:carapace.*check:carapace.*tauri build.*check-carapace\.mjs --built-installer/);
  assert.match(config.build.beforeBuildCommand, /^pnpm check:carapace &&/);
  assert.match(workflow, /pnpm fetch:carapace[\s\S]*pnpm check:carapace[\s\S]*pnpm test:carapace/);
  assert.match(workflow, /check-carapace\.mjs --installer \$installer.FullName/);
  assert.match(workflow, /releaseDraft: true/);
  assert.match(read('.github/workflows/ci.yml'), /run: pnpm test:carapace/);
});

test('manifest distinguishes pinned archive hashes from extracted binary hashes', () => {
  assert.equal(manifest.version, '1.7.3');
  assert.deepEqual(manifest.assets.map((asset) => asset.output), ['carapace.exe', 'carapace-linux-amd64']);
  for (const asset of manifest.assets) {
    assert.match(asset.archiveSha256, /^[a-f0-9]{64}$/);
    assert.match(asset.binarySha256, /^[a-f0-9]{64}$/);
    assert.notEqual(asset.archiveSha256, asset.binarySha256);
    assert.ok(asset.size > 0);
    assert.ok(read('src-tauri/bin/CHECKSUMS.txt').includes(asset.output));
  }
  const fetch = read('scripts/fetch-carapace.ps1');
  assert.match(fetch, /\$output -Algorithm SHA256\)\.Hash.ToLowerInvariant\(\) -eq \$asset.binarySha256/);
  assert.match(fetch, /\$archive -Algorithm SHA256\)\.Hash.ToLowerInvariant\(\) -ne \$asset.archiveSha256/);
  assert.match(fetch, /\$binary -Algorithm SHA256\)\.Hash.ToLowerInvariant\(\) -ne \$asset.binarySha256/);
  assert.doesNotMatch(fetch, /gh-proxy/);
  assert.doesNotMatch(fetch, /[^\x00-\x7f]/);
});
