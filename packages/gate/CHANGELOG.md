# @infracraft/gate

## 0.2.0

### Minor Changes

- d8d8805: Native-session discovery: interactive commands now notice when the native CLI is logged into an account gate doesn't know and offer to import it. Declining is remembered per identity (`gate <provider> import` always works manually and un-declines). The empty-store error now mentions `import` alongside `login`.

## 0.1.0

### Minor Changes

- 00b9131: Initial release: multi-account switcher for Vercel, Railway, and Fly.io with real native-CLI switching (`gate vercel switch`, `gate railway switch`, `gate fly auth switch`) and metadata-free sandboxed deploys (`gate vercel deploy`, `gate railway up`, `gate fly deploy`). Supersedes vergate.

### Patch Changes

- Updated dependencies [00b9131]
  - @infracraft/sandbox@0.1.0
