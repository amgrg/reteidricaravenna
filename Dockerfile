# Serve the static site with Caddy on the port provided by Railway.
FROM caddy:2.8.4-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html /srv/
COPY css /srv/css
COPY js /srv/js
COPY data /srv/data
COPY config /srv/config
COPY vendor /srv/vendor
