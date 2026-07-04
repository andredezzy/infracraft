---
"@infracraft/pulumi": minor
---

RailwayDomain: expose `cnameTarget` (the DNS record to point a custom domain's CNAME at, extracted from Railway's traffic-routing DNS record) — verified multi-domain-safe, since adoption/deletion already scope by exact domain name and domainId respectively.
