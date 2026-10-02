import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve('facefilter/package.json'));
const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
if (pkg.version !== '3.4.3' || pkg.license !== 'Apache-2.0') {
  throw new Error('Jeeliz assets require official facefilter@3.4.3 (Apache-2.0).');
}
const assets = [
  { filename: 'NN_DEFAULT.json', size: 3756740, sha256: 'f348ce0fb3b30b8cf27e1666bc56de0c6b1f1b8f02cadc4cd5ca53169534b182' },
  { filename: 'NN_4EXPR_3.json', size: 1657334, sha256: '1e628f1fbd838f9cf57a3c62add85bf67280ee5581ccc24799a4ea4bfa24ec61' },
];
const output = join(root, 'public/models/jeeliz');
await mkdir(output, { recursive: true });
for (const asset of assets) {
  const source = join(packageRoot, 'neuralNets', asset.filename);
  const bytes = await readFile(source).catch(() => { throw new Error(`Missing official Jeeliz asset: ${source}. Run pnpm install.`); });
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== asset.size || hash !== asset.sha256 || !JSON.parse(bytes).layers) {
    throw new Error(`Corrupt official Jeeliz asset: ${asset.filename}`);
  }
  const target = join(output, asset.filename);
  const existing = await readFile(target).catch(() => null);
  if (!existing?.equals(bytes)) await writeFile(target, bytes);
  console.log(`Jeeliz ${asset.filename}: ${bytes.length} bytes, SHA-256 verified`);
}
const license = await readFile(join(packageRoot, 'LICENSE'));
const oldLicense = await readFile(join(output, 'LICENSE')).catch(() => null);
if (!oldLicense?.equals(license)) await writeFile(join(output, 'LICENSE'), license);
const manifest = JSON.stringify({
  package: 'facefilter', version: pkg.version, license: pkg.license,
  repository: 'https://github.com/jeeliz/jeelizFaceFilter',
  sourceArchiveUrl: 'https://registry.npmjs.org/facefilter/-/facefilter-3.4.3.tgz',
  assets: assets.map(asset => ({ ...asset, packagePath: `neuralNets/${asset.filename}`, runtimePath: `/models/jeeliz/${asset.filename}` })),
}, null, 2) + '\n';
const oldManifest = await readFile(join(output, 'manifest.json'), 'utf8').catch(() => null);
if (oldManifest !== manifest) await writeFile(join(output, 'manifest.json'), manifest);
