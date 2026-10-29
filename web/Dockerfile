# Kaly Ops (Next.js) dalam Docker — untuk menjalankan staging/production di server sendiri.
# Build dari folder induk repository:  docker build -f web/Dockerfile -t kaly-ops --build-arg NEXT_PUBLIC_SUPABASE_URL=... --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... .
FROM node:22-alpine AS build
WORKDIR /repo
COPY app ./app
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY web ./web
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG KALY_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1 KALY_STANDALONE=1 NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY KALY_ENV=$KALY_ENV
RUN cd web && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /repo/web/.next/standalone ./
COPY --from=build /repo/web/.next/static ./.next/static
COPY --from=build /repo/web/public ./public
USER node
EXPOSE 3000
# KALY_PUSH_SECRET & NEXT_PUBLIC_SUPABASE_* (untuk API) diisi saat menjalankan container
CMD ["node", "server.js"]
