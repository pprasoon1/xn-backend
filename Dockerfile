FROM node:latest

# Install build essentials
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    build-essential

WORKDIR /user

# Copy package files
COPY package*.json ./

# Install dependencies and rebuild node-pty
RUN npm install
RUN npm rebuild node-pty

# Copy rest of the application
COPY . .

EXPOSE 9000

CMD ["node", "server.js"]