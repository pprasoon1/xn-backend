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

// Shell configuration
const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

// Express and Socket.IO setup
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*', // Allow all origins for simplicity; replace with your frontend domain in production
        methods: ['GET', 'POST'],
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization'],
    }
});
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
    res.status(200).send('Server is running');
});

// Store PTY instances and container names
const userTerminals = new Map();
const userContainers = new Map();

// Ensure user directory exists
function ensureUserDirectoryExists(userId) {
    const userDir = path.join(__dirname, 'users', userId);
    if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
        console.log(`Created user directory: ${userDir}`);
        // Create an initial file
        const initialFilePath = path.join(userDir, 'index.js');
        if (!fs.existsSync(initialFilePath)) {
            fs.writeFileSync(initialFilePath, 'console.log("Hello, World!");');
            console.log(`Created initial file: ${initialFilePath}`);
        }
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
            if (err) {
                console.error(`Error starting container for user ${userId}:`, err);
                reject(err);
            } else {
                console.log(`Container started for user ${userId}: ${stdout.trim()}`);
                userContainers.set(userId, containerName);
                resolve(containerName);
            }
        });
    });
}

// Stop Docker container
function stopContainer(containerName) {
    return new Promise((resolve, reject) => {
        exec(`docker stop ${containerName}`, (err, stdout) => {
            if (err) {
                console.error(`Error stopping container ${containerName}:`, err);
                reject(err);
            } else {
                console.log(`Container ${containerName} stopped.`);
                resolve(stdout.trim());
            }
        });
    });
}

// Initialize PTY connected to container
function initializePty(userId, containerName) {
    const term = pty.spawn('docker', [
        'exec', '-i', containerName, 'bash', '-l'
    ], {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: '/app',
        env: process.env
    });
    userTerminals.set(userId, term);
    term.on('data', (data) => {
        const socket = io.sockets.sockets.get(userId);
        if (socket) {
            socket.emit('terminal:data', data);
        }
    });
    term.on('exit', (code) => {
        console.log(`Terminal exited with code ${code} for user ${userId}`);
        const term = userTerminals.get(userId);
        if (term) {
            term.destroy();
        }
        userTerminals.delete(userId);
    });
    term.on('error', (err) => {
        console.error(`Terminal error for user ${userId}:`, err);
        const term = userTerminals.get(userId);
        if (term) {
            term.destroy();
        }
        userTerminals.delete(userId);
    });
    return term;
}

// Watch for file changes
const watcher = chokidar.watch(path.join(__dirname, 'users'), {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true
});
watcher.on('all', (event, filePath) => {
    console.log(event, filePath);
    const userId = filePath.split(path.sep)[2];
    const relativePath = path.relative(path.join(__dirname, 'users', userId), filePath);
    io.to(userId).emit('file:refresh', { event, path: relativePath });
});

// Socket.IO connection handling
io.on('connection', async (socket) => {
    console.log('New connection:', socket.id);
    const userId = socket.id;
    socket.userId = userId;
    try {
        const userDir = ensureUserDirectoryExists(userId);
        const containerName = await startContainer(userId, userDir);
        initializePty(userId, containerName);
        socket.on('terminal:write', (data) => {
            const term = userTerminals.get(userId);
            if (term) {
                term.write(data);
            }
        });
        socket.on('terminal:resize', ({ cols, rows }) => {
            const term = userTerminals.get(userId);
            if (term) {
                term.resize(cols, rows);
            }
        });
        socket.on('file:change', async ({ path: filePath, content }) => {
            try {
                const normalizedPath = filePath.replace(/^\.\/|^\//, '');
                const fullPath = path.join(__dirname, 'users', userId, normalizedPath);
                await fs.promises.writeFile(fullPath, content, 'utf8');
            } catch (error) {
                console.error('Error writing file:', error);
                socket.emit('error', { message: 'Failed to write file' });
            }
        });
        socket.on('disconnect', async () => {
            console.log('Client disconnected:', userId);
            const term = userTerminals.get(userId);
            const containerName = userContainers.get(userId);
            if (term) {
                term.kill('SIGINT');
                term.destroy();
            }
            userTerminals.delete(userId);
            if (containerName) {
                try {
                    await stopContainer(containerName);
                    userContainers.delete(userId);
                } catch (error) {
                    console.error('Error stopping container:', error);
                }
            }
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
        const userId = req.query.userId; // Ensure you pass userId in the query
        if (!userId) {
            return res.status(400).json({ error: 'User ID query parameter is required' });
        }
        const fileTree = await generateFileTree(path.join(__dirname, 'users', userId));
        if (fileTree === null) {
            console.warn(`Empty file tree for user ${userId}`);
            return res.json({ tree: {} });
        }
        return res.json({ tree: fileTree });
    } catch (error) {
        console.error('Error generating file tree:', error);
        return res.status(500).json({ error: 'Failed to generate file tree' });
    }
});

app.get('/files/content', async (req, res) => {
    try {
        const filePath = req.query.path;
        const userId = req.query.userId; // Ensure you pass userId in the query
        if (!filePath || !userId) {
            return res.status(400).json({ error: 'Path and User ID query parameters are required' });
        }
        const normalizedPath = filePath.replace(/^\.\/|^\//, '');
        const fullPath = path.join(__dirname, 'users', userId, normalizedPath);
        if (!fs.existsSync(fullPath)) {
            return res.status(404).json({ error: 'File not found' });
        }
        const content = await fs.promises.readFile(fullPath, 'utf8');
        return res.json({ content });
    } catch (error) {
        console.error('Error reading file:', error);
        return res.status(500).json({ error: 'Failed to read file' });
    }
});

// Generate file tree recursively
async function generateFileTree(directory) {
    if (!fs.existsSync(directory)) {
        console.log(`Directory does not exist: ${directory}`);
        return null;
    }
    const tree = {};
    async function buildTree(currentDir, currentTree) {
        const files = await fs.promises.readdir(currentDir);
        for (const file of files) {
            const filePath = path.join(currentDir, file);
            const stat = await fs.promises.stat(filePath);
            if (stat.isDirectory()) {
                currentTree[file] = {};
                await buildTree(filePath, currentTree[file]);
            } else {
                currentTree[file] = null;
            }
        }
    }
    await buildTree(directory, tree);
    return tree;
}

// Start the server
server.listen(9000, () => console.log('Server running on port 9000'));
