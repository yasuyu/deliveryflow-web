FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl gosu \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
RUN mkdir -p node_modules/prisma/engines \
    && chown -R node:node node_modules/prisma/engines

COPY --chown=node:node prisma ./prisma
COPY --chown=node:node prisma.config.ts ./
RUN DATABASE_URL=file:./build.db node node_modules/prisma/build/index.js generate
RUN DATABASE_PROVIDER=postgresql \
    DATABASE_URL=postgresql://build:build@localhost:5432/build \
    node node_modules/prisma/build/index.js generate

COPY --chown=node:node server.js ./
COPY --chown=node:node score-bonuses.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node docs ./docs
COPY docker-entrypoint.sh ./

RUN mkdir /data && chown node:node /data
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PROVIDER=sqlite
ENV DATABASE_URL=file:/data/delivery.db
ENV OFFER_TTL_SECONDS=120

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node server.js"]
