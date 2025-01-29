FROM node:18-bullseye

# Install Docker CLI
RUN apt-get update && \
    apt-get install -y \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    lsb-release && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y docker-ce-cli

# Configure environment
WORKDIR /app
COPY package*.json ./
RUN npm install --production && \
    npm cache clean --force

# Create user directory and set permissions
RUN mkdir -p /app/users && \
    chown -R node:node /app/users && \
    chmod -R 755 /app/users

COPY . .

USER node
EXPOSE 9000

CMD ["node", "server.js"]
