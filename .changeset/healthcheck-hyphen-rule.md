---
"@infracraft/pulumi": patch
---

Railway rejects any healthcheckPath containing a hyphen with a bare "Invalid input" (undocumented — isolated by a live probe matrix: "/" and every hyphen-free variant succeed, every hyphenated value fails, regardless of deploy state, auth path, or timeout pairing). RailwayService.check() now fails hyphenated paths at plan time with the full explanation instead of letting the API landmine fire mid-deploy.
