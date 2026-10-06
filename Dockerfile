# Zero runtime dependencies: plain Node.js built-ins only.
FROM node:22-alpine

# Run as an unprivileged user; the node image ships with the "node" user.
WORKDIR /app

# Copy the application (no npm install needed).
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test

USER node

# Application port. Overridable at runtime; compose wires the host-side
# APP_PORT environment variable into $PORT.
ENV PORT=8080 \
    HOST=0.0.0.0 \
    NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
