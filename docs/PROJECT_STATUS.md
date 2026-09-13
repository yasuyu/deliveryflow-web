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
- Return the last 14 days and all-time top 10 rankings from `GET /api/drivers/ranking`
- Return and highlight the logged-in driver's own rank
- Use documented competition ranking for tied scores
- Display both ranking periods in the web UI
- Derive Rookie, Bronze, Silver, and Gold titles from cumulative score
- Return the current title, next title, points needed, and progress from `GET /api/drivers/me/score`
- Display title progress in the web UI and cover score boundaries in automated tests
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
- PR #6: repository guidance and project status
- PR #7: driver rankings and ranking UI

## Partially implemented

- Dispatching currently uses server-generated test orders rather than nearby-order search.

## Recommended next feature

### Score bonuses

- Add weather, late-night, and other documented bonus rules
- Show the bonus breakdown before accepting an offer and after completion
- Preserve one-time awards and Idempotency-Key protection
- Add rule-selection, boundary, and duplicate-award tests

Suggested branch: `feature/score-bonuses`

## Later roadmap

1. GPS location, distance calculation, maps, and route display
2. WebSocket updates and an offline operation queue
3. Stagnation detection, safety alerts, and an order simulator
4. Redis, multi-server operation, and external cloud deployment when needed

## Verification baseline

- PR #7 CI completed successfully.
- CI covered the SQLite test suite and PostgreSQL container smoke test.
- Post-merge syntax checks and automated tests succeeded.

## Reference materials

- Product and hackathon reference materials are kept outside this repository.
- On a configured local machine, their locations are stored in the Git-ignored `data/codex-local-context.md`.
- Relevant documents, screenshots, and notes may be consulted only when needed and explicitly made available by the user.
- Treat all reference materials as read-only and do not expose personal filesystem paths.
