'use strict';
// Build only into a fresh explicitly named directory. Never touches an installed copy.
const fs = require('fs-extra');
const path = require('path');
const rcedit = require('rcedit');
(async () => {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 required');
  const arg = process.argv.indexOf('--output');
  if (arg < 0 || !process.argv[arg + 1]) throw new Error('Usage: npm run build:win -- --output <new directory>');
  const repo = path.resolve(__dirname, '..'), output = path.resolve(process.argv[arg + 1]);
  if (await fs.pathExists(output)) throw new Error('Output already exists; choose a fresh directory');
  const pkg = await fs.readJson(path.join(repo, 'package.json'));
  const lock = await fs.readJson(path.join(repo, 'package-lock.json'));
  if (pkg.version !== lock.version) throw new Error('Package/lock version mismatch');
  const stage = path.join(output, 'stage'), dist = path.join(output, 'dist');
  await fs.ensureDir(stage);
  for (const name of ['main.js', 'preload.js', 'package.json', 'lib', 'renderer', 'scripts', 'build']) {
    await fs.copy(path.join(repo, name), path.join(stage, name));
  }
  // Lockfile identifies production packages, excluding Electron and build tools.
  for (const [name, info] of Object.entries(lock.packages)) {
    if (!name.startsWith('node_modules/') || info.dev) continue;
    const src = path.join(repo, name);
    if (!await fs.pathExists(src)) { if (info.optional) continue; throw new Error('Missing dependency: ' + name); }
    await fs.copy(src, path.join(stage, name));
  }
  const electronExe = require('electron'); // Electron 44 downloads its binary lazily.
  await fs.copy(path.dirname(electronExe), dist);
  await fs.remove(path.join(dist, 'resources/default_app.asar'));
  await fs.move(path.join(dist, 'electron.exe'), path.join(dist, 'Pigeon.exe'));
  await fs.copy(path.join(repo, 'build/pigeon.ico'), path.join(dist, 'resources/pigeon.ico'));
  await rcedit(path.join(dist, 'Pigeon.exe'), {
    icon: path.join(repo, 'build/pigeon.ico'), 'file-version': pkg.version, 'product-version': pkg.version,
    'version-string': { ProductName: 'Pigeon', FileDescription: 'Pigeon 素材管理器', OriginalFilename: 'Pigeon.exe' },
  });
  const asar = await import('@electron/asar');
  await asar.createPackageWithOptions(stage, path.join(dist, 'resources/app.asar'), {unpackDir: 'node_modules/onnxruntime-node'});
  const embedded = JSON.parse(asar.extractFile(path.join(dist, 'resources/app.asar'), 'package.json').toString());
  if (embedded.version !== pkg.version) throw new Error('Embedded version mismatch');
  await fs.copy(path.join(repo, 'extension'), path.join(dist, 'extension'));
  await fs.writeJson(path.join(output, 'build-info.json'), {version: pkg.version, electron: require('electron/package.json').version, dist}, {spaces: 2});
  console.log('BUILD_OK', pkg.version, dist);
})().catch(e => { console.error(e); process.exitCode = 1; });
