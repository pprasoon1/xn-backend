const http = require('http');
const express = require('express');
const fs = require('fs');
const { Server } = require('socket.io');
const pty = require('node-pty');
const path = require('path');
const cors = require('cors');
const chokidar = require('chokidar');
const Docker = require('dockerode');
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

// Configuration
const config = {
  PORT: process.env.PORT || 9000,
  JWT_SECRET: process.env.JWT_SECRET || 'your_secure_secret',
  NODE_ENV: process.env.NODE_ENV || 'development',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'],
  DOCKER_IMAGE: process.env.DOCKER_IMAGE || 'node:18-slim',
  MAX_CONTAINERS: process.env.MAX_CONTAINERS || 10
};

// Initialize Docker client
const docker = new Docker();

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

// Security middleware
app.use(helmet());
app.use(cors({
  origin: config.ALLOWED_ORIGINS,
  methods: ['GET', 'POST'],
  credentials: true
}));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(apiLimiter);

// Authentication middleware
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Store PTY instances and container instances
const userSessions = new Map();

// Secure path validation
const validatePath = (userId, filePath) => {
  const userDir = path.join(__dirname, 'user', userId);
  const resolvedPath = path.resolve(path.join(userDir, filePath));
  return resolvedPath.startsWith(userDir);
};

// Docker container management
async function createContainer(userId) {
  const userDir = path.join(__dirname, 'user', userId);
  
  try {
    return await docker.createContainer({
      Image: config.DOCKER_IMAGE,
      HostConfig: {
        Binds: [`${userDir}:/app:rw`],
        Memory: 512 * 1024 * 1024, // 512MB
        CpuShares: 512,
        SecurityOpt: ['no-new-privileges']
      },
      WorkingDir: '/app',
      Cmd: ['tail', '-f', '/dev/null']
    });
  } catch (err) {
    console.error(`Container creation failed for ${userId}:`, err);
    throw new Error('Container creation failed');
  }
}

// Initialize PTY process with container
async function initializeEnvironment(userId) {
  const userDir = path.join(__dirname, 'user', userId);
  
  try {
    // Create user directory
    await fs.promises.mkdir(userDir, { recursive: true });
    
    // Create Docker container
    const container = await createContainer(userId);
    await container.start();
    
    // Initialize PTY
    const term = pty.spawn('docker', ['exec', '-i', container.id, 'bash'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 30,
      cwd: userDir,
      env: process.env
    });

    // Store session
    userSessions.set(userId, { container, term });
    
    return term;
  } catch (err) {
    console.error(`Environment initialization failed for ${userId}:`, err);
    throw err;
  }
}

// File system watcher
const watcher = chokidar.watch('./user', {
  ignored: /(^|[\/\\])\../,
  persistent: true,
  ignoreInitial: true
});

watcher.on('all', (event, filePath) => {
  io.emit('file:refresh', { event, path: filePath });
});

// Socket.IO connection handling
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));

  jwt.verify(token, config.JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Invalid token'));
    socket.user = decoded;
    next();
  });
});

io.on('connection', async (socket) => {
  const userId = socket.user.userId;
  console.log(`New connection: ${userId}`);

  try {
    const term = await initializeEnvironment(userId);
    
    term.on('data', (data) => {
      socket.emit('terminal:data', data);
    });

    socket.on('terminal:write', (data) => {
      term.write(data);
    });

    socket.on('terminal:resize', ({ cols, rows }) => {
      term.resize(cols, rows);
    });

    socket.on('file:save', async ({ path: filePath, content }, callback) => {
      try {
        if (!validatePath(userId, filePath)) {
          throw new Error('Invalid file path');
        }

        const fullPath = path.join(__dirname, 'user', userId, filePath);
        await fs.promises.writeFile(fullPath, content);
        callback({ status: 'success' });
      } catch (err) {
        console.error('File save error:', err);
        callback({ status: 'error', message: err.message });
      }
    });

    socket.on('disconnect', async () => {
      console.log(`Disconnected: ${userId}`);
      const session = userSessions.get(userId);
      if (session) {
        session.term.kill();
        try {
          await session.container.stop();
          await session.container.remove();
        } catch (err) {
          console.error('Container cleanup error:', err);
        }
        userSessions.delete(userId);
      }
    });

  } catch (err) {
    console.error('Connection setup failed:', err);
    socket.emit('error', { message: 'Initialization failed' });
    socket.disconnect(true);
  }
});

// API Routes
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    containers: userSessions.size,
    maxContainers: config.MAX_CONTAINERS
  });
});

app.get('/files', authenticate, async (req, res) => {
  try {
    const userDir = path.join(__dirname, 'user', req.user.userId);
    const files = await fs.promises.readdir(userDir);
    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: 'File system error' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
server.listen(config.PORT, () => {
  console.log(`Server running in ${config.NODE_ENV} mode on port ${config.PORT}`);
});