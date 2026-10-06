FROM node:20-slim

# Chromium del propio sistema (apt), en vez de que Puppeteer descargue el suyo: evita el problema de que la
# descarga no sobreviva entre el contenedor de construcción y el de ejecución en plataformas tipo Render.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
