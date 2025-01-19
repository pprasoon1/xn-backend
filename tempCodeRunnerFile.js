const http = require('http');
const express = require('express');
const fs = require('fs');
const { Server } = require('socket.io');
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const cors = require('cors');
const chokidar = require('chokidar');
const { exec } = require("child_process");

// Shell configuration
const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

// Express and Socket.IO setup
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

app.use(cors());
app.use(express.json());

// Store PTY instances and container names for each user
const userTerminals = new Map();
const userContainers = new Map();

// Function to start Docker container
function startContainer(userId, projectPath) {
    const containerName = `user_${userId}`;
    const command = `docker run -d --rm --name ${containerName} -v "${path.resolve(projectPath)}:/app" -w /app user-project-env`;
    
    return new Promise((resolve, reject) => {
        exec(command, (err, stdout, stderr) => {
            if (err) {
                console.error(`Error starting container for user ${userId}:`, err);
                reject(err);
                return;
            }
            console.log(`Container started for user ${userId}: ${stdout}`);
            userContainers.set(userId, containerName);
            resolve(containerName);
        });
    });
}

// Function to stop Docker container
function stopContainer(containerName) {
    return new Promise((resolve, reject) => {
        exec(`docker stop ${containerName}`, (err, stdout, stderr) => {
            if (err) {
                console.error(`Error stopping container ${containerName}:`, err);
                reject(err);
                return;
            }
            console.log(`Container ${containerName} stopped: ${stdout}`);
            resolve(stdout);
        });
    });
}

// Initialize PTY process
function initializePty(userId) {
    const cwd = path.join(__dirname, './user');
    const term = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: cwd,
        env: process.env
    });

    userTerminals.set(userId, term);
    return term;
}

// Watch for file changes
const watcher = chokidar.watch('./user', {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true
});

watcher.on('all', (event, filePath) => {
    console.log(event, filePath);
    io.emit('file:refresh', filePath);
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('🚀 New connection', socket.id);
    
    const userId = socket.id;
    socket.userId = userId;

    // Initialize terminal for user
    const term = initializePty(userId);
    
    term.onData((data) => {
        socket.emit('terminal:data', data);
    });

    socket.emit('file:refresh');

    // Handle file changes
    socket.on('file:change', async ({ path: filePath, content }) => {
        try {
            const normalizedPath = filePath.replace(/^\.\/|^\//, '');
            const fullPath = path.join('./user', normalizedPath);
            await fs.promises.writeFile(fullPath, content);
        } catch (error) {
            console.error('Error writing file:', error);
            socket.emit('error', { message: 'Failed to write file' });
        }
    });

    // Handle terminal input
    socket.on('terminal:write', (data) => {
        const term = userTerminals.get(userId);
        if (!term) {
            console.error('No terminal instance found for user');
            return;
        }
        term.write(data);
    });

    // Handle terminal resize
    socket.on('terminal:resize', ({ cols, rows }) => {
        const term = userTerminals.get(userId);
        if (term) {
            term.resize(cols, rows);
        }
    });

    // Cleanup on disconnect
    socket.on('disconnect', async () => {
        console.log('Client disconnected:', userId);
        const term = userTerminals.get(userId);
        if (term) {
            term.kill();
            userTerminals.delete(userId);
        }

        const containerName = userContainers.get(userId);
        if (containerName) {
            try {
                await stopContainer(containerName);
                userContainers.delete(userId);
            } catch (error) {
                console.error('Error stopping container:', error);
            }
        }
    });
});

// API Routes
app.get('/files', async (req, res) => {
    try {
        const fileTree = await generateFileTree('./user');
        return res.json({ tree: fileTree });
    } catch (error) {
        console.error('Error generating file tree:', error);
        return res.status(500).json({ error: 'Failed to generate file tree' });
    }
});

app.get('/files/content', async (req, res) => {
    try {
        const { path: filePath } = req.query;
        if (!filePath) {
            return res.status(400).json({ error: 'Path query parameter is required' });
        }

        const normalizedPath = filePath.replace(/^\.\/|^\//, '');
        const fullPath = path.join('./user', normalizedPath);
        const content = await fs.promises.readFile(fullPath, 'utf-8');
        return res.json({ content });
    } catch (error) {
        console.error('Error reading file:', error);
        return res.status(500).json({ error: 'Failed to read file', details: error.message });
    }
});

app.post('/start-project', async (req, res) => {
    try {
        const { userId, projectPath } = req.body;
        if (!userId || !projectPath) {
            return res.status(400).json({ error: "Missing userId or projectPath" });
        }

        const containerName = await startContainer(userId, projectPath);
        res.json({ message: "Container started", containerName });
    } catch (error) {
        res.status(500).json({ error: "Failed to start container", details: error.message });
    }
});

app.post("/stop-project", async (req, res) => {
    try {
        const { containerName } = req.body;
        if (!containerName) {
            return res.status(400).json({ error: "Missing containerName" });
        }

        await stopContainer(containerName);
        res.json({ message: "Container stopped" });
    } catch (error) {
        res.status(500).json({ error: "Failed to stop container", details: error.message });
    }
});

// Generate file tree recursively
async function generateFileTree(directory) {
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
server.listen(9000, () => console.log('🐋 Server running on port 9000'));