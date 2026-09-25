FROM node:24-bookworm-slim AS test
WORKDIR /app
COPY package.json server.mjs zip.mjs app.js index.html style.css server.test.mjs docker-entrypoint.mjs docker-entrypoint.test.mjs ./
RUN node --check app.js && node --test server.test.mjs docker-entrypoint.test.mjs

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=4317 DATA_DIR=/var/lib/publisher-exit
WORKDIR /app
RUN mkdir -p /var/lib/publisher-exit && chown node:node /var/lib/publisher-exit
COPY --from=test --chown=node:node /app/package.json /app/server.mjs /app/zip.mjs /app/app.js /app/index.html /app/style.css /app/docker-entrypoint.mjs ./
USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:4317/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "docker-entrypoint.mjs"]
