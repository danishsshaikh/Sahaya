from urllib.request import urlopen

with urlopen("http://127.0.0.1:8780/health", timeout=2) as response:
    if response.status != 200:
        raise SystemExit(1)
