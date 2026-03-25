FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY server.js .

# Don't run as root
USER node

EXPOSE 3001
CMD ["node", "server.js"]
