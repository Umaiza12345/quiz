# Dockerfile — use this exact contents
FROM mcr.microsoft.com/playwright:v1.57.0-focal

WORKDIR /app

# copy package files first to leverage cache
COPY package*.json ./
RUN npm ci

# copy app source
COPY . .

# ensure Playwright installs the browser binaries and system deps
RUN npx playwright install --with-deps

# optional: default PORT environment (Render will override with its $PORT)
ENV PORT=3000
EXPOSE 3000

# start command — keep as node server.js (change to ["npm","start"] if you use npm start)
CMD ["node", "server.js"]
