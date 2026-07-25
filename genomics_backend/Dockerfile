FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# Record what this image's site-packages were built from, outside /app so the
# dev bind mount cannot shadow it. docker-entrypoint.sh compares against it.
RUN pip install --no-cache-dir -r requirements.txt \
    && mkdir -p /opt/genomechat \
    && sha256sum requirements.txt | cut -d' ' -f1 > /opt/genomechat/requirements.sha256

# Installed to /usr/local/bin, not /app — the bind mount would otherwise replace
# it with the host copy and its permissions.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

COPY . .

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
