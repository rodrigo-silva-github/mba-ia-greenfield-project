---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-12T23:17:38.332225025+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-13T22:56:13.936273367+00:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-12T23:17:38.332225025+00:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-07-12T23:17:38.332225025+00:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-12T23:17:38.332225025+00:00"
  docs/phases/phase-02-auth/context.md: "2026-07-12T23:17:38.332225025+00:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-12T23:17:38.332225025+00:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-12T23:17:38.305248707+00:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-13T23:07:36.622481479+00:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified in project-plan.md._ (O documento de decisões da fase precisa que o frontend de vídeo — `next-frontend/` — está explicitamente fora do escopo: "Há um frontend no repositório, mas a interface de vídeo não faz parte do escopo desta fase.")

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (novo módulo de vídeos, integração storage/fila/worker, migration da tabela de vídeos, novos serviços no `compose.yaml`).

**Deferred subprojects:** `next-frontend/` — fora do escopo desta fase (nenhum TD do documento de decisões toca o frontend).

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

_(from decisions-reader — one row per TD across phase-scope + ad-hoc docs)_

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Tecnologia de Fila de Processamento | decided | Option B — pg-boss | pg-boss |
| phase-03-videos/TD-02 | phase | Backend | Estratégia de Upload de Vídeos de até 10GB | decided | Option B — Upload pré-assinado multipart direto ao storage | — |
| phase-03-videos/TD-03 | phase | Backend | SDK e Organização do Object Storage | decided | Option A — AWS SDK v3 | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/lib-storage |
| phase-03-videos/TD-04 | phase | Backend | Arquitetura do Worker de Processamento de Vídeo | decided | Option A — Aplicação standalone NestJS, container próprio | — |
| phase-03-videos/TD-05 | phase | Backend | Biblioteca de Integração com FFmpeg | decided | Option A — `fluent-ffmpeg` | fluent-ffmpeg |
| phase-03-videos/TD-06 | phase | Backend | Estratégia de Identificador Único do Vídeo (URL) | decided | Option A — Reaproveitar o UUID v4 da chave primária | — |
| phase-03-videos/TD-07 | phase | Backend | Estratégia de Entrega de Vídeo (Streaming e Download) | decided | Option B — Redirecionamento para URL pré-assinada de leitura | — |
| phase-03-videos/TD-08 | phase | Backend | Ciclo de Status do Vídeo e Tratamento de Falha no Processamento | decided | Option A — Enum de status linear + coluna de erro | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

_(current-phase TDs only — from decisions-detail-reader)_

### phase-03-videos/TD-01

**Recommendation:** a arquitetura já reserva um container dedicado de fila (`ContainerQueue(queue, "Message Queue", "TBD", ...)`), então introduzir Redis está dentro do escopo pretendido, não é overhead extra. Entre as três, BullMQ é a opção mais madura e documentada para exatamente este tipo de carga (jobs de processamento de mídia com retry/backoff/concorrência), com o menor risco de faltar alguma funcionalidade durante a implementação. pg-boss é uma alternativa legítima e mais barata em infraestrutura para quem quer evitar Redis; fica registrada como a segunda opção viável caso o custo de mais um serviço no Compose seja indesejado.
**Libraries:** pg-boss

### phase-03-videos/TD-02

**Recommendation:** é a única opção que mantém a API fora do caminho dos bytes do arquivo (satisfazendo literalmente "sem travar o sistema"), resolve o limite de 10GB dentro do protocolo S3 padrão (multipart, não single-PUT) e é consistente com o relacionamento já desenhado no C4 (`frontend → storage`, streaming). O pré-cadastro do vídeo como rascunho acontece na mesma chamada que inicia o multipart upload, satisfazendo a segunda capability coberta por este TD.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** é a única opção compatível com a migração MinIO → S3 já planejada pelo projeto sem reescrever código, além de já ser a base necessária para o upload multipart pré-assinado decidido no TD-02.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/lib-storage

### phase-03-videos/TD-04

**Recommendation:** é a única opção que respeita simultaneamente o C4 (container separado) e o princípio de reaproveitar os padrões já estabelecidos do projeto (config, entidades, repository pattern), evitando duplicar infraestrutura de acesso a dados só para o worker.
**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** cobre exatamente as duas operações exigidas (`ffprobe()` para metadados, `.screenshots()` para thumbnail) com métodos documentados e testados, evitando código de parsing/CLI feito à mão sem benefício correspondente neste escopo.
**Libraries:** fluent-ffmpeg

### phase-03-videos/TD-06

**Recommendation:** reaproveitar o UUID v4 da PK evita introduzir uma nova coluna/mecanismo de geração só para a URL, é o caminho de menor risco de colisão e mantém a consistência com toda entidade já existente no projeto.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** é a única opção coerente com o relacionamento já desenhado no C4 e evita reimplementar manualmente o suporte a `Range`/`206` que o storage S3-compatível já oferece pronto, mantendo a API fora do caminho dos bytes tanto no upload quanto na entrega.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** atende literalmente à capability desta fase (estado atual refletido no banco) sem construir infraestrutura de auditoria não solicitada; o retry nativo da fila escolhida no TD-01 já cobre a resiliência a falhas transitórias antes de o vídeo chegar ao estado terminal `error`.
**Libraries:** —

## Inherited Decisions Detail

_(inherited TDs from prior phases + correlator-confirmed docs — dedupe applied)_

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS.
**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively.
**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication.
**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. OWASP minimum: 19MiB memory, 2 iterations.
**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — Only email/password auth for now, but the plugin architecture costs little and future phases may add social login.
**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Strongest security model with automatic theft detection. DB write overhead acceptable for a video platform. Race conditions mitigated with a short grace period for the old token.
**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability important: new password reset invalidates previous tokens. Tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from JWT auth.
**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matches arch diagram), works with MailHog/Mailpit locally. Template engine (Handlebars) simplifies email formatting.
**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — Backend-only project (no shared schemas with frontend). class-validator is the documented NestJS approach; project already uses decorators extensively.
**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Machine-readable error codes the Next.js frontend can switch on. Single-consumer project; simple `{ statusCode, error, message }` format with domain codes.
**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`. Single-instance, in-memory storage sufficient.
**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, simpler to generate.
**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size for a single token format across the codebase.
**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — Video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is simplest and most portable; `user_<random>` fallback provides a valid handle even for extreme email prefixes.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Ambos) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Apenas em dev/staging) — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI").
**Libraries:** —

### next-frontend-openapi-typing/TD-01

**Recommendation:** Option A (`openapi-typescript` + `openapi-fetch`) — Strict BFF makes a generated SDK surface valueless on the client; types-first matches the rest of the FE foundation; MSW typing is solved by the same `paths` symbol.
**Libraries:** openapi-typescript, openapi-fetch

### next-frontend-openapi-typing/TD-02

**Recommendation:** Option B (committed local copy + repo-root sync script) — preserva a independência dos stacks Docker; drift eliminado estruturalmente quando pareado com o CI freshness check de TD-03.
**Libraries:** —

### next-frontend-openapi-typing/TD-03

**Recommendation:** Option C (committed + CI freshness check) — é a única opção que torna o drift de contrato visível nos diffs de PR e impossível de mergear acidentalmente.
**Libraries:** —

### next-frontend-openapi-typing/TD-04

**Recommendation:** Option A (single `lib/api/contracts.ts` com aliases explícitos) — trata pass-through e reshape com o mesmo mecanismo, dá um único alvo de grep para "que shape o BFF expõe", e desacopla imports de Componentes dos caminhos de arquivo do App Router.
**Libraries:** —

### next-frontend-openapi-typing/TD-05

**Recommendation:** Option A (hand-written, tipado via `paths`) — determinismo sobre auto-geração; coerência com TD-01 (mesmo `paths` como âncora de contrato); escala adequada ao número atual de endpoints.
**Libraries:** —

## Inherited Conventions

_(from phases-reader — compact list; sourced from prior phases in phase mode)_

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories, one file per domain in `src/config/`. _(from phase 01)_
- Env variables validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, ... })`. _(from phase 01)_
- Config injected via `ConfigType<typeof xxxConfig>` + `@Inject(xxxConfig.KEY)`; same factory importable as a plain function for non-DI contexts (TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection params sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), `useFactory` returns options incl. `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

_(from phases-reader — informational-only; plan-validate does NOT fire issues based on unaddressed entries)_

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | Logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | Umbrella bullet's full coverage requires the confirmação and reset-password destination screens, both deferred (rows above). The 3 ship-this-phase telas (signup, login, forgot-password) are covered; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## Non-UI / Deferred Capabilities

_(empty on first assembly — plan-resolve appends rows as user marks capabilities)_

_None._

## Testing Requirements

_(from testing-guide-nestjs-project — Feature Implementation Checklist)_

### nestjs-project

| Artifact type | Required tests |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

### next-frontend (deferred)

_Deferred subproject — fora do escopo desta fase (frontend de vídeo não faz parte da Fase 03)._
