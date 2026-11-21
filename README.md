# WedPlan — Wedding Planning Platform (Server)

## Project Name and Description

**WedPlan** is a role-based wedding planning platform where customers discover wedding services, send booking requests to vendors, and track those requests. Vendors publish and manage services, handle booking requests and subscribe to a paid plan. Admins manage users, review services and monitor transactions.

This repository contains the **Express + TypeScript API**. The Next.js client lives in a separate repository (links below).

## Important Features

- Better Auth authentication with JWT access tokens, Google OAuth, and strictly server-assigned roles (`customer`, `vendor`, `admin`). Public registration can only create Customer or Vendor accounts.
- Role and blocked-status verification on every protected API route, plus per-resource ownership checks for service, booking and profile mutations.
- Public service browsing and details (approved, active services only) with search, category/location filters and price sorting.
- Vendor service CRUD with ImgBB-backed image upload, default `pending` status, and plan-based active-service limits (Free 3, Starter 10, Premium unlimited).
- Booking request lifecycle: customer submit/cancel, vendor accept/reject, duplicate and self-booking prevention, status ownership enforcement.
- Admin moderation: user search/filter/block/unblock/role changes, service approve/reject/delete, and read-only transaction monitoring.
- Stripe Checkout for Starter and Premium upgrades. Paid plans are activated **only** by verified webhook events; the success redirect alone never changes subscription state.
- Dashboard overview statistics for each role and a read-only profile API that cannot change role or subscription fields.

## Technology Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 20+ |
| Framework | Express 4 |
| Language | TypeScript 5 (ESM / NodeNext) |
| Database | MongoDB with Mongoose 9 |
| Auth | Better Auth 1.7 + `jose` JWT verification against JWKS |
| Payments | Stripe SDK (Checkout + webhooks) |
| Image hosting | ImgBB via the server upload endpoint |
| Dev tooling | `tsx`, TypeScript compiler |

## Installation Instructions

Prerequisites: Node.js 20+, npm, and a MongoDB connection string.

```bash
git clone https://github.com/jonaedjoshim/Ph-Assignment-08-Wed-Plan-Server.git
cd Ph-Assignment-08-Wed-Plan-Server
npm install
cp .env.example .env
# Fill in every required value described in Environment Variables below.
```

## How to Run the Project Locally

```bash
npm run dev     # tsx watch — development
npm run build   # tsc → dist/
npm start       # node dist/server.js (production build)
```

The API listens on `PORT` (default `5000`) and exposes `/api/health`.

Create an admin account by first registering normally, then running:

```bash
npx tsx src/scripts/promote-admin.ts account@example.com
```

The user must sign out and back in for the new role to take effect. There is no public admin signup endpoint. Admin evaluation credentials are provided separately.

## Live Website Link

The client application is deployed at **https://wed-plan-mj.vercel.app/**. This API is deployed at **https://wed-plan-server.onrender.com**.

## Client and Server Repository Links

- Client: <https://github.com/jonaedjoshim/Ph-Assignment-08-Wed-Plan-Client>
- Server: <https://github.com/jonaedjoshim/Ph-Assignment-08-Wed-Plan-Server>

## Environment Variables

Copy `.env.example` to `.env` (gitignored). Keep all values secret; never commit `.env` or credentials.

| Variable | Example | Description |
| --- | --- | --- |
| `PORT` | `5000` | API port. |
| `CLIENT_URL` | `http://localhost:3000` | Allowed CORS origin and base for Stripe return URLs. |
| `MONGODB_URI` | `mongodb+srv://…` | MongoDB connection string. |
| `BETTER_AUTH_SECRET` | (32+ random characters) | Secret used to sign/verify auth tokens. |
| `BETTER_AUTH_URL` | `http://localhost:5000` | Public base URL of this API, used for JWKS discovery. |
| `GOOGLE_CLIENT_ID` | `…` | Google OAuth client ID. Must be set together with the secret. |
| `GOOGLE_CLIENT_SECRET` | `…` | Google OAuth client secret. |
| `STRIPE_SECRET_KEY` | `sk_test_…` | Stripe secret key (test mode). |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | Secret used to verify Stripe webhook signatures. |
| `STRIPE_PREMIUM_PRICE_ID` | `price_…` | Active recurring Premium price ID. |
| `STRIPE_STARTER_PRICE_ID` | `price_…` | Active recurring Starter price ID. Optional; Starter checkout returns `503` when unset. |
| `IMGBB_API_KEY` | `…` | API key for image uploads. |

`MONGODB_URI`, `CLIENT_URL`, `BETTER_AUTH_URL` and `BETTER_AUTH_SECRET` are required. Google variables must be provided as a pair or omitted entirely. Stripe endpoints return `503` when their variables are missing.

## Required Application URLs

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Health check |
| `GET /api/services`, `GET /api/services/:serviceId` | Public service browsing and details |
| `POST /api/auth/*` | Better Auth (sign-up, sign-in, Google, JWT) |
| `GET/PATCH /api/profile` | Profile read/update |
| `GET/POST/PATCH/DELETE /api/vendor/services` | Vendor service management |
| `GET/POST/PATCH /api/bookings` | Booking requests |
| `GET/PATCH /api/admin/users`, `/api/admin/services` | Admin moderation |
| `GET /api/admin/transactions` | Read-only transaction monitoring |
| `POST /api/uploads` | Authenticated ImgBB image upload |
| `POST /api/stripe/checkout` | Starter or Premium checkout (plan in request body) |
| `POST /api/stripe/webhook` | Verified Stripe events (raw body, mounted before `express.json()`) |

## Deployment Guideline

1. Use a Node 20+ host (for example Render). Set the environment variables above in the host dashboard — never in source control.
2. Set `CLIENT_URL` to the deployed client URL (`https://wed-plan-mj.vercel.app/`) and `BETTER_AUTH_URL` to this API's public URL.
3. Build with `npm run build` and start with `npm start`.
4. In Stripe, register the webhook endpoint `https://wed-plan-server.onrender.com/api/stripe/webhook` and set `STRIPE_WEBHOOK_SECRET` to its signing secret. Premium access depends on this webhook.
5. In Google Cloud, add the deployed API callback URL to the OAuth client's authorized redirect URIs.
6. Verify: `/api/health` returns `200`, CORS allows the client origin, protected routes return `401`/`403` correctly, Stripe checkout redirects to the payment success/cancel pages, and a completed test payment grants Premium only after webhook delivery.
