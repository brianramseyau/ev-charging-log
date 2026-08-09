// Electron main process for the desktop build. Boots the existing adapter-node
// production build (build/index.js) as a local child process, then points a
// BrowserWindow at it — see PLAN.md §11 for the full rationale.
const { app, BrowserWindow, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { fork } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

let serverProcess = null;
let mainWindow = null;
let serverPort = null;

// Packaged builds get this from productName/Info.plist automatically, but
// `electron .` (electron:dev) falls back to package.json's npm `name`
// ("ev-charging-log") for the dock/menu-bar name unless set explicitly.
app.setName('EV Charging Log');

// Defaults to a per-app-data SQLite file (separate from any Docker deployment).
// To point this build at an existing database instead — e.g. a Docker
// deployment's file shared over a network mount — create
// `<userData>/config.json` with `{ "databasePath": "/path/to/db" }` before
// first launch. See README's "Desktop app (Electron)" section.
function resolveDatabasePath() {
	const userDataDir = app.getPath('userData');
	const configPath = path.join(userDataDir, 'config.json');
	if (fs.existsSync(configPath)) {
		try {
			const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
			if (config.databasePath) {
				return config.databasePath;
			}
		} catch (err) {
			console.error(`Failed to read ${configPath}, using default database path:`, err);
		}
	}
	return path.join(userDataDir, 'ev-charging-log.db');
}

function getFreePort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.unref();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

// build/index.js doesn't emit a ready signal, so poll the port until it accepts
// connections instead of relying on an IPC message.
function waitForServer(port, timeoutMs, hasExited) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const tryConnect = () => {
			if (hasExited()) {
				reject(new Error('Server process exited before it started listening'));
				return;
			}
			const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
				socket.end();
				resolve();
			});
			socket.on('error', () => {
				socket.destroy();
				if (Date.now() > deadline) {
					reject(new Error(`Server did not start listening on port ${port} in time`));
				} else {
					setTimeout(tryConnect, 200);
				}
			});
		};
		tryConnect();
	});
}

async function startServer() {
	const port = await getFreePort();
	const dbPath = resolveDatabasePath();

	// ELECTRON_RUN_AS_NODE makes Electron's own bundled executable behave as a
	// plain Node runtime, so the packaged app has no external Node dependency.
	serverProcess = fork(path.join(__dirname, '..', 'build', 'index.js'), [], {
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: '1',
			NODE_ENV: 'production',
			DATABASE_URL: dbPath,
			// drizzle's migrator resolves this against cwd by default, which
			// would be Electron's own cwd (often "/" when launched from
			// Finder) since fork()'s `cwd` option can't be set to a path
			// inside app.asar — that's a real OS chdir, and asar is a virtual
			// archive, not a real directory. Passing an absolute path instead
			// works fine, since ordinary fs reads (unlike chdir/spawn) are
			// transparently patched to work inside asar.
			MIGRATIONS_FOLDER: path.join(__dirname, '..', 'drizzle'),
			PORT: String(port),
			HOST: '127.0.0.1',
			// adapter-node's CSRF check rejects form actions unless it knows its
			// own origin — without this it can't tell, since there's no reverse
			// proxy here to supply Host/X-Forwarded-* headers.
			ORIGIN: `http://127.0.0.1:${port}`
		},
		// Piped (rather than 'inherit') so output is captured here — a GUI
		// launch has no terminal to inherit into, so this was the only way to
		// see why the server failed to start.
		stdio: ['ignore', 'pipe', 'pipe', 'ipc']
	});

	let output = '';
	const captureOutput = (chunk) => {
		output += chunk.toString();
	};
	serverProcess.stdout.on('data', captureOutput);
	serverProcess.stderr.on('data', captureOutput);

	let exited = false;
	serverProcess.on('exit', (code, signal) => {
		exited = true;
		serverProcess = null;
		if (code !== 0 && code !== null) {
			console.error(`Server process exited unexpectedly (code=${code}, signal=${signal})`);
		}
	});

	try {
		await waitForServer(port, 15000, () => exited);
	} catch (err) {
		throw new Error(`${err.message}${output ? `\n\nServer output:\n${output}` : ''}`, {
			cause: err
		});
	}
	return port;
}

function createWindow(port) {
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 800,
		title: 'EV Charging Log',
		// Packaged builds already get this from icon.icns/.ico via
		// electron-builder; set explicitly too so `electron:dev` (unpackaged,
		// no bundle icon) shows the real icon instead of Electron's default.
		icon: path.join(__dirname, 'resources', 'icon.png')
	});
	mainWindow.loadURL(`http://127.0.0.1:${port}`);
	mainWindow.on('closed', () => {
		mainWindow = null;
	});
}

app
	.whenReady()
	.then(async () => {
		// On macOS, BrowserWindow's `icon` option doesn't affect the Dock icon —
		// only relevant in dev, since packaged builds already get it from the
		// .icns/Info.plist.
		if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
			app.dock.setIcon(path.join(__dirname, 'resources', 'icon.png'));
		}

		serverPort = await startServer();
		createWindow(serverPort);

		app.on('activate', () => {
			if (mainWindow === null && serverPort !== null) {
				createWindow(serverPort);
			}
		});

		// Reads GitHub Releases via the `publish` config electron-builder bakes
		// into app-update.yml at package time — no-op in dev (unpackaged) builds.
		if (app.isPackaged) {
			autoUpdater.checkForUpdatesAndNotify().catch((err) => {
				console.error('Auto-update check failed:', err);
			});
		}
	})
	.catch((err) => {
		console.error('Failed to start:', err);
		dialog.showErrorBox('EV Charging Log failed to start', err.stack || String(err));
		app.quit();
	});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('before-quit', () => {
	if (serverProcess) {
		serverProcess.kill();
		serverProcess = null;
	}
});
