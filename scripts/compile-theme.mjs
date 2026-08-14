// Replaces the `smui-theme compile` CLI so we can pass `quietDeps: true` to
// Sass, silencing deprecation warnings from SMUI's own .scss (a dependency
// we don't control) while still surfacing any from our own src/theme files.
// Mirrors node_modules/smui-theme/bin/index.js's `compile` command.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as sass from 'sass';

const [output, ...rest] = process.argv.slice(2).filter((arg) => arg !== '-i');
if (!output) {
	console.error('Usage: compile-theme.mjs <output> [-i <includePath> ...]');
	process.exit(1);
}
const includes = rest;

if (!fs.existsSync(path.dirname(output))) {
	console.error(
		"It looks like the output directory doesn't exist.\n",
		path.dirname(output),
		'\nDid you mean to output the file into another directory?'
	);
	process.exit(1);
}

console.log('Compiling SMUI Styles...');

const smuiThemeDir = path.dirname(
	fileURLToPath(await import.meta.resolve('smui-theme/package.json'))
);

const result = sass.compile(
	path.resolve(smuiThemeDir, includes.length ? '_index.scss' : '_style.scss'),
	{
		importers: [new sass.NodePackageImporter()],
		loadPaths: [
			...includes,
			path.resolve(
				path.dirname(fileURLToPath(await import.meta.resolve('@smui/common/package.json'))),
				'..',
				'..'
			),
			path.resolve(smuiThemeDir, 'fallback')
		],
		style: 'compressed',
		quietDeps: true
	}
);

console.log('Writing CSS to ' + output + '...');
fs.writeFileSync(output, result.css);
