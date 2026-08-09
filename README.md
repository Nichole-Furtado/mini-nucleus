# mini-nucleus

[Leia em Português](README.pt-BR.md)

REST API for ticket/incident tracking, built with NestJS, Prisma and PostgreSQL. Used as a study/reference project for backend patterns commonly required in support/SLA tooling: layered architecture, typed persistence, input validation and containerized infra.

## Stack

- **Runtime**: Node.js 24 (LTS)
- **Framework**: NestJS 11 (TypeScript)
- **ORM**: Prisma 7, `prisma-client-js` generator + `@prisma/adapter-pg` driver adapter
- **Database**: PostgreSQL 16 (containerized)
- **Cache**: Redis 7 via `@nestjs/cache-manager` + `@keyv/redis`
- **Queue**: BullMQ (Redis-backed) via `@nestjs/bullmq`
- **Validation**: `class-validator` / `class-transformer`
- **Config**: `@nestjs/config` (`.env`-based)
- **Auth**: JWT via `@nestjs/jwt` + `@nestjs/passport`, `bcrypt` for password hashing

## Architecture

Nest enforces a 3-layer separation per feature module:

```
HTTP request
   │
   ▼
Controller   → routing, param/body binding, no business logic
   │
   ▼
Service      → business logic, calls the persistence layer
   │
   ▼
PrismaService → typed DB client (Prisma), wraps @prisma/client
   │
   ▼
PostgreSQL
```

`PrismaService` is registered in a `@Global()` module (`src/prisma`), so any feature module can inject it without re-declaring it as a dependency. This mirrors how a shared DB/cache client is usually wired in larger Nest apps.

Validation happens at the edge: a global `ValidationPipe` (`main.ts`) checks every incoming body against its DTO before it reaches the controller method, and strips unknown fields (`whitelist: true`).

### Caching

`GET /tickets` and `GET /tickets/:id` are cached in Redis (30s TTL) through `TicketsService`, using the `CACHE_MANAGER` token from `@nestjs/cache-manager`. `create`, `update` and `remove` invalidate the relevant keys (`tickets:all` and `tickets:<id>`) so stale data isn't served after a write.

### Async SLA check (BullMQ)

Every created ticket enqueues a delayed job on the `sla` queue (`src/tickets/sla.processor.ts`). The delay is derived from `priority` (`src/tickets/sla.util.ts`) — shorter for `CRITICAL`, longer for `LOW`. When the job runs, `SlaProcessor` re-reads the ticket and logs a warning if it's still `OPEN`/`IN_PROGRESS`, or a confirmation if it was resolved in time. This models the "SLA monitoring" requirement without needing a full alerting stack: the job is a Nest provider (`WorkerHost`), backed by the same Redis instance as the cache.

```
POST /tickets ──▶ TicketsService.create()
                       │
                       ├─▶ Postgres (insert)
                       └─▶ sla queue.add(delay = f(priority))
                                  │
                                  ▼ (after delay)
                          SlaProcessor.process()
                                  │
                                  ▼
                       still OPEN? → log warning
                       resolved?   → log ok
```

### Authentication

`/tickets` routes are protected by `JwtAuthGuard` (`@UseGuards(JwtAuthGuard)` at controller level), which delegates to a Passport `jwt` strategy. `POST /auth/register` hashes the password with bcrypt and returns a signed token; `POST /auth/login` verifies credentials the same way. The secret and expiry are read through `ConfigService` inside `JwtModule.registerAsync` — not `process.env` directly at module-decoration time, which would run before `ConfigModule` has loaded `.env` and sign tokens with a stale/default secret.

Send the token as `Authorization: Bearer <token>` on any `/tickets` request.

### Project structure

```
src/
  main.ts                 # app bootstrap, global pipes
  app.module.ts            # root module: Config, Cache (Redis), Bull, Prisma, Auth, Tickets
  auth/
    auth.controller.ts     # POST /auth/register, POST /auth/login
    auth.service.ts        # password hashing, credential checks, token signing
    jwt-auth.guard.ts       # guard used on protected controllers
    strategies/jwt.strategy.ts
  prisma/
    prisma.service.ts      # PrismaClient instance (adapter-pg), lifecycle hooks
    prisma.module.ts       # @Global module exporting PrismaService
  tickets/
    tickets.controller.ts  # REST routes for /tickets
    tickets.service.ts     # business logic, cache read/invalidation, enqueues SLA job
    sla.processor.ts       # BullMQ worker, checks ticket status after the SLA delay
    sla.util.ts             # priority → delay mapping
    dto/
      create-ticket.dto.ts
      update-ticket.dto.ts
prisma/
  schema.prisma             # data model + generator/datasource config
  migrations/                # versioned SQL migrations
```

## Domain model

```prisma
model User {
  id           String   @id @default(uuid())
  name         String
  email        String   @unique
  passwordHash String
  createdAt    DateTime @default(now())
}

model Ticket {
  id          String         @id @default(uuid())
  title       String
  description String?
  status      TicketStatus   @default(OPEN)      // OPEN | IN_PROGRESS | RESOLVED | CLOSED
  priority    TicketPriority @default(MEDIUM)     // LOW | MEDIUM | HIGH | CRITICAL
  slaDueAt    DateTime?
  createdAt   DateTime       @default(now())
  updatedAt   DateTime       @updatedAt
}
```

## API

| Method | Route            | Auth | Body               | Description                     |
|--------|------------------|------|--------------------|----------------------------------|
| POST   | `/auth/register` | –    | `RegisterDto`      | Creates a user, returns a JWT   |
| POST   | `/auth/login`    | –    | `LoginDto`         | Verifies credentials, returns a JWT |
| POST   | `/tickets`       | JWT  | `CreateTicketDto`  | Creates a ticket                |
| GET    | `/tickets`       | JWT  | –                  | Lists tickets, newest first     |
| GET    | `/tickets/:id`   | JWT  | –                  | Fetches one ticket (404 if missing) |
| PATCH  | `/tickets/:id`   | JWT  | `UpdateTicketDto`  | Partial update, incl. status transitions |
| DELETE | `/tickets/:id`   | JWT  | –                  | Deletes a ticket                |

`CreateTicketDto` requires `title` (min 3 chars); `description` and `priority` are optional. `UpdateTicketDto` makes all `CreateTicketDto` fields optional and additionally accepts `status`. `RegisterDto` requires `name`, a valid `email`, and `password` (min 8 chars); `LoginDto` requires `email` and `password`.

## Running locally

Prerequisites: Node.js 20+, Docker Desktop.

```bash
# 1. start PostgreSQL
docker run -d --name mini-nucleus-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=mini_nucleus \
  -p 5432:5432 postgres:16

# 2. start Redis
docker run -d --name mini-nucleus-redis -p 6379:6379 redis:7-alpine

# 3. install dependencies
npm install

# 4. configure environment
cp .env.example .env

# 5. apply migrations
npx prisma migrate dev

# 6. run
npm run start:dev
```

The API listens on `http://localhost:3000` by default. Inspect/edit data with:

```bash
npx prisma studio
```

## Notes on Prisma 7

The `prisma-client-js` generator here requires an explicit driver adapter (`@prisma/adapter-pg`) — `new PrismaClient()` without one throws `PrismaClientInitializationError` as of this version. `PrismaService` passes the adapter in its constructor, built from `DATABASE_URL`.

## Roadmap

- CI pipeline (lint, test, build) via GitHub Actions
- Unit and e2e test coverage
