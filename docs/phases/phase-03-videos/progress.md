# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 12/12 completed

## Definition of Done — Verificação (2026-07-14)

Ambiente zerado (`docker compose down -v` → `up --build` → `migration:run`) e suíte completa rodada do zero para validar a Definition of Done do `CLAUDE.md` raiz. Bugs encontrados e corrigidos durante essa verificação (nenhum exige `AskUserQuestion` — todos são correções mecânicas de teste, sem decisão de design):

- `auth.module.spec.ts` / `users.module.spec.ts` / `channels.module.spec.ts` — faltava `Video` em `ALL_ENTITIES`; `Channel` ganhou `@OneToMany(() => Video, ...)` na Fase 03 e o TypeORM exige a entidade relacionada registrada, mesmo em specs de módulo que não usam `Video` diretamente.
- `env.validation.integration-spec.ts` — faltavam `STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` (obrigatórias em `env.validation.ts` desde a Fase 03) no payload de env do teste.
- `video-processing.worker.integration-spec.ts` — o teste dependia do bucket MinIO e da fila pg-boss já existirem, criados só como efeito colateral de `VideosService.onModuleInit()` (que roda no processo da API, não no `WorkerModule`). Corrigido: o teste agora provisiona bucket e fila por conta própria (`ensureBucketAndQueueExist()`) antes de inicializar o módulo, sem depender da API ter sido iniciada antes.
- `database/migrations.integration-spec.ts` (bug pré-existente, anterior à Fase 03) — o `beforeAll` fazia `DROP TABLE ... CASCADE` nas tabelas de auth, mas isso não remove o tipo enum (`verification_tokens_type_enum`) nem limpa a tabela `videos` (que tem FK para `channels`). Isso corrompia o Postgres compartilhado para as suites seguintes (linhas órfãs em `videos`, "type already exists" ao reaplicar migrations). Corrigido: `DROP TYPE IF EXISTS` explícito + `DELETE FROM "videos"` antes de derrubar `channels`/`users`.
- `package.json` (`test:e2e`) — o `nestjs-project/CLAUDE.md` já documentava e2e "rodando com `--runInBand`", mas o script real não tinha a flag; `npm run test:e2e` sem `--runInBand` roda as suites e2e em paralelo contra o mesmo Postgres, causando corrida (FK violations, `409` virando `201`, `403`/`404` virando `401`). Corrigido adicionando `--runInBand` ao script, para bater com o que já estava documentado.

Resultado após as correções: `npm test -- --runInBand` (181/181), `npm run test:e2e` (70/70), `npx tsc --noEmit` (0 erros) — todos rodados a partir de um ambiente Docker 100% zerado.

### Lint — dívida pré-existente, resolvida separadamente

`npm run lint` acusou **150 errors, 40 warnings** nesta verificação. Confirmado via `git diff dev` que nenhum desses erros estava em arquivo da Fase 03 — todos em specs de teste pré-existentes (`channels.service.spec.ts`, `channels.service.ts`, `mail.service.integration-spec.ts`, `test/auth.e2e-spec.ts`, `common/filters/*.spec.ts`, `create-test-data-source.ts`, etc.), a mesma dívida já sinalizada na SI-03.1. Por ser fora do escopo de vídeos, a correção foi feita em branch própria (`bugfix/lint-pre-existing-debt`, a partir da `dev`), não nesta feature — resultado: `npm run lint` limpo (0 errors, 1 warning pré-existente que não bloqueia o comando). Definition of Done do `CLAUDE.md` agora 100% satisfeita.

### SI-03.1 — Infra: object storage (MinIO) e configuração de fila (pg-boss)
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Verificado manualmente (fora do escopo formal de testes da SI, que é Infra): `docker compose up -d` sobe os 4 serviços saudáveis; app falha ao subir com `Config validation error: "STORAGE_ACCESS_KEY" is required` quando a env var é removida.
  - `npm run lint` tem 150 erros pré-existentes em arquivos não tocados por esta fase (`test/auth.e2e-spec.ts`, `src/users/users.service.integration-spec.ts`, `src/test/create-test-data-source.ts`) — confirmado via `git diff dev` que já existiam antes desta fase. Fora de escopo desta SI; sinalizar antes da Definition of Done final da fase.

### SI-03.2 — Entidade Video e migration
- **Status:** completed
- **Tests:** 6 passing
- **Observations:**
  - Antes de implementar, parei e corrigi o plano (`phase-03-videos.md` + specs em `nestjs-project/specs/`) em duas frentes: (1) convertido Data Model/API Contracts de camelCase para `snake_case`, consistente com `Channel`/`User`/`AuthController` já existentes (nenhuma `NamingStrategy` configurada); (2) descoberto que o `JwtPayload` (Fase 02) só carrega `sub`/`email`, sem `channelId` — adicionada a ação de criar `ChannelsService.findByUserId()` na SI-03.4 e propagada a resolução do canal nas SIs 03.5/03.6/03.8. Decisão confirmada com o usuário via AskUserQuestion.
  - `ChannelsModule` não é importado por nenhum módulo de domínio ainda (só via `UsersModule`, que não o re-exporta) — `VideosModule` vai precisar importá-lo diretamente na SI-03.4.
  - Adicionada limpeza da tabela `videos` em `cleanAllTables()` (`src/test/create-test-data-source.ts`), compartilhada por todos os testes de integração.

### SI-03.3 — VideosService: criação de vídeo e upload multipart pré-assinado
- **Status:** completed
- **Tests:** 11 passing (5 unit + 6 integration; contando os 2 novos casos de `onModuleInit`/bucket)
- **Observations:**
  - **Descoberta importante:** `pg-boss@12.x` publica `"type": "module"` (ESM-only, sem build CJS) — o Jest (`ts-jest` visando CommonJS) não conseguia carregar o pacote, mesmo o app rodando normalmente via `require(esm)` nativo do Node 25. Fixei em `pg-boss@^11.1.2` (última major `"type": "commonjs"`, mesma API `createQueue`/`work`/`send`, só troca `import { PgBoss }` por `import PgBoss from 'pg-boss'` — `export =` estilo CJS). Atualizado `package.json`, `queue.module.ts`, `videos.service.ts` e `library-refs.md` (nota de versão). TD-01 (decisão de usar pg-boss) não muda — só o pin de versão.
  - Gap encontrado no plano: `generatePresignedPartUrls` documentava o erro `INVALID_PART_NUMBERS` no Error Catalog/API Contracts, mas a ação técnica original não implementava nenhuma validação de intervalo. Adicionei a checagem (1–10000, limite do protocolo S3 multipart) + `InvalidPartNumbersException`, e atualizei o plano (technical action 2, action 5, e uma AC nova).
  - Gap de infra encontrado: nada criava o bucket MinIO (`SI-03.1` só subiu o serviço). Adicionei `ensureBucketExists()` ao `onModuleInit` do `VideosService` (idempotente — ignora `BucketAlreadyOwnedByYou`/`BucketAlreadyExists`) e documentei a lacuna no plano.
  - Teste de integração usa `fetch()` nativo (Node 25) para de fato enviar a parte via URL pré-assinada e capturar o `ETag` real, depois completa o upload — exercita o fluxo real MinIO, sem mocks.

### SI-03.4 — Endpoint POST /videos
- **Status:** completed
- **Tests:** 3 passing (e2e via spec `nestjs-project/specs/videos-create.plan.md` → `test/videos-create.e2e-spec.ts`); 2 novos testes de integração em `channels.service.integration-spec.ts` para `findByUserId`
- **Observations:**
  - Adicionado `ChannelsService.findByUserId()` (resolve o canal do usuário autenticado a partir de `user.sub`), importado `ChannelsModule` em `VideosModule`.
  - `test/videos-create.e2e-spec.ts` segue exatamente o padrão de `test/auth.e2e-spec.ts` (register→confirm→login para obter `access_token`); os mesmos lint warnings de `any` em `res.body.*` já existentes em `auth.e2e-spec.ts` se repetem aqui — debt herdado, não introduzido por esta SI (confirmado via `git diff dev`).
  - `VideosController` documentado com `@nestjs/swagger` seguindo o padrão de `AuthController` (envelope de erro compartilhado, `@ApiBearerAuth`).

### SI-03.5 — Endpoint POST /videos/:id/upload-urls
- **Status:** completed
- **Tests:** 3 passing (e2e via spec `nestjs-project/specs/videos-upload-urls.plan.md`)
- **Observations:**
  - Extraído `test/helpers/auth.ts` (`registerConfirmAndLogin`) do que antes era duplicado inline em `videos-create.e2e-spec.ts` — evita repetir o mesmo helper nas próximas ~5 specs de vídeo que também precisam de login. `videos-create.e2e-spec.ts` atualizado para usar o helper compartilhado (mesmo comportamento, sem duplicação).

### SI-03.6 — Endpoint POST /videos/:id/complete-upload
- **Status:** completed
- **Tests:** 3 passing (e2e via spec `nestjs-project/specs/videos-complete-upload.plan.md`)
- **Observations:**
  - `VideosService.completeUpload` já existia desde a SI-03.3 (implementado antecipadamente com o multipart flow); esta SI só adicionou o handler do controller e os testes E2E.
  - Cenário 1.3 (job publicado na fila) consulta `pgboss.job` diretamente via `dataSource.query`, filtrando por `data->>'video_id'` — confirma o payload `{ video_id }` do evento `video.process` documentado em `### Events/Messages`.
  - `test/videos-complete-upload.e2e-spec.ts` repete o mesmo padrão de `any` não tipado em `res.body.*` já presente em `videos-create.e2e-spec.ts`/`videos-upload-urls.e2e-spec.ts` — debt herdado, consistente com as SIs anteriores.

### SI-03.7 — VideosDeliveryService: consulta e URLs de entrega
- **Status:** completed
- **Tests:** 9 passing (7 unit + 2 integration)
- **Observations:**
  - Adicionada `VideoNotReadyException` (409) ao catálogo de exceções — não existia ainda, necessária para o guard de `getPresignedReadUrl`.
  - `findByIdForViewer` oculta vídeos alheios em `draft`/`processing`/`error` atrás do mesmo `VideoNotFoundException` de "não existe" (nunca `403`), conforme a nota do Authorization Matrix ("oculta a existência de rascunhos alheios").
  - Testes unitários cobrem só os branches de guard (not found / not owned / not ready) — o caminho de sucesso do presign (URL real com `ResponseContentDisposition`) é exercitado apenas no teste de integração contra o MinIO real, evitando invocar `getSignedUrl` com um `S3Client` mockado (que não tem `config` real e quebraria).
  - `VideosDeliveryService` registrado e exportado em `VideosModule` junto com `VideosService`, pronto para os controllers das SIs 03.8/03.9/03.10.

### SI-03.8 — Endpoint GET /videos/:id
- **Status:** completed
- **Tests:** 11 passing (3 e2e via spec `nestjs-project/specs/videos-get.plan.md` + 8 unit em `jwt-auth.guard.spec.ts`, incluindo os 3 novos de `@OptionalAuth()`)
- **Observations:**
  - **Gap de infra descoberto e confirmado com o usuário via `AskUserQuestion`:** o plano exige que `GET /videos/:id` seja `@Public()` mas ainda assim resolva `channel = await channelsService.findByUserId(user.sub)` quando autenticado (para o dono ver o próprio rascunho). O `JwtAuthGuard` existente, ao ver `@Public()`, retorna `true` imediatamente e nunca popula `request.user`, mesmo com um Bearer token válido — não havia suporte a "autenticação opcional" no guard. Usuário escolheu a opção recomendada: criar um decorator novo e distinto, `@OptionalAuth()` (`src/auth/decorators/optional-auth.decorator.ts`), em vez de alterar a semântica de `@Public()` (que afetaria as 8 rotas públicas já existentes).
  - `JwtAuthGuard.canActivate` estendido: quando `@OptionalAuth()`, tenta validar o Bearer token se presente (populando `request.user`), mas nunca bloqueia a requisição — token ausente, malformado ou expirado são tratados como anônimo, não como erro. Comportamento de `@Public()` e das rotas autenticadas obrigatórias ficou inalterado (verificado com os testes existentes de `jwt-auth.guard.spec.ts`, todos ainda passando).
  - Resposta do endpoint mapeada explicitamente para `{id, title, description, status, duration_seconds, created_at}` (não retorna a entidade `Video` completa) — diferente do padrão usado em `create`/`completeUpload` (que retornam mais campos da entidade), porque este endpoint é público/anônimo e não deve vazar `channel_id`, `storage_key`, `upload_id` internos.

### SI-03.9 — Endpoint GET /videos/:id/stream
- **Status:** completed
- **Tests:** 3 passing (e2e via spec `nestjs-project/specs/videos-stream.plan.md`)
- **Observations:**
  - Usa `@Public()` (não `@OptionalAuth()` como a SI-03.8) — o Authorization Matrix não prevê exceção de dono para streaming/download de vídeos não-`ready`, só a regra geral de status.
  - Implementado com o decorator `@Redirect()` do NestJS (handler retorna `{ url, statusCode }`), em vez de `@Res()` manual — mais simples e testável sem acoplar à resposta do Express.
  - Não é necessário repassar manualmente o header `Range` no redirecionamento: clientes HTTP reenviam o mesmo header `Range` na requisição seguinte ao `Location`, e o MinIO/S3 trata `Range`/`206` nativamente (per TD-07) — nenhuma lógica adicional no controller.

### SI-03.10 — Endpoint GET /videos/:id/download
- **Status:** completed
- **Tests:** 3 passing (e2e via spec `nestjs-project/specs/videos-download.plan.md`)
- **Observations:**
  - Mesmo padrão da SI-03.9 (`@Public()` + `@Redirect()`), só troca `getPresignedReadUrl(id, true)` para incluir `ResponseContentDisposition: attachment` no presign.
  - Teste 1.1 verifica o header `Location` contém `response-content-disposition=attachment` (case-insensitive), confirmando que o modo download força o attachment em vez da reprodução inline.

### SI-03.11 — Infra: worker de processamento de vídeo (bootstrap)
- **Status:** completed
- **Tests:** no tests (Infra) — verificado manualmente: `docker compose up -d video-worker` sobe o container com status `running`, sem portas expostas; `ffmpeg -version`/`ffprobe -version` executam com sucesso; `npx nest start --entryFile worker.main` inicializa o `WorkerModule` (todos os módulos, incluindo `VideoProcessingWorker.onModuleInit`) sem subir listener HTTP.
- **Observations:**
  - Gap de sequenciamento do plano: a ação técnica pede para declarar `VideoProcessingWorker` como provider do `WorkerModule` nesta SI, mas a classe só ganha lógica real na SI-03.12 (que depende desta SI + SI-03.3). Resolvido criando um stub mínimo (`OnModuleInit` que só loga o bootstrap) em `src/worker/video-processing.worker.ts` — a SI-03.12 vai estender o mesmo arquivo com a injeção de `PgBoss`/`Repository<Video>`/`S3Client` e o `boss.work(...)`. Não é uma lacuna arquitetural (como os gaps de channelId/auth opcional das SIs anteriores), só uma questão de ordenação dentro da mesma SI subsequente — não fiz `AskUserQuestion`.
  - `WorkerModule` duplica a configuração de `ConfigModule`/`TypeOrmModule.forRootAsync` do `AppModule` (mesmo padrão, mesmas entidades `User`/`Channel`/`Video`) — decisão já registrada em TD-04 (Option A): reaproveitar os mesmos padrões de configuração/entidades em vez de reescrever, evitando duplicar infraestrutura de acesso a dados.
  - `Dockerfile.worker` segue o mesmo padrão idle (`tail -f /dev/null`) do `Dockerfile.dev` da API — o processo real do worker roda via `docker compose exec video-worker npm run start:worker:dev`, nunca automaticamente ao subir o container, consistente com a convenção do projeto de nunca iniciar o processo da aplicação como parte de "subir o ambiente".
  - Adicionados scripts `start:worker:dev` (`nest start --watch --entryFile worker.main`) e `start:worker:prod` (`node dist/worker.main`) ao `package.json` — `--entryFile` confirmado via `nest start --help` dentro do container antes de usar.

### SI-03.12 — VideoProcessingWorker: processamento do vídeo
- **Status:** completed
- **Tests:** 15 passing (4 unit + 2 integration em `video-processing.worker` + 9 unit de regressão em `videos.service.spec.ts`, afetado pela mudança de retry policy)
- **Observations:**
  - `VideoProcessingWorker` reescrito por completo (era um stub desde a SI-03.11): baixa o objeto do storage para um arquivo temporário (`GetObjectCommand` + `pipeline`), extrai duração via `ffmpeg.ffprobe()`, gera thumbnail via `.screenshots({timestamps: ['50%']})`, envia a thumbnail via `Upload` do `@aws-sdk/lib-storage` (per library-refs.md — helper indicado especificamente para upload de arquivo local já em disco), e atualiza o vídeo.
  - **Decisão de design para o ciclo de status (TD-08), não fez `AskUserQuestion`:** em vez de introduzir uma dead-letter queue separada para só then marcar `error` "depois de esgotados os retries" (mais infraestrutura, não pedido por nenhuma capability), o handler marca `status: error` + `error_message` em QUALQUER falha e **relança o erro** — isso deixa o `boss.work()` acionar o retry nativo do pg-boss (retryLimit/retryBackoff configurados na criação da fila); se uma tentativa posterior tiver sucesso, o status é sobrescrito para `ready` (consistente com o requisito de idempotência: reprocessar reescreve os mesmos campos sem efeito colateral duplicado). O estado final observado após esgotar os retries é `error`, que é o que a AC pede — sem precisar de uma segunda fila/handler.
  - Para que o retry nativo do TD-08 exista de fato, adicionada `VIDEO_PROCESSING_RETRY_POLICY = { retryLimit: 3, retryBackoff: true }` em `videos.constants.ts`, aplicada em `VideosService.onModuleInit()`'s `boss.createQueue(...)` (SI-03.1/03.3 só criavam a fila sem política de retry). Ajustada a asserção correspondente em `videos.service.spec.ts`.
  - Testes unitários usam `jest.spyOn(worker as any, '<privateMethod>')` para isolar os branches de sucesso/falha sem precisar simular a API de eventos/callback do `fluent-ffmpeg` (mesma abordagem já usada para `getSignedUrl` nas SIs anteriores: chamadas reais a bibliotecas externas sem seam de DI são cobertas pelo teste de integração, não pelo unitário).
  - Teste de integração roda no container `video-worker` (não `nestjs-api`) porque só ele tem os binários `ffmpeg`/`ffprobe` instalados — usa um vídeo de fixture real gerado com `ffmpeg -f lavfi` (`src/worker/fixtures/sample-video.mp4`, ~22KB, 2s) contra MinIO real, processando duração/thumbnail de verdade.
  - `fluent-ffmpeg@2.1.3` está marcado `deprecated` no npm ("Package no longer supported") — mesmo assim é a opção decidida em TD-05 (única lib que cobre `ffprobe()`/`.screenshots()` prontos); sinalizando aqui como nota de risco de manutenção futura, não uma lacuna desta fase.
  - `jest.Mocked<Repository<Video>>` disparou `@typescript-eslint/unbound-method` ao usar `expect(videoRepository.save).toHaveBeenCalledWith(...)` (o tipo real de `Repository.save` é um método de classe, não uma função pura) — resolvido tipando o mock como `{ findOne: jest.Mock; save: jest.Mock }` em vez do tipo completo do TypeORM.
