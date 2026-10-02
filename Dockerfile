FROM node:24.21.0-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
LABEL org.opencontainers.image.source="https://github.com/elanon1/hackyeah-token-dasboard"
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4318
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:4318/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bin/htm.js", "server", "--host", "0.0.0.0", "--data", "/data"]
