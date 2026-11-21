# WedPlan server

Express 4 + TypeScript (strict, ESM/NodeNext) API for a wedding vendor marketplace: MongoDB/Mongoose, Better Auth, Stripe. The consuming frontend is the sibling `../wedplan-client` repo; its `AGENTS.md` documents the client-side API contract.

## Commands

- `npm run dev` (`tsx watch src/server.ts`), `npm run build` (`tsc` → `dist/`), `npm start` (`node dist/server.js`). Build is the only real verification: `npm test` is a placeholder that exits 1, and there is no lint script, typecheck script, test suite, or CI. Run `npm run build` before claiming a change passes.
- Admin bootstrap has no endpoint: `npx tsx src/scripts/promote-admin.ts account@example.com`. The account must already exist; the user must sign out and back in for the new role to take effect.

## Setup and env quirks

- Copy `.env.example` to `.env` (gitignored). `src/config/env.ts` validates at import time: `MONGODB_URI`, `CLIENT_URL`, `BETTER_AUTH_URL`, and `BETTER_AUTH_SECRET` (>= 32 chars) are required; `PORT` defaults to 5000; Google OAuth vars must be supplied as a pair or omitted entirely. Stripe vars are optional, but their endpoints return 503 when missing.
- `IMGBB_API_KEY` is read directly from `process.env` in the upload route, not through `env.ts` — adding it to the typed env does not wire it up.
- Outside production, `src/config/database.ts` forces DNS servers to 8.8.8.8/8.8.4.4 before the Mongo connection. Check this when debugging local connection failures.

## Wiring and conventions

- `src/server.ts` connects Mongo, then creates the auth instance, then the app. Route modules export `createXRouter(auth)` and are mounted in `src/app.ts`; new routers must be registered there. Better Auth owns `/api/auth/*`; most other endpoints use `{ success: false, message }` errors and a JSON 404 fallback.
- NodeNext ESM: relative imports need explicit `.js` extensions in TS source (e.g. `./config/env.js`). The build fails otherwise.
- Two misspelled paths are real and must be imported as-is: `src/middleware/auth.middileware.ts` and `src/models/tracsaction.model.ts`.
- `/api/stripe/webhook` is mounted before `express.json()` and parses its own body with `express.raw()`. Moving it after the global JSON parser breaks signature verification.
- API auth uses `Authorization: Bearer <JWT>`: `jose` verifies against JWKS at `${BETTER_AUTH_URL}/api/auth/jwks`, then role and blocked status are read from the Mongo `user` collection (`requireAuth` / `requireRole` in the middleware). JWTs expire in 15m.
- Sign-up accepts `registrationRole` of `customer` or `vendor` only; `role`, `isBlocked`, and subscription fields are set server-side. Roles are `customer`, `vendor`, `admin`.

## Server-side invariants

- Premium is activated only by verified Stripe webhooks (checkout/subscription/invoice events); the checkout redirect alone never grants it. Cancellation sets `cancel_at_period_end`.
- Free vendors are capped at 3 active services. Bookings have a partial unique index on `(serviceId, eventDate)` for `pending`/`accepted` statuses. Admin-only routes use `requireRole("admin")`.
