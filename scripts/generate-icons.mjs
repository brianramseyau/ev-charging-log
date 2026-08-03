// Rasterizes the master logo SVG into the PWA icon set + favicon.
// Run via `npm run icons:generate` (also part of `npm run assets:generate`).
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const logoPath = join(root, 'src/lib/assets/logo.svg');
const outDir = join(root, 'static/icons');

const sizes = [
	{ name: 'favicon-32.png', size: 32 },
	{ name: 'favicon-16.png', size: 16 },
	{ name: 'icon-192.png', size: 192 },
	{ name: 'icon-512.png', size: 512 },
	// Maskable icons keep the logo inside the ~80% "safe zone" that platforms
	// may crop to a circle/squircle, so pad the artwork instead of filling the canvas.
	{ name: 'icon-maskable-192.png', size: 192, maskable: true },
	{ name: 'icon-maskable-512.png', size: 512, maskable: true }
];

async function main() {
	await mkdir(outDir, { recursive: true });
	const svg = await readFile(logoPath);

	for (const { name, size, maskable } of sizes) {
		const image = maskable
			? sharp(svg)
					.resize(Math.round(size * 0.8), Math.round(size * 0.8))
					.extend({
						top: Math.round(size * 0.1),
						bottom: Math.round(size * 0.1),
						left: Math.round(size * 0.1),
						right: Math.round(size * 0.1),
						background: { r: 15, g: 118, b: 110, alpha: 1 } // matches logo bg gradient start
					})
			: sharp(svg).resize(size, size);

		await image.png().toFile(join(outDir, name));
		console.log(`wrote static/icons/${name}`);
	}
}

main();
