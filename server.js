const http = require('http');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const pty = require('node-pty');
const cors = require('cors');
const chokidar = require('chokidar');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Configuration
const USER_DIR = path.join(__dirname, 'users');
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

app.use(cors());
app.use(express.json());

// Store active sessions
const userTerminals = new Map();
const userContainers = new Map();

// Helpers
const ensureUserDir = (userId) => {
  const userDir = path.join(USER_DIR, userId);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
    fs.chmodSync(userDir, 0o755);
    log('debug', `Created user directory: ${userDir}`);
  }
  return userDir;
};

const log = (level, message) => {
  if (LOG_LEVEL === 'debug' || level === 'error') {
    console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
  }
};

// Docker management
const startContainer = async (userId, projectPath) => {
  const containerName = `user_${userId}`;
  const resolvedPath = path.resolve(projectPath);
  const command = `docker run -d --rm --name ${containerName} -v "${resolvedPath}:/app" -w /app node:latest tail -f /dev/null`;

  return new Promise((resolve, reject) => {
    exec(command, (err, stdout) => {
      if (err) return reject(err);
      userContainers.set(userId, containerName);
      log('info', `Container started: ${containerName}`);
      resolve(containerName);
    });
  });
};

const stopContainer = async (containerName) => {
  return new Promise((resolve, reject) => {
    exec(`docker stop ${containerName}`, (err) => {
      if (err) return reject(err);
      log('info', `Container stopped: ${containerName}`);
      resolve();
    });
  });
};

// Terminal management
const createPty = (userId, containerName) => {
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
    log('info', `Terminal closed for user: ${userId}`);
    userTerminals.delete(userId);
    stopContainer(containerName).catch(err => 
      log('error', `Container cleanup error: ${err.message}`)
    );
  });

  userTerminals.set(userId, term);
  return term;
};

// File system watcher
const watcher = chokidar.watch(USER_DIR, {
  ignored: /(^|[\/\\])\../,
  persistent: true,
  ignoreInitial: true
});

watcher.on('all', (event, filePath) => {
  const segments = filePath.split(path.sep);
  const userId = segments[segments.indexOf('users') + 1];
  const relativePath = path.relative(path.join(USER_DIR, userId), filePath);
  
  if (userId && relativePath) {
    io.to(userId).emit('file:refresh', { 
      event, 
      path: `/${relativePath.replace(/\\/g, '/')}` 
    });
  }
});

// WebSocket connections
io.on('connection', async (socket) => {
  const userId = socket.id;
  log('info', `New connection: ${userId}`);

  try {
    const userDir = ensureUserDir(userId);
    const containerName = await startContainer(userId, userDir);
    createPty(userId, containerName);

    socket.on('terminal:write', (data) => {
      userTerminals.get(userId)?.write(data);
    });

    socket.on('terminal:resize', ({ cols, rows }) => {
      userTerminals.get(userId)?.resize(cols, rows);
    });

    socket.on('file:change', async ({ path: filePath, content }) => {
      const fullPath = path.join(userDir, filePath);
      await fs.promises.writeFile(fullPath, content);
      log('debug', `File updated: ${filePath}`);
    });

    socket.on('disconnect', async () => {
      log('info', `Disconnected: ${userId}`);
      const term = userTerminals.get(userId);
      const container = userContainers.get(userId);
      term?.kill();
      if (container) await stopContainer(container);
      userTerminals.delete(userId);
      userContainers.delete(userId);
    });

  } catch (error) {
    log('error', `Connection error: ${error.message}`);
    socket.emit('error', { 
      status: 'error',
      code: 'INIT_FAILURE',
      message: 'Failed to initialize environment'
    });
    socket.disconnect();
  }
});

// API Endpoints
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/files', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) {
      return res.status(400).json({
        status: 'error',
        code: 'MISSING_USER_ID',
        message: 'User ID is required'
      });
    }

    const userDir = path.join(USER_DIR, userId);
    ensureUserDir(userId);

    const tree = await generateFileTree(userDir);
    
    res.json({
      status: 'success',
      data: {
        path: '/',
        name: 'root',
        isDirectory: true,
        children: tree
      }
    });

  } catch (error) {
    log('error', `Files endpoint error: ${error.message}`);
    res.status(500).json({
      status: 'error',
      code: 'FILE_SYSTEM_ERROR',
      message: 'Failed to read file structure',
      ...(LOG_LEVEL === 'debug' && { debug: error.message })
    });
  }
});

app.get('/files/content', async (req, res) => {
  try {
    const { userId, path: filePath } = req.query;
    if (!userId || !filePath) {
      return res.status(400).json({
        status: 'error',
        code: 'MISSING_PARAMETERS',
        message: 'Both userId and path are required'
      });
    }

    const fullPath = path.join(USER_DIR, userId, filePath);
    const content = await fs.promises.readFile(fullPath, 'utf8');
    
    res.json({
      status: 'success',
      data: { 
        content,
        metadata: {
          path: filePath,
          size: content.length,
          modified: (await fs.promises.stat(fullPath)).mtime.toISOString()
        }
      }
    });

  } catch (error) {
    log('error', `File content error: ${error.message}`);
    const statusCode = error.code === 'ENOENT' ? 404 : 500;
    res.status(statusCode).json({
      status: 'error',
      code: error.code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'READ_ERROR',
      message: error.code === 'ENOENT' ? 'File not found' : 'Failed to read file'
    });
  }
});

// File tree generator
async function generateFileTree(dir) {
  try {
    const stats = await fs.promises.stat(dir);
    if (!stats.isDirectory()) return [];

    const children = await fs.promises.readdir(dir);
    const filtered = children.filter(child => !child.startsWith('.'));

    const tree = await Promise.all(filtered.map(async (child) => {
      try {
        const childPath = path.join(dir, child);
        const stats = await fs.promises.stat(childPath);
        
        return {
          path: path.relative(USER_DIR, childPath),
          name: child,
          isDirectory: stats.isDirectory(),
          children: stats.isDirectory() ? await generateFileTree(childPath) : null
        };
      } catch (error) {
        log('debug', `Skipping invalid entry: ${child}`);
        return null;
      }
    }));

    return tree.filter(Boolean);

  } catch (error) {
    log('error', `File tree error: ${error.message}`);
    return [];
  }
}

server.listen(9000, () => {
  log('info', 'Server started on port 9000');
  if (!fs.existsSync(USER_DIR)) {
    fs.mkdirSync(USER_DIR, { recursive: true });
  }
});
