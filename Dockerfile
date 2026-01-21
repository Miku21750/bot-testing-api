# Node LTS (Baileys butuh Node >= 18 recommended)
FROM node:20-slim

# optional tapi berguna (timezone, cert, dll)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Set timezone (optional)
ENV TZ=Asia/Jakarta

# App dir
WORKDIR /app

# Copy package dulu (biar layer cache efisien)
COPY package.json package-lock.json ./

# Install production deps
RUN npm ci --omit=dev

# Copy source
COPY . .

# Expose port
EXPOSE 3333

# Run app
CMD ["node", "server.js"]
