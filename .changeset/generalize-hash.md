---
"@infracraft/pulumi": major
---

Generalize `hash` to ordered path collections (directories AND single files, with a `base` option labeling entries by relative path) and remove `hashApp` — dependency-closure resolution is consumer domain knowledge, not library concern. Migrate `hashApp(root, dir)` to closure resolution in your own code feeding `hash(sortedDirs, { base: root })`; the digest framing is unchanged, so identically-fed collections produce identical hashes.
