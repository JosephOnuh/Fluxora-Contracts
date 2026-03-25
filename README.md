# Fluxora Backend

Express + TypeScript API for the Fluxora treasury streaming protocol. Today this repository exposes a minimal HTTP surface for stream CRUD and health checks. It does not yet ship a production webhook delivery subsystem, persistent storage, or indexing workers. This README documents the current guarantees and the consumer-facing webhook signature contract the team intends to keep stable when delivery is enabled.

## Current status

- Implemented today:
  - REST endpoints for API info, health, and in-memory stream CRUD
  - TypeScript build output for local development
- Explicitly not implemented yet:
  - webhook delivery endpoints
  - durable delivery logs
  - request rate limiting middleware
  - duplicate-delivery storage
  - indexing workers / chain-derived persistence

If a feature in this README is described as a webhook contract, treat it as the documented integration target for consumers and operators, not as proof that the live service already emits webhooks from this repository.

## What's in this repo

- API gateway for stream CRUD and health
- Streams API backed by an in-memory placeholder
- A canonical, tested webhook signature utility in `src/webhooks/signature.ts` that defines the verification contract consumers should implement

## Tech stack

- Node.js 18+
- TypeScript
- Express

## Local setup

### Prerequisites

- Node.js 18+
- npm or pnpm

### Install and run

```bash
npm install
npm run dev
```

API runs at [http://localhost:3000](http://localhost:3000).

### Scripts

- `npm run dev` - run with tsx watch
- `npm run build` - compile to `dist/`
- `npm test` - run webhook verification tests
- `npm start` - run compiled `dist/index.js`

## API overview

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | API info |
| GET | `/health` | Health check |
| GET | `/api/streams` | List streams |
| GET | `/api/streams/:id` | Get one stream |
| POST | `/api/streams` | Create stream with `sender`, `recipient`, `depositAmount`, `ratePerSecond`, `startTime` |

All responses are JSON. Stream data is in-memory until PostgreSQL and chain sync are added.

## Webhook signature verification for consumers

### Scope and guarantee

The single responsibility area covered here is consumer-side verification of Fluxora webhook deliveries. For this area, Fluxora aims to guarantee:

- each delivery carries a stable set of verification headers
- the signature is computed over the exact raw request body, not parsed JSON
- consumers can reject stale, oversized, tampered, or duplicate deliveries with predictable outcomes
- operators have a written checklist for diagnosing delivery failures without relying on tribal knowledge

This repository currently provides the canonical algorithm and the expected outcomes. It does not yet provide a live webhook sending service.

### Verification contract

Fluxora webhook deliveries are expected to use these headers:

| Header | Meaning |
|--------|---------|
| `x-fluxora-delivery-id` | Stable id for a single delivery attempt chain; use it for deduplication |
| `x-fluxora-timestamp` | Unix timestamp in seconds |
| `x-fluxora-signature` | Hex-encoded `HMAC-SHA256(secret, timestamp + "." + rawBody)` |
| `x-fluxora-event` | Event name such as `stream.created` or `stream.updated` |

Canonical signing payload:

```text
${timestamp}.${rawRequestBody}
```

Canonical verification rules:

- use the raw request bytes exactly as received
- reject payloads larger than `256 KiB`
- reject timestamps outside a `300` second tolerance window
- compare signatures with a constant-time equality check
- deduplicate on `x-fluxora-delivery-id`

Reference implementation lives in `src/webhooks/signature.ts`.

### Consumer verification example

```ts
import { verifyWebhookSignature } from './src/webhooks/signature.js';

const verification = verifyWebhookSignature({
  secret: process.env.FLUXORA_WEBHOOK_SECRET,
  deliveryId: req.header('x-fluxora-delivery-id') ?? undefined,
  timestamp: req.header('x-fluxora-timestamp') ?? undefined,
  signature: req.header('x-fluxora-signature') ?? undefined,
  rawBody,
  isDuplicateDelivery: (deliveryId) => seenDeliveryIds.has(deliveryId),
});

if (!verification.ok) {
  return res.status(verification.status).json({
    error: verification.code,
    message: verification.message,
  });
}
```

### Trust boundaries

| Actor | Trusted for | Not trusted for |
|-------|-------------|-----------------|
| Public internet clients | Nothing beyond reaching a public endpoint | Identity, payload integrity, replay prevention |
| Authenticated partners / webhook consumers | Possession of a shared webhook secret and correct endpoint ownership | Skipping signature checks, bypassing replay controls, sending unbounded payloads |
| Administrators / operators | Secret rotation, incident response, delivery diagnostics | Reading secrets from logs or bypassing audit trails |
| Internal workers / delivery jobs | Constructing signed payloads, retry scheduling, durable delivery state once implemented | Mutating consumer acknowledgements or silently dropping permanent failures |

### Failure modes and expected client-visible behavior

The table below describes the documented outcomes consumers should expect and, where relevant, the response code they should return if they intentionally reject a delivery.

| Condition | Expected result | Suggested HTTP outcome |
|-----------|-----------------|------------------------|
| Missing secret in consumer config | Treat as configuration failure; do not trust the payload | `500` internally, do not acknowledge |
| Missing `x-fluxora-delivery-id` / timestamp / signature | Reject as unauthenticated | `401 Unauthorized` |
| Non-numeric or stale timestamp | Reject as replay-risk / invalid input | `400` for malformed timestamp, `401` for stale timestamp |
| Signature mismatch | Reject as unauthenticated | `401 Unauthorized` |
| Payload larger than `256 KiB` | Reject before parsing JSON | `413 Payload Too Large` |
| Duplicate delivery id | Do not process the business action twice | `200 OK` after safe dedupe, or `409 Conflict` if you want the duplicate to be visible |
| Consumer is overloaded / rate limited | Ask sender to retry later | `429 Too Many Requests` |
| Dependency outage while processing a verified event | Preserve the verified payload if possible and retry locally | `500` or `503` if you cannot safely acknowledge |

### Abuse and reliability notes

- Oversized payloads: consumers should bound raw-body size before JSON parsing. The reference helper uses `256 KiB` as the documented ceiling.
- Excessive request rates: rate limiting is not implemented in this repository today. Consumers should still protect their endpoints and may return `429`.
- Duplicate submissions: consumers must assume at-least-once delivery and dedupe on `x-fluxora-delivery-id`.
- Partial data: event payloads should be treated as immutable evidence. If downstream enrichment fails, keep the raw payload and delivery id for replay.

### Operator observability and incident diagnosis

Operators should be able to answer the following without tribal knowledge:

- was the payload signed with the expected secret version
- what delivery id and event type were involved
- whether the failure happened at authentication, payload-size validation, replay protection, or downstream business logic
- whether the event was safely deduplicated or dropped

Recommended operational fields to log once delivery exists:

- delivery id
- event type
- timestamp header
- verification result code
- response status
- retry attempt count
- secret version identifier, never the secret itself

Recommended health checks once delivery exists:

- count of signature failures by consumer endpoint
- count of stale timestamps
- count of duplicate deliveries
- retry queue depth
- percentage of 2xx acknowledgements

### Verification evidence for this change

- automated tests in `src/webhooks/signature.test.ts` cover:
  - exact raw-body signing
  - stable HMAC output
  - valid signature acceptance
  - oversized payload rejection
  - stale timestamp rejection
  - signature mismatch rejection
  - duplicate delivery detection
- manual review checks:
  - confirm consumers are instructed to verify raw bytes instead of parsed JSON
  - confirm deferred items are called out explicitly rather than implied as implemented

### Non-goals and follow-up work

Intentionally deferred in this issue:

- shipping a webhook sender or consumer endpoint in Express
- persistence for deduplication records
- secret rotation APIs
- delivery retry workers
- OpenAPI for webhook endpoints, because no webhook HTTP route exists in this repository yet

Recommended follow-up issues:

- implement webhook delivery route(s) and durable delivery store
- add raw-body middleware and rate limiting
- publish OpenAPI once webhook endpoints are live
- add runbook-backed monitoring and alert thresholds

## Project structure

```text
src/
  routes/          # health, streams
  webhooks/        # canonical webhook signing and verification contract
  index.ts         # Express app and server
```

## Environment

Optional:

- `PORT` - server port, default `3000`

Likely future additions:

- `DATABASE_URL`
- `REDIS_URL`
- `HORIZON_URL`
- `JWT_SECRET`
- `FLUXORA_WEBHOOK_SECRET`

## Related repos

- `fluxora-frontend` - dashboard and recipient UI
- `fluxora-contracts` - Soroban smart contracts
