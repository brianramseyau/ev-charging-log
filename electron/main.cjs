// Electron main process for the desktop build. Boots the existing adapter-node
// production build (build/index.js) as a local child process, then points a
// BrowserWindow at it — see PLAN.md §11 for the full rationale.
const { app, BrowserWindow } = require('electron');
const { fork } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

let serverProcess = null;
let mainWindow = null;
let serverPort = null;

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
function waitForServer(port, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const tryConnect = () => {
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
	const dbPath = path.join(app.getPath('userData'), 'ev-charging-log.db');

	// ELECTRON_RUN_AS_NODE makes Electron's own bundled executable behave as a
	// plain Node runtime, so the packaged app has no external Node dependency.
	serverProcess = fork(path.join(__dirname, '..', 'build', 'index.js'), [], {
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: '1',
			NODE_ENV: 'production',
			DATABASE_URL: dbPath,
			PORT: String(port),
			HOST: '127.0.0.1'
		},
		stdio: 'inherit'
	});

	serverProcess.on('exit', (code, signal) => {
		serverProcess = null;
		if (code !== 0 && code !== null) {
			console.error(`Server process exited unexpectedly (code=${code}, signal=${signal})`);
		}
	});

	await waitForServer(port);
	return port;
}

function createWindow(port) {
	mainWindow = new BrowserWindow({
		width: 1280,
		height: 800,
		title: 'EV Charging Log'
	});
	mainWindow.loadURL(`http://127.0.0.1:${port}`);
	mainWindow.on('closed', () => {
		mainWindow = null;
	});
}

app.whenReady().then(async () => {
	serverPort = await startServer();
	createWindow(serverPort);

	app.on('activate', () => {
		if (mainWindow === null && serverPort !== null) {
			createWindow(serverPort);
		}
	});
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
