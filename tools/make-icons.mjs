// Generate Bayt PNG icons from public/icons/*.svg.
// Run: npm install --prefix "$TEMP/bayt-icons" @resvg/resvg-js
//      RESVG_DIR="$TEMP/bayt-icons" node tools/make-icons.mjs
// (resvg is intentionally NOT a project dependency.)
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.env.RESVG_DIR;
if (!dir) throw new Error('Set RESVG_DIR to the folder where @resvg/resvg-js is installed');
const require = createRequire(join(resolve(dir), 'noop.js'));
const { Resvg } = require('@resvg/resvg-js');

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const jobs = [
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'icon-512.png', 512],
  ['maskable.svg', 'maskable-512.png', 512],
  ['maskable.svg', 'apple-touch-icon.png', 180],
];
for (const [src, dest, size] of jobs) {
  const svg = readFileSync(join(out, src));
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(join(out, dest), png);
  console.log(dest, size, png.length + ' bytes');
}
