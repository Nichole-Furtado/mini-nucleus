# mini-nucleus

[Read in English](README.md)

API REST para gestão de chamados/incidentes, construída com NestJS, Prisma e PostgreSQL. Usado como projeto de estudo/referência para padrões de backend comuns em ferramentas de suporte/SLA: arquitetura em camadas, persistência tipada, validação de entrada e infra containerizada.

## Stack

- **Runtime**: Node.js 24 (LTS)
- **Framework**: NestJS 11 (TypeScript)
- **ORM**: Prisma 7, generator `prisma-client-js` + driver adapter `@prisma/adapter-pg`
- **Banco de dados**: PostgreSQL 16 (containerizado)
- **Cache**: Redis 7 via `@nestjs/cache-manager` + `@keyv/redis`
- **Fila**: BullMQ (backend Redis) via `@nestjs/bullmq`
- **Validação**: `class-validator` / `class-transformer`
- **Configuração**: `@nestjs/config` (baseado em `.env`)

## Arquitetura

O Nest força uma separação em 3 camadas por módulo de feature:

```
Requisição HTTP
   │
   ▼
Controller   → roteamento, binding de params/body, sem lógica de negócio
   │
   ▼
Service      → lógica de negócio, chama a camada de persistência
   │
   ▼
PrismaService → client de banco tipado (Prisma), encapsula @prisma/client
   │
   ▼
PostgreSQL
```

O `PrismaService` é registrado em um módulo `@Global()` (`src/prisma`), então qualquer módulo de feature pode injetá-lo sem precisar redeclará-lo como dependência. Isso reflete como um client compartilhado de banco/cache costuma ser conectado em apps Nest maiores.

A validação acontece na borda: um `ValidationPipe` global (`main.ts`) valida cada body recebido contra o DTO correspondente antes dele chegar no método do controller, e remove campos não declarados (`whitelist: true`).

### Cache

`GET /tickets` e `GET /tickets/:id` são cacheados no Redis (TTL de 30s) através do `TicketsService`, usando o token `CACHE_MANAGER` do `@nestjs/cache-manager`. As operações `create`, `update` e `remove` invalidam as chaves correspondentes (`tickets:all` e `tickets:<id>`), evitando servir dado desatualizado após uma escrita.

### Checagem assíncrona de SLA (BullMQ)

Todo ticket criado enfileira um job com atraso na fila `sla` (`src/tickets/sla.processor.ts`). O atraso é definido pela `priority` (`src/tickets/sla.util.ts`) — menor para `CRITICAL`, maior para `LOW`. Quando o job roda, o `SlaProcessor` relê o ticket e loga um aviso se ele ainda estiver `OPEN`/`IN_PROGRESS`, ou uma confirmação se foi resolvido a tempo. Isso modela o requisito de "monitoramento de SLA" sem precisar de uma stack completa de alertas: o job é um provider do Nest (`WorkerHost`), usando a mesma instância de Redis do cache.

```
POST /tickets ──▶ TicketsService.create()
                       │
                       ├─▶ Postgres (insert)
                       └─▶ sla queue.add(delay = f(priority))
                                  │
                                  ▼ (após o delay)
                          SlaProcessor.process()
                                  │
                                  ▼
                       ainda OPEN? → loga aviso
                       resolvido?  → loga ok
```

### Estrutura do projeto

```
src/
  main.ts                 # bootstrap da app, pipes globais
  app.module.ts            # módulo raiz: Config, Cache (Redis), Bull, Prisma, Tickets
  prisma/
    prisma.service.ts      # instância do PrismaClient (adapter-pg), hooks de ciclo de vida
    prisma.module.ts       # módulo @Global que exporta o PrismaService
  tickets/
    tickets.controller.ts  # rotas REST de /tickets
    tickets.service.ts     # lógica de negócio, leitura/invalidação de cache, enfileira job de SLA
    sla.processor.ts       # worker do BullMQ, checa o status do ticket após o delay de SLA
    sla.util.ts             # mapeamento prioridade → delay
    dto/
      create-ticket.dto.ts
      update-ticket.dto.ts
prisma/
  schema.prisma             # modelo de dados + config de generator/datasource
  migrations/                # migrations SQL versionadas
```

## Modelo de domínio

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

| Método | Rota           | Body               | Descrição                        |
|--------|----------------|--------------------|-----------------------------------|
| POST   | `/tickets`     | `CreateTicketDto`  | Cria um ticket                   |
| GET    | `/tickets`     | –                  | Lista os tickets, mais recentes primeiro |
| GET    | `/tickets/:id` | –                  | Busca um ticket (404 se não existir) |
| PATCH  | `/tickets/:id` | `UpdateTicketDto`  | Atualização parcial, incl. mudança de status |
| DELETE | `/tickets/:id` | –                  | Remove um ticket                 |

`CreateTicketDto` exige `title` (mínimo 3 caracteres); `description` e `priority` são opcionais. `UpdateTicketDto` torna todos os campos de `CreateTicketDto` opcionais e aceita adicionalmente `status`.

## Rodando localmente

Pré-requisitos: Node.js 20+, Docker Desktop.

```bash
# 1. sobe o PostgreSQL
docker run -d --name mini-nucleus-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=mini_nucleus \
  -p 5432:5432 postgres:16

# 2. sobe o Redis
docker run -d --name mini-nucleus-redis -p 6379:6379 redis:7-alpine

# 3. instala as dependências
npm install

# 4. configura as variáveis de ambiente
cp .env.example .env

# 5. aplica as migrations
npx prisma migrate dev

# 6. roda a aplicação
npm run start:dev
```

A API escuta em `http://localhost:3000` por padrão. Para inspecionar/editar os dados:

```bash
npx prisma studio
```

## Notas sobre o Prisma 7

O generator `prisma-client-js` usado aqui exige um driver adapter explícito (`@prisma/adapter-pg`) — `new PrismaClient()` sem ele lança `PrismaClientInitializationError` nesta versão. O `PrismaService` passa o adapter no construtor, montado a partir de `DATABASE_URL`.

## Roadmap

- Autenticação JWT / guards de rota
- Pipeline de CI (lint, test, build) via GitHub Actions
- Cobertura de testes unitários e e2e
