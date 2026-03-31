FROM lscr.io/linuxserver/chromium:latest

# CDP-Proxy: leitet externe Verbindungen auf localhost:9222 → 0.0.0.0:9223 weiter
COPY cdp-proxy.py /usr/local/bin/cdp-proxy.py
RUN chmod +x /usr/local/bin/cdp-proxy.py

# s6-overlay v3 Service (linuxserver Standard)
COPY s6-overlay/ /etc/s6-overlay/
RUN chmod +x /etc/s6-overlay/s6-rc.d/cdp-proxy/run

EXPOSE 9223
