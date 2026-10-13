# demo-app

A tiny service with session handling and an HTTP client.

- `src/auth/session.js` — session creation, expiry and token refresh
- `src/auth/token-store.js` — in-memory token storage
- `src/http/client.js` — HTTP client with retries
- `src/config.js` — configuration values

Run the tests with `npm test`.
