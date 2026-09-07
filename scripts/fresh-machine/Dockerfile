FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash newuser
COPY foreman.tgz /tmp/foreman.tgz
RUN npm install -g /tmp/foreman.tgz 2>&1 | tail -5
USER newuser
WORKDIR /home/newuser
ENV FOREMAN_BIND=all
EXPOSE 4177 4178
CMD ["foreman"]
