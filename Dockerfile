FROM oven/bun:1.2.5

WORKDIR /app
COPY package.json bun.lock package-lock.json ./
RUN bun install --frozen-lockfile
COPY . .

EXPOSE 3000
CMD ["bun", "src/main.ts"]
