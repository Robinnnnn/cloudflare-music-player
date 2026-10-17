# Cloudflare Music Player

This is the generic, self-hostable API and browser player. Keep the repository independent of any particular user, production service, family project, catalog, or Cloudflare account.

- `catalog/catalog.json` is the source of truth. The checked-in starter catalog is empty. Test recordings belong only in isolated local storage; never commit audio, credentials, local state, or generated bundles.
- Keep IDs stable and object keys immutable. Replacement audio uses a new content-addressed key.
- The HTTP API is intentionally public and read-only. Serve only cataloged tracks. Uploads and catalog changes use authenticated CLI tools, never unauthenticated HTTP endpoints.
- Keep one persistent audio element per player instance and preserve cancellation/teardown behavior.
- Run `npm run check` for code changes. Run smoke checks against an explicitly supplied local or deployed origin.
- Do not deploy or modify remote storage as part of ordinary checks.
