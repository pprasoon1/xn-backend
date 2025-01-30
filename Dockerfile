# Use a specific Node.js LTS version
FROM node:18

# Install build essentials
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /user

# Copy package files
COPY package*.json ./

# Install dependencies and rebuild node-pty
RUN npm install
RUN npm rebuild node-pty

# Copy rest of the application
COPY . .

# Expose the port the app runs on
EXPOSE 9000

# Start the application
CMD ["node", "server.js"]
