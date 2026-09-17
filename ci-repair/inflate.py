#!/usr/bin/env python3
import zlib, hashlib, json, sys
from pathlib import Path
manifest = json.loads(Path("ci-repair/manifest.json").read_text())
for item in manifest:
    parts = []
    for i in range(item["nparts"]):
        p = Path(f"ci-repair/{item['key']}.{i}.hex")
        if not p.exists():
            print("waiting", p)
            sys.exit(0)
        parts.append(p.read_text().strip())
    hx = "".join(parts)
    got = hashlib.md5(hx.encode()).hexdigest()
    if got != item["hex_md5"]:
        raise SystemExit(f"md5 mismatch {item['key']}: {got} != {item['hex_md5']}")
    Path(item["dest"]).write_bytes(zlib.decompress(bytes.fromhex(hx)))
    print("restored", item["dest"], Path(item["dest"]).stat().st_size)
