# @infracraft/gate

## 0.5.0

### Minor Changes

- 7339f3e: Unique identities: a provider account can no longer appear twice in gate's store. Existing duplicates trigger a mandatory merge prompt (pick the surviving label); `login` and `import` now offer update-or-rename when the identity is already stored.

## 0.4.1

### Patch Changes

- cf0ec60: Active accounts in `list` and the account picker now render as a green line ending with a circle, instead of the appended "active" label.

## 0.4.0

### Minor Changes

- d3c10c3: Self-healing sessions: when the native CLI holds a valid session for an identity gate already stores (a re-login or auto-refreshed token), the stored entries silently adopt the fresh session. The active marker now compares tokens per entry, so duplicate-identity entries all show as active when they hold the live session.

### Patch Changes

- ee1f49f: `gate --version` now reports the package version (it previously printed "No version specified").

## 0.3.0

### Minor Changes

- 74109c4: Refresh-aware discovery: an expired-but-refreshable native session (Vercel) is now silently refreshed during discovery and `import` instead of classifying as invalid, so a stale `auth.json` no longer hides the import offer. The refreshed tokens are written back to the native auth file immediately (OAuth refresh rotates the refresh token), which also revives the native CLI session.

### Patch Changes

- 3db05b3: Reword user-facing CLI messages and README to drop em dashes.

## 0.2.0

### Minor Changes

- d8d8805: Native-session discovery: interactive commands now notice when the native CLI is logged into an account gate doesn't know and offer to import it. Declining is remembered per identity (`gate <provider> import` always works manually and un-declines). The empty-store error now mentions `import` alongside `login`.

## 0.1.0

### Minor Changes

- 00b9131: Initial release: multi-account switcher for Vercel, Railway, and Fly.io with real native-CLI switching (`gate vercel switch`, `gate railway switch`, `gate fly auth switch`) and metadata-free sandboxed deploys (`gate vercel deploy`, `gate railway up`, `gate fly deploy`). Supersedes vergate.

### Patch Changes

- Updated dependencies [00b9131]
  - @infracraft/sandbox@0.1.0
