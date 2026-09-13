# DeliveryFlow Web project status

Last reviewed: 2026-09-13

This file is a navigation aid. The current code, migrations, OpenAPI document, and automated tests are the source of truth when this summary differs from the implementation.

## Current direction

- Run the application on the user's own PC using free local tooling.
- Use Docker Compose with PostgreSQL as the production-like verification environment.
- External deployment and multi-server infrastructure are deferred until the application needs to be used by other people over the internet.
- Continue the gamification roadmap next.

## Completed

### Delivery lifecycle

- Driver registration and PIN login
- Work start and end
- Delivery offer generation, acceptance, and rejection
- Pickup and completion state transitions
- Idempotency-Key handling and duplicate-operation protection
- Delivery history with status filtering

### Driver scoring

- Award points once when a delivery is completed
- Default completion award of 100 points through `ScoreRule`
- Store awards and their reasons in `ScoreEvent`
- Track the driver's cumulative score
- Return the last 14 days, cumulative score, and recent award history from `GET /api/drivers/me/score`
- Display estimated award points, the score summary, and recent score history in the web UI
- Prevent duplicate score awards for the same delivery
- SQLite and PostgreSQL migrations, OpenAPI updates, and automated tests

### Platform and quality

- Prisma with SQLite for lightweight development and automated tests
- PostgreSQL with Docker Compose for production-like local verification
- Prisma Studio startup helpers
- OpenAPI documentation
- GitHub Actions CI
- Structured logs, health checks, and safe metrics
- Load-test script and PostgreSQL container smoke test
- Compose Watch support

## Recent relevant pull requests

- PR #4: delivery history search and filtering
- PR #5: driver score tracking and UI

## Partially implemented

- Dispatching currently uses server-generated test orders rather than nearby-order search.

## Recommended next feature

### Driver ranking

- Rankings for the last 14 days and for all time
- Rank, driver display name, and score for top drivers
- The logged-in driver's own rank
- A documented and tested policy for tied scores
- `GET /api/drivers/ranking`
- Ranking UI
- Authorization, privacy, SQLite, and PostgreSQL coverage

Suggested branch: `feature/driver-ranking`

## Later roadmap

1. Driver titles or badges
2. Weather, late-night, and other bonus score rules
3. GPS location, distance calculation, maps, and route display
4. WebSocket updates and an offline operation queue
5. Stagnation detection, safety alerts, and an order simulator
6. Redis, multi-server operation, and external cloud deployment when needed

## Verification baseline

- PR #5 CI completed successfully.
- CI covered the SQLite test suite and PostgreSQL container smoke test.
- Post-merge syntax checks and automated tests succeeded.

## Reference materials

- Product and hackathon reference materials are kept outside this repository.
- On a configured local machine, their locations are stored in the Git-ignored `data/codex-local-context.md`.
- Relevant documents, screenshots, and notes may be consulted only when needed and explicitly made available by the user.
- Treat all reference materials as read-only and do not expose personal filesystem paths.
