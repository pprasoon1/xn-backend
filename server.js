const http = require('http');
const express = require('express');
const fs = require('fs');
const { Server } = require('socket.io');
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const cors = require('cors');
const chokidar = require('chokidar');
const { exec } = require('child_process');

// Express and Socket.IO setup
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true
    }
});
app.use(cors());
app.use(express.json());

// Store PTY instances and container names
const userTerminals = new Map();
const userContainers = new Map();

// Ensure user directory exists
function ensureUserDirectoryExists(userId) {
    const userDir = path.join(__dirname, 'users', userId);
    if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
    }
    return userDir;
}

// Start Docker container
function startContainer(userId, projectPath) {
    const containerName = `user_${userId}`;
    const resolvedPath = path.resolve(projectPath);
    const command = `docker run -d --rm --name ${containerName} -v "${resolvedPath}:/app" -w /app node:latest tail -f /dev/null`;

    return new Promise((resolve, reject) => {
        exec(command, (err, stdout) => {
            if (err) return reject(err);
            userContainers.set(userId, containerName);
            resolve(containerName);
        });
    });
}

// Stop Docker container
function stopContainer(containerName) {
    return new Promise((resolve, reject) => {
        exec(`docker stop ${containerName}`, (err, stdout) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// Initialize PTY connected to container
function initializePty(userId, containerName) {
    const term = pty.spawn('docker', [
        'exec', '-i', containerName, 'bash', '-l'
    ], {
        name: 'xterm-256color',
        cols: 80,
        rows: 30,
        cwd: '/app',
        env: process.env
    });

    term.on('data', (data) => {
        const socket = io.sockets.sockets.get(userId);
        socket?.emit('terminal:data', data);
    });

    term.on('exit', () => {
        userTerminals.delete(userId);
        stopContainer(containerName).catch(console.error);
    });

    userTerminals.set(userId, term);
    return term;
}

// File watcher
const watcher = chokidar.watch(path.join(__dirname, 'users'), {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true
});

watcher.on('all', (event, filePath) => {
    const userId = filePath.split(path.sep)[2];
    const relativePath = path.relative(path.join(__dirname, 'users', userId), filePath);
    io.to(userId).emit('file:refresh', { event, path: relativePath });
});

// Socket.IO connection handler
io.on('connection', async (socket) => {
    const userId = socket.id;
    console.log('New connection:', userId);

    try {
        const userDir = ensureUserDirectoryExists(userId);
        const containerName = await startContainer(userId, userDir);
        initializePty(userId, containerName);

        socket.on('terminal:write', (data) => {
            const term = userTerminals.get(userId);
            term?.write(data);
        });

        socket.on('terminal:resize', ({ cols, rows }) => {
            const term = userTerminals.get(userId);
            term?.resize(cols, rows);
        });

        socket.on('file:change', async ({ path: filePath, content }) => {
            const fullPath = path.join(userDir, filePath);
            await fs.promises.writeFile(fullPath, content);
        });

        socket.on('disconnect', async () => {
            const term = userTerminals.get(userId);
            const container = userContainers.get(userId);
            term?.kill();
            if (container) await stopContainer(container);
            userTerminals.delete(userId);
            userContainers.delete(userId);
        });
    } catch (error) {
        console.error('Connection error:', error);
        socket.emit('error', 'Failed to initialize environment');
        socket.disconnect();
    }
});

// File API endpoints
app.get('/files', async (req, res) => {
    try {
        const userId = req.query.userId;
        const userDir = path.join(__dirname, 'users', userId);
        const tree = await generateFileTree(userDir);
        res.json({ tree });
    } catch (error) {
        res.status(500).json({ error: 'Failed to read files' });
    }
});

app.get('/files/content', async (req, res) => {
    try {
        const userId = req.query.userId;
        const filePath = req.query.path;
        const fullPath = path.join(__dirname, 'users', userId, filePath);
        const content = await fs.promises.readFile(fullPath, 'utf8');
        res.json({ content });
    } catch (error) {
        res.status(500).json({ error: 'Failed to read file' });
    }
});

async function generateFileTree(dir) {
    const stats = await fs.promises.stat(dir);
    if (!stats.isDirectory()) return null;
    
    const children = await fs.promises.readdir(dir);
    return Promise.all(children.map(async (child) => {
        const childPath = path.join(dir, child);
        const stats = await fs.promises.stat(childPath);
        return {
            name: child,
            isDirectory: stats.isDirectory(),
            children: stats.isDirectory() ? await generateFileTree(childPath) : null
        };
    }));
}

server.listen(9000, () => console.log('Server running on port 9000'));
