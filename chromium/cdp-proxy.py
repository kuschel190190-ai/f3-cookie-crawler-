#!/usr/bin/env python3
"""
CDP TCP Proxy – leitet externe TCP-Verbindungen auf 127.0.0.1:9222 weiter.
Lauscht auf allen Netzwerk-IPs (nicht nur localhost) auf Port 9222.
Wird als s6-Service beim Container-Start ausgeführt.
"""
import socket, threading, select, sys, time

REMOTE_HOST = '127.0.0.1'
REMOTE_PORT = 9222   # Chromium CDP (nur localhost)
LISTEN_PORT = 9223   # Externer Port (kein Konflikt mit 9222)
BIND_ADDR   = '0.0.0.0'

def forward(src, dst):
    try:
        while True:
            r, _, _ = select.select([src], [], [], 5)
            if not r:
                continue
            data = src.recv(4096)
            if not data:
                break
            dst.sendall(data)
    except Exception:
        pass
    finally:
        try: src.close()
        except: pass
        try: dst.close()
        except: pass

def handle(client):
    try:
        remote = socket.create_connection((REMOTE_HOST, REMOTE_PORT), timeout=10)
    except Exception as e:
        print(f'[cdp-proxy] Verbindung zu CDP fehlgeschlagen: {e}', flush=True)
        client.close()
        return
    t1 = threading.Thread(target=forward, args=(client, remote), daemon=True)
    t2 = threading.Thread(target=forward, args=(remote, client), daemon=True)
    t1.start()
    t2.start()

def wait_for_chromium():
    """Warte bis Chromium CDP auf 127.0.0.1:9222 lauscht."""
    for i in range(60):
        try:
            s = socket.create_connection(('127.0.0.1', REMOTE_PORT), timeout=1)
            s.close()
            print(f'[cdp-proxy] Chromium CDP bereit (nach {i}s)', flush=True)
            return True
        except:
            time.sleep(1)
    print('[cdp-proxy] Timeout: Chromium CDP nicht verfügbar nach 60s', flush=True)
    return False

def main():
    print(f'[cdp-proxy] Starte CDP-Proxy auf {BIND_ADDR}:{LISTEN_PORT} → {REMOTE_HOST}:{REMOTE_PORT}', flush=True)

    if not wait_for_chromium():
        sys.exit(1)

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((BIND_ADDR, LISTEN_PORT))
    srv.listen(50)
    print(f'[cdp-proxy] Lauscht auf {BIND_ADDR}:{LISTEN_PORT}', flush=True)

    while True:
        try:
            client, addr = srv.accept()
            threading.Thread(target=handle, args=(client,), daemon=True).start()
        except Exception as e:
            print(f'[cdp-proxy] Accept-Fehler: {e}', flush=True)

if __name__ == '__main__':
    main()
