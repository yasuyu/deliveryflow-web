# DeliveryFlow Web project status

Last reviewed: 2026-09-14

This file is a navigation aid. The current code, migrations, OpenAPI document, and automated tests are the source of truth when this summary differs from the implementation.

## Current direction

- Run the application on the user's own PC using free local tooling.
- Use Docker Compose with PostgreSQL as the production-like verification environment.
- External deployment and multi-server infrastructure are deferred until the application needs to be used by other people over the internet.
- Continue with maps and route display only after evaluating a privacy-preserving provider.

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
- Display all three ranking periods in the web UI
- Rank monthly score by Japan calendar month and display it alongside the existing periods
- Give all drivers ranked first, second, or third the corresponding monthly title, including ties
- Derive Rookie, Bronze, Silver, and Gold titles from cumulative score
- Return the current title, next title, points needed, and progress from `GET /api/drivers/me/score`
- Display title progress in the web UI and cover score boundaries in automated tests
- Add 30-point rain and 50-point Japan-time late-night bonuses, including stacking
- Freeze the score estimate and breakdown when an offer is created and preserve it through completion
- Provide a local clear/rain simulator without an external weather service
- Display the bonus breakdown before acceptance, during delivery, and in completed score history
- Cover rule selection, late-night boundaries, saved snapshots, and duplicate-award prevention
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
- Organize browser and server code under `apps/`, with tests and feature modules beside the server
- Keep `prisma/` at the repository root so existing local SQLite data remains compatible
- Document directory responsibilities and change locations in `docs/architecture.md`
- Document state transitions, data relationships, and architectural decisions in dedicated guides

### Driver location and distance

- Request browser geolocation only after the driver explicitly presses the update button
- Accept authenticated location updates only while the driver is working
- Treat locations older than five minutes as stale
- Remove retained coordinates when the driver ends the shift
- Calculate pickup and drop-off straight-line distances without an external map service
- Keep exact driver coordinates out of dashboard and update responses
- Mark store and drop-off coordinates as synthetic demo data
- Cover validation, freshness boundaries, distance calculation, authentication, and retention in tests
- Add matching SQLite and PostgreSQL migrations and OpenAPI documentation

## Recent relevant pull requests

- PR #4: delivery history search and filtering
- PR #5: driver score tracking and UI
- PR #6: repository guidance and project status
- PR #7: driver rankings and ranking UI
- PR #8: driver titles and monthly ranking awards
- PR #9: score bonuses and local weather simulation
- PR #10: driver location and straight-line distance

## Partially implemented

- Dispatching currently uses server-generated test orders rather than nearby-order search.
- Distances are straight-line estimates over synthetic points; road routes and travel times are not implemented.

## Recommended next feature

### Maps and routes

- Evaluate a map/route provider and its privacy, key management, and free-tier limits
- Display road routes and estimated travel distance without exposing location longer than necessary

Suggested branch: `feature/route-map`

## Later roadmap

1. Maps and route display
2. WebSocket updates and an offline operation queue
3. Stagnation detection, safety alerts, and an order simulator
4. Redis, multi-server operation, and external cloud deployment when needed

## Verification baseline

- PR #10 CI completed successfully and was merged.
- CI covered the SQLite test suite and PostgreSQL container smoke test.
- Post-merge syntax checks and automated tests succeeded.

## Reference materials

- Product and hackathon reference materials are kept outside this repository.
- On a configured local machine, their locations are stored in the Git-ignored `data/codex-local-context.md`.
- Relevant documents, screenshots, and notes may be consulted only when needed and explicitly made available by the user.
- Treat all reference materials as read-only and do not expose personal filesystem paths.
