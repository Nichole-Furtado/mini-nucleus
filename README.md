# mini-nucleus

[Read in English](README.en.md)

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
- **Autenticação**: JWT via `@nestjs/jwt` + `@nestjs/passport`, `bcrypt` para hash de senha

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

### Autenticação

As rotas de `/tickets` são protegidas pelo `JwtAuthGuard` (`@UseGuards(JwtAuthGuard)` no nível do controller), que delega para uma strategy `jwt` do Passport. `POST /auth/register` faz hash da senha com bcrypt e retorna um token assinado; `POST /auth/login` verifica as credenciais da mesma forma. O segredo e o tempo de expiração são lidos via `ConfigService` dentro de `JwtModule.registerAsync` — não direto de `process.env` no momento da decoração do módulo, o que rodaria antes do `ConfigModule` carregar o `.env` e assinaria os tokens com um segredo desatualizado/padrão.

Envie o token como `Authorization: Bearer <token>` em qualquer requisição para `/tickets`.

### Estrutura do projeto

```
src/
  main.ts                 # bootstrap da app, pipes globais
  app.module.ts            # módulo raiz: Config, Cache (Redis), Bull, Prisma, Auth, Tickets
  auth/
    auth.controller.ts     # POST /auth/register, POST /auth/login
    auth.service.ts        # hash de senha, checagem de credenciais, assinatura do token
    jwt-auth.guard.ts       # guard usado nos controllers protegidos
    strategies/jwt.strategy.ts
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

| Método | Rota              | Auth | Body               | Descrição                        |
|--------|-------------------|------|--------------------|-----------------------------------|
| POST   | `/auth/register`  | –    | `RegisterDto`      | Cria um usuário, retorna um JWT  |
| POST   | `/auth/login`     | –    | `LoginDto`         | Verifica as credenciais, retorna um JWT |
| POST   | `/tickets`        | JWT  | `CreateTicketDto`  | Cria um ticket                   |
| GET    | `/tickets`        | JWT  | –                  | Lista os tickets, mais recentes primeiro |
| GET    | `/tickets/:id`    | JWT  | –                  | Busca um ticket (404 se não existir) |
| PATCH  | `/tickets/:id`    | JWT  | `UpdateTicketDto`  | Atualização parcial, incl. mudança de status |
| DELETE | `/tickets/:id`    | JWT  | –                  | Remove um ticket                 |

`CreateTicketDto` exige `title` (mínimo 3 caracteres); `description` e `priority` são opcionais. `UpdateTicketDto` torna todos os campos de `CreateTicketDto` opcionais e aceita adicionalmente `status`. `RegisterDto` exige `name`, um `email` válido e `password` (mínimo 8 caracteres); `LoginDto` exige `email` e `password`.

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

## CI

`.github/workflows/ci.yml` roda em todo push/PR pra `main`:

1. checkout + setup do Node 24 (com cache do npm)
2. `npm ci`
3. `eslint` (sem autocorreção — quebra o build se houver qualquer problema)
4. `prisma migrate deploy` contra um container de serviço Postgres
5. `nest build`
6. testes unitários (`npm test`)
7. testes e2e (`npm run test:e2e`)

Postgres e Redis rodam como **service containers** do GitHub Actions (`postgres:16`, `redis:7-alpine`), cada um com health check que o job aguarda antes de rodar as migrations — é o que a suíte e2e precisa, já que ela sobe o `AppModule` de verdade (banco + cache + fila inclusos), não uma versão mockada.

## Roadmap

- Cobertura de testes unitários e e2e além dos padrões gerados
