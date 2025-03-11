# Stage 1: Builder with build dependencies
FROM node:20-bullseye-slim AS builder

# Install required system dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for security
RUN useradd -m appuser && chown -R appuser:appuser /home/appuser
USER appuser
WORKDIR /user

# Copy package files with proper ownership
COPY --chown=appuser:appuser package*.json ./

# Install dependencies with clean cache
RUN npm ci --include=dev

# Rebuild native modules
RUN npm rebuild node-pty

# Stage 2: Production image
FROM node:20-bullseye-slim

# Security enhancements
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user and directory structure
RUN useradd -m appuser && \
    mkdir -p /user && \
    chown -R appuser:appuser /user

USER appuser
WORKDIR /user

# Copy necessary files from builder
COPY --chown=appuser:appuser --from=builder /user/node_modules ./node_modules
COPY --chown=appuser:appuser . .

# Environment configuration
ENV NODE_ENV=production
ENV PORT=9000
EXPOSE 9000

# Security headers and process management
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]

# Health check
HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl --fail http://localhost:9000/health || exit 1


# # Use a specific Node.js LTS version
# FROM node:18

# # Install build essentials
# RUN apt-get update && apt-get install -y \
#     python3 \
#     make \
#     g++ \
#     build-essential \
#     && rm -rf /var/lib/apt/lists/*

# # Set the working directory
# WORKDIR /user

# # Copy package files
# COPY package*.json ./

# # Install dependencies and rebuild node-pty
# RUN npm install
# RUN npm rebuild node-pty

# # Copy rest of the application
# COPY . .

# # Expose the port the app runs on
# EXPOSE 9000

# # Start the application
# CMD ["node", "server.js"]
