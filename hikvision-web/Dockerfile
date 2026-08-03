FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV PYTHONUNBUFFERED=1
ENV ALPR_PYTHON=python3

WORKDIR /opt/render/project/src

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python-is-python3 \
    libgl1 \
    libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY alpr-service/requirements.txt ./alpr-service/requirements.txt
RUN python3 -m pip install --no-cache-dir --break-system-packages -r alpr-service/requirements.txt
RUN python3 -c "import cv2, onnxruntime; print('python deps ok')"

COPY . .

EXPOSE 10000

CMD ["node", "server.js"]
