# Vendored IPQuality

本目录存放随 ip-changer 一起部署的第三方 IPQuality 脚本。

- Upstream: https://github.com/xykt/IPQuality
- Vendored file: `ip.sh`
- Vendored upstream commit: `e55361d8cd007e35a62ee2723e623e23be1997df`
- Vendored script version: `v2026-03-13`
- SHA256: `200FA705123B35867F1DD1BF2B2D6939FA4092F35BEDC003ADF63A98C301810B`
- Upstream license copy: `LICENSE.upstream`

ip-changer runs this file as:

```bash
/bin/bash <IPQUALITY_SCRIPT_PATH> -4 -n
```

`-4` asks upstream IPQuality to generate only the IPv4 report. `-n` skips the upstream script's OS/dependency installer. Install the required command-line tools on the VPS before enabling `/ipquality`.

To update the vendored copy, download `ip.sh` from a specific upstream commit, replace this file, update the commit/hash above, then run:

```bash
node scripts/changeip_regression.js
```
