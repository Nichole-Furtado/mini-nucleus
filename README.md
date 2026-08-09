# mini-nucleus

REST API for ticket/incident tracking, built with NestJS, Prisma and PostgreSQL. Used as a study/reference project for backend patterns commonly required in support/SLA tooling: layered architecture, typed persistence, input validation and containerized infra.

## Stack

- **Runtime**: Node.js 24 (LTS)
- **Framework**: NestJS 11 (TypeScript)
- **ORM**: Prisma 7, `prisma-client-js` generator + `@prisma/adapter-pg` driver adapter
- **Database**: PostgreSQL 16 (containerized)
- **Validation**: `class-validator` / `class-transformer`
- **Config**: `@nestjs/config` (`.env`-based)

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

### Project structure

```
src/
  main.ts                 # app bootstrap, global pipes
  app.module.ts            # root module, wires ConfigModule/PrismaModule/TicketsModule
  prisma/
    prisma.service.ts      # PrismaClient instance (adapter-pg), lifecycle hooks
    prisma.module.ts       # @Global module exporting PrismaService
  tickets/
    tickets.controller.ts  # REST routes for /tickets
    tickets.service.ts     # business logic, talks to PrismaService
    dto/
      create-ticket.dto.ts
      update-ticket.dto.ts
prisma/
  schema.prisma             # data model + generator/datasource config
  migrations/                # versioned SQL migrations
```

## Domain model

```prisma
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

| Method | Route          | Body               | Description                     |
|--------|----------------|--------------------|----------------------------------|
| POST   | `/tickets`     | `CreateTicketDto`  | Creates a ticket                |
| GET    | `/tickets`     | –                  | Lists tickets, newest first     |
| GET    | `/tickets/:id` | –                  | Fetches one ticket (404 if missing) |
| PATCH  | `/tickets/:id` | `UpdateTicketDto`  | Partial update, incl. status transitions |
| DELETE | `/tickets/:id` | –                  | Deletes a ticket                |

`CreateTicketDto` requires `title` (min 3 chars); `description` and `priority` are optional. `UpdateTicketDto` makes all `CreateTicketDto` fields optional and additionally accepts `status`.

## Running locally

Prerequisites: Node.js 20+, Docker Desktop.

```bash
# 1. start PostgreSQL
docker run -d --name mini-nucleus-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=mini_nucleus \
  -p 5432:5432 postgres:16

# 2. install dependencies
npm install

# 3. configure environment
cp .env.example .env

# 4. apply migrations
npx prisma migrate dev

# 5. run
npm run start:dev
```

The API listens on `http://localhost:3000` by default. Inspect/edit data with:

```bash
npx prisma studio
```

## Notes on Prisma 7

The `prisma-client-js` generator here requires an explicit driver adapter (`@prisma/adapter-pg`) — `new PrismaClient()` without one throws `PrismaClientInitializationError` as of this version. `PrismaService` passes the adapter in its constructor, built from `DATABASE_URL`.

## Roadmap

- JWT authentication / route guards
- Redis for caching and async processing (BullMQ)
- CI pipeline (lint, test, build) via GitHub Actions
- Unit and e2e test coverage
