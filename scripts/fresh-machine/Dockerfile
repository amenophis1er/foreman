FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
# Chromium's system libraries, as an administrator would install them once.
# Off by default: the slim image is the case where the setup page has to say
# "installed but cannot start". FRESH_BROWSER_DEPS=1 turns it on.
ARG BROWSER_DEPS=0
RUN if [ "$BROWSER_DEPS" = "1" ]; then \
      npx --yes playwright@latest install-deps chromium && rm -rf /var/lib/apt/lists/* /root/.npm; \
    fi
RUN useradd -m -s /bin/bash newuser
COPY foreman.tgz /tmp/foreman.tgz
RUN npm install -g /tmp/foreman.tgz 2>&1 | tail -5
USER newuser
WORKDIR /home/newuser
ENV FOREMAN_BIND=all
EXPOSE 4177 4178
CMD ["foreman"]
