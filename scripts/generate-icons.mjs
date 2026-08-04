// Rasterizes the master logo SVG into the PWA icon set + favicon.
// Run via `npm run icons:generate` (also part of `npm run assets:generate`).
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const logoPath = join(root, 'src/lib/assets/logo.svg');
const outDir = join(root, 'static/icons');
// Separate from adapter-node's `build/` output dir, which electron-builder's
// default `directories.buildResources` ("build") would otherwise collide
// with — see the `buildResources` override in package.json's `build` config.
const electronOutDir = join(root, 'electron/resources');

const sizes = [
	{ name: 'favicon-32.png', size: 32 },
	{ name: 'favicon-16.png', size: 16 },
	{ name: 'icon-192.png', size: 192 },
	{ name: 'icon-512.png', size: 512 },
	// Maskable icons keep the logo inside the ~80% "safe zone" that platforms
	// may crop to a circle/squircle, so pad the artwork instead of filling the canvas.
	{ name: 'icon-maskable-192.png', size: 192, maskable: true },
	{ name: 'icon-maskable-512.png', size: 512, maskable: true },
	// 1024px source electron-builder rasterizes into .icns/.ico/Linux PNG set.
	{ name: 'icon.png', size: 1024, outDir: electronOutDir }
];

async function main() {
	await mkdir(outDir, { recursive: true });
	await mkdir(electronOutDir, { recursive: true });
	const svg = await readFile(logoPath);

	for (const { name, size, maskable, outDir: targetDir = outDir } of sizes) {
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

		const dest = join(targetDir, name);
		await image.png().toFile(dest);
		console.log(`wrote ${dest.replace(root + '/', '')}`);
	}
}

main();
