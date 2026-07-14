---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-07-13T23:08:13.069869593+00:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-13T23:07:36.622481479+00:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-13T22:56:13.936273367+00:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-12T23:17:38.332225025+00:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-07-12T23:17:38.332225025+00:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-12T23:17:38.332225025+00:00"
  docs/phases/phase-02-auth/context.md: "2026-07-12T23:17:38.332225025+00:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-12T23:17:38.332225025+00:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-12T23:17:38.305248707+00:00"
---

# Fase 03 — Upload e Processamento de Vídeos

## Objective

Implementar upload de vídeos de até 10GB sem travar a API (upload pré-assinado multipart direto ao storage), com pré-cadastro automático do vídeo como rascunho, processamento assíncrono automático (extração de duração/metadados e geração de thumbnail via worker FFmpeg consumindo fila pg-boss), URL única por vídeo, e reprodução via streaming e download — entregando upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando e URLs únicas geradas.

---

## Step Implementations

### SI-03.1 — Infra: object storage (MinIO) e configuração de fila (pg-boss)

**Description:** Provisiona o object storage (MinIO/S3) no Compose e configura os módulos base de storage e fila que as demais SIs desta fase vão consumir.

**Technical actions:**

1. Adicionar serviço `minio` ao `compose.yaml` (portas API + console, volume nomeado, healthcheck) — per `phase-03-videos/TD-03`
2. Adicionar as dependências `pg-boss`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` e `@aws-sdk/lib-storage` ao `nestjs-api` — per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`
3. Criar `src/config/storage.config.ts` (`registerAs('storage', ...)`) com endpoint, bucket, região e credenciais do MinIO, e adicionar as novas variáveis ao `env.validation.ts` (Joi) — seguindo a convenção herdada _(from phase 01)_
4. Criar `src/queue/queue.module.ts` — módulo global que provê um `PgBoss` singleton (construído a partir da mesma connection string de `databaseConfig`), iniciado via `onModuleInit`/parado via `onModuleDestroy` — per `phase-03-videos/TD-01`
5. Criar `src/storage/storage.module.ts` — módulo global que provê um `S3Client` singleton (`endpoint`/`forcePathStyle: true` a partir de `storage.config.ts`) — per `phase-03-videos/TD-03`

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe os serviços `nestjs-api`, `db`, `mailpit` e `minio`, todos com status `running`
- A aplicação falha ao subir com uma mensagem de validação clara quando uma variável de storage obrigatória está ausente

---

### SI-03.2 — Entidade Video e migration

**Description:** Cria a entidade `Video` e a migration que materializa a tabela, ligada ao canal per o Data Model da fase.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — entidade `Video` com todos os campos do Data Model, propriedades em `snake_case` espelhando as colunas (`id`, `channel_id`, `title`, `description`, `status` enum default `draft`, `error_message`, `storage_key`, `thumbnail_storage_key`, `upload_id`, `duration_seconds`, `size_bytes`, `mime_type`, `created_at`, `updated_at`) — per `### Data Model`
2. Adicionar relação `videos: Video[]` (one-to-many) na entidade `Channel` — per `### Data Model` → Relations
3. Criar migration `<timestamp>-CreateVideos.ts` — cria a tabela `videos` com FK para `channels`, índice em `channel_id` e índice em `status` — per `### Data Model` → Indexes
4. Criar o esqueleto de `src/videos/videos.module.ts` e registrar em `AppModule` (sem providers ainda)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults (`status` default `draft`), FK para `Channel` | `src/videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Rodar as migrations cria a tabela `videos` com as colunas e constraints documentadas no Data Model
- Inserir uma linha `Video` sem `status` assume o default `draft`
- Inserir uma linha `Video` com `channel_id` inexistente viola a constraint de FK

---

### SI-03.3 — VideosService: criação de vídeo e upload multipart pré-assinado

**Description:** Implementa o ciclo de escrita do vídeo — pré-cadastro como rascunho, geração de URLs pré-assinadas por parte e conclusão do multipart upload com publicação do evento de processamento.

**Technical actions:**

1. Criar `src/videos/videos.service.ts` (`VideosService`) — `createDraftAndInitiateUpload(channelId, dto)`: persiste o vídeo com `status: draft`, gera `storage_key` (`videos/{channelId}/{videoId}/original.<ext>`, per `phase-03-videos/TD-03`), chama `CreateMultipartUploadCommand` no storage e salva o `upload_id` retornado. `onModuleInit` registra a fila (per `phase-03-videos/TD-01`) e garante o bucket do storage (`CreateBucketCommand`, ignorando erro de "já existe") — lacuna da SI-03.1, que provisionou o serviço `minio` mas não o bucket em si
2. Implementar `generatePresignedPartUrls(videoId, channelId, partNumbers)` — valida existência (`VideoNotFoundException`), ownership (`VideoNotOwnedException`), upload ainda não concluído (`UploadAlreadyCompletedException`) e cada `partNumber` dentro do intervalo válido do protocolo S3 multipart (1 a 10000 — `InvalidPartNumbersException` caso contrário); gera uma URL pré-assinada de `UploadPartCommand` por `partNumber` — per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`
3. Implementar `completeUpload(videoId, channelId, parts)` — valida existência/ownership/estado, chama `CompleteMultipartUploadCommand`, transiciona `status: draft → processing`, limpa `upload_id` e publica o job `video.process` (`{ video_id }`) via `PgBoss.send()` — per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`, `phase-03-videos/TD-08`
4. Criar `src/videos/dto/create-video.dto.ts`, `upload-urls.dto.ts` e `complete-upload.dto.ts` com as validações de `### API Contracts` → Validation Rules
5. Criar as exceptions de domínio `VideoNotFoundException`, `VideoNotOwnedException`, `UploadAlreadyCompletedException` e `InvalidPartNumbersException`, mapeadas para os `errorCode`s de `### Error Catalog` — seguindo a convenção herdada do Custom Domain Exception Filter _(from `phase-02-auth/TD-07`)_

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: branch logic — ownership, upload já concluído, part numbers inválidos (mock repo + mock `S3Client` + mock `PgBoss`) | `src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: DB real + MinIO real (Compose) — `createDraftAndInitiateUpload` persiste rascunho e inicia multipart upload real; `completeUpload` transiciona status e publica na fila pg-boss real | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- `createDraftAndInitiateUpload` persiste um `Video` com `status: draft` e `upload_id` não-nulo
- Solicitar URLs de parte para um vídeo de outro canal lança `VideoNotOwnedException`
- Solicitar URLs de parte após o upload já concluído lança `UploadAlreadyCompletedException`
- `completeUpload` transiciona o vídeo para `status: processing`, limpa `upload_id` e enfileira um job `video.process` com o id do vídeo
- `generatePresignedPartUrls` retorna uma URL por `partNumber` solicitado
- `generatePresignedPartUrls` com um `partNumber` fora do intervalo 1–10000 lança `InvalidPartNumbersException`

---

### SI-03.4 — Endpoint POST /videos

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Owner

**Description:** Expõe o endpoint de pré-cadastro do vídeo e início do upload multipart.

**Technical actions:**

1. Adicionar `findByUserId(userId): Promise<Channel | null>` ao `ChannelsService` existente (`src/channels/channels.service.ts`) — resolve o canal do usuário autenticado a partir de `user.sub` (o JWT atual só carrega `sub`/`email`, sem `channelId`); importar `ChannelsModule` em `VideosModule`
2. Criar `src/videos/videos.controller.ts` (`@Controller('videos')`) com `@Post()` — resolve `channel = await channelsService.findByUserId(user.sub)` e chama `videosService.createDraftAndInitiateUpload(channel.id, dto)`, retornando `201` com `{id, status, upload_id, storage_key}` — per `### API Contracts`
3. Registrar `VideosController` em `VideosModule`

**Tests:** _(empty — E2E-only artifact; cenário coberto pelo spec referenciado em **Test Specs**)_

**Dependencies:** SI-03.3

**Acceptance criteria:**

- `POST /videos` com payload válido retorna `201` com `{id, status: "draft", upload_id, storage_key}`
- `POST /videos` sem `Authorization` retorna `401`
- `POST /videos` com `mime_type` fora do padrão `video/*` ou `size_bytes` acima de 10GB retorna `400`

---

### SI-03.5 — Endpoint POST /videos/:id/upload-urls

**Route:** POST /videos/:id/upload-urls
**Test Specs:** see `nestjs-project/specs/videos-upload-urls.plan.md`
**Authorization:** Owner

**Description:** Expõe o endpoint que devolve as URLs pré-assinadas de escrita por parte do multipart upload.

**Technical actions:**

1. Adicionar `@Post(':id/upload-urls')` ao `VideosController` — resolve `channel = await channelsService.findByUserId(user.sub)` (per `phase-03-videos/SI-03.4`) e chama `videosService.generatePresignedPartUrls(id, channel.id, dto.part_numbers)`, retornando `200` com `{urls}` — per `### API Contracts`

**Tests:** _(empty — E2E-only artifact; cenário coberto pelo spec referenciado em **Test Specs**)_

**Dependencies:** SI-03.4

**Acceptance criteria:**

- `POST /videos/:id/upload-urls` retorna `200` com uma URL por `part_number` solicitado
- Requisição para vídeo de outro canal retorna `403 VIDEO_NOT_OWNED`
- Requisição para vídeo inexistente retorna `404 VIDEO_NOT_FOUND`

---

### SI-03.6 — Endpoint POST /videos/:id/complete-upload

**Route:** POST /videos/:id/complete-upload
**Test Specs:** see `nestjs-project/specs/videos-complete-upload.plan.md`
**Authorization:** Owner

**Description:** Expõe o endpoint que conclui o multipart upload e dispara o processamento assíncrono.

**Technical actions:**

1. Adicionar `@Post(':id/complete-upload')` ao `VideosController` — resolve `channel = await channelsService.findByUserId(user.sub)` (per `phase-03-videos/SI-03.4`) e chama `videosService.completeUpload(id, channel.id, dto.parts)`, retornando `200` com `{id, status}` — per `### API Contracts`

**Tests:** _(empty — E2E-only artifact; cenário coberto pelo spec referenciado em **Test Specs**)_

**Dependencies:** SI-03.4

**Acceptance criteria:**

- `POST /videos/:id/complete-upload` com partes válidas retorna `200` com `status: "processing"`
- Chamar novamente após conclusão retorna `409 UPLOAD_ALREADY_COMPLETED`
- A conclusão publica o evento `video.process` na fila (verificável na tabela de jobs do pg-boss)

---

### SI-03.7 — VideosDeliveryService: consulta e URLs de entrega

**Description:** Implementa a leitura do vídeo respeitando as regras de visibilidade por status/ownership e a geração de URLs pré-assinadas de leitura para streaming e download.

**Technical actions:**

1. Criar `src/videos/videos-delivery.service.ts` (`VideosDeliveryService`) — `findByIdForViewer(videoId, viewerChannelId)`: retorna o vídeo quando `status: ready`, ou quando `viewerChannelId` é o dono (mesmo em `draft`/`processing`/`error`); caso contrário lança `VideoNotFoundException` (oculta a existência de rascunhos alheios) — per `### Authorization Matrix`
2. Implementar `getPresignedReadUrl(videoId, forDownload)` — valida `status: ready` (senão `VideoNotReadyException`), gera uma URL pré-assinada de `GetObjectCommand`, com `ResponseContentDisposition: attachment` quando `forDownload` — per `phase-03-videos/TD-07`, `phase-03-videos/TD-03`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosDeliveryService` | Unit: branch logic — visibilidade por status/ownership, guard de `status: ready` antes de gerar a URL de entrega | `src/videos/videos-delivery.service.spec.ts` |
| `VideosDeliveryService` | Integration: MinIO real (Compose) — URL pré-assinada de leitura resolve a chave correta; `ResponseContentDisposition` setado no modo download | `src/videos/videos-delivery.service.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- `findByIdForViewer` retorna um vídeo `ready` para qualquer requisitante, incluindo anônimo
- `findByIdForViewer` de um vídeo em `draft`/`processing`/`error` lança `VideoNotFoundException` quando o requisitante não é o dono
- `getPresignedReadUrl` de um vídeo com `status != ready` lança `VideoNotReadyException`

---

### SI-03.8 — Endpoint GET /videos/:id

**Route:** GET /videos/:id
**Test Specs:** see `nestjs-project/specs/videos-get.plan.md`
**Authorization:** Anonymous (vídeos `ready`); Owner (`draft`/`processing`/`error`)

**Description:** Expõe o endpoint de leitura dos metadados do vídeo.

**Technical actions:**

1. Adicionar `@Get(':id')` `@Public()` ao `VideosController` — quando autenticado, resolve `channel = await channelsService.findByUserId(user.sub)` (per `phase-03-videos/SI-03.4`); chama `videosDeliveryService.findByIdForViewer(id, channel?.id ?? null)`, retornando `200` com `{id, title, description, status, duration_seconds, created_at}` — per `### API Contracts`

**Tests:** _(empty — E2E-only artifact; cenário coberto pelo spec referenciado em **Test Specs**)_

**Dependencies:** SI-03.7, SI-03.4

**Acceptance criteria:**

- `GET /videos/:id` de um vídeo `ready` sem `Authorization` retorna `200` com os campos documentados
- `GET /videos/:id` de um vídeo em `draft` para um requisitante que não é o dono retorna `404 VIDEO_NOT_FOUND`
- `GET /videos/:id` de um `id` inexistente retorna `404 VIDEO_NOT_FOUND`

---

### SI-03.9 — Endpoint GET /videos/:id/stream

**Route:** GET /videos/:id/stream
**Test Specs:** see `nestjs-project/specs/videos-stream.plan.md`
**Authorization:** Anonymous (vídeos `ready`)

**Description:** Expõe o endpoint de streaming via redirecionamento para uma URL pré-assinada de leitura.

**Technical actions:**

1. Adicionar `@Get(':id/stream')` `@Public()` ao `VideosController` — valida `status: ready` via `videosDeliveryService.getPresignedReadUrl(id, false)` e redireciona (`302`) repassando o header `Range` recebido — per `phase-03-videos/TD-07`

**Tests:** _(empty — E2E-only artifact; cenário coberto pelo spec referenciado em **Test Specs**)_

**Dependencies:** SI-03.7, SI-03.4

**Acceptance criteria:**

- `GET /videos/:id/stream` de um vídeo `ready` retorna `302` redirecionando para uma URL pré-assinada de leitura
- `GET /videos/:id/stream` de um vídeo com `status != ready` retorna `409 VIDEO_NOT_READY`
- `GET /videos/:id/stream` de um `id` inexistente retorna `404 VIDEO_NOT_FOUND`

---

### SI-03.10 — Endpoint GET /videos/:id/download

**Route:** GET /videos/:id/download
**Test Specs:** see `nestjs-project/specs/videos-download.plan.md`
**Authorization:** Anonymous (vídeos `ready`)

**Description:** Expõe o endpoint de download via redirecionamento para uma URL pré-assinada de leitura com `Content-Disposition: attachment`.

**Technical actions:**

1. Adicionar `@Get(':id/download')` `@Public()` ao `VideosController` — valida `status: ready` via `videosDeliveryService.getPresignedReadUrl(id, true)` e redireciona (`302`) — per `phase-03-videos/TD-07`

**Tests:** _(empty — E2E-only artifact; cenário coberto pelo spec referenciado em **Test Specs**)_

**Dependencies:** SI-03.7, SI-03.4

**Acceptance criteria:**

- `GET /videos/:id/download` de um vídeo `ready` retorna `302` redirecionando para uma URL pré-assinada com `Content-Disposition: attachment`
- `GET /videos/:id/download` de um vídeo com `status != ready` retorna `409 VIDEO_NOT_READY`
- `GET /videos/:id/download` de um `id` inexistente retorna `404 VIDEO_NOT_FOUND`

---

### SI-03.11 — Infra: worker de processamento de vídeo (bootstrap)

**Description:** Provisiona o Video Worker como aplicação NestJS standalone em container próprio, com FFmpeg disponível para extração de metadados e geração de thumbnail.

**Technical actions:**

1. Criar `src/worker.main.ts` — `NestFactory.createApplicationContext(WorkerModule)`, sem listener HTTP — per `phase-03-videos/TD-04`
2. Criar `src/worker/worker.module.ts` — importa `ConfigModule`, `TypeOrmModule` (mesmas entidades), `QueueModule` e `StorageModule`, e declara `VideoProcessingWorker` como provider — per `phase-03-videos/TD-04`
3. Criar `Dockerfile.worker` instalando os binários `ffmpeg`/`ffprobe` no container — per `phase-03-videos/TD-05`
4. Adicionar o serviço `video-worker` ao `compose.yaml` — mesma base do `nestjs-api`, comando de start do worker, sem portas expostas — per `phase-03-videos/TD-04`

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- `docker compose up -d` sobe o serviço `video-worker` com status `running`, sem expor portas HTTP
- O container do worker tem os binários `ffmpeg` e `ffprobe` disponíveis (`ffmpeg -version` executa com sucesso)

---

### SI-03.12 — VideoProcessingWorker: processamento do vídeo

**Description:** Implementa o consumidor da fila que extrai duração/metadados, gera a thumbnail e atualiza o ciclo de status do vídeo.

**Technical actions:**

1. Criar `src/worker/video-processing.worker.ts` — injeta `PgBoss`, `Repository<Video>` e `S3Client`; no `onModuleInit`, registra `boss.work('video-processing', handler)` — per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`
2. Implementar o handler: baixa o objeto referenciado por `Video.storage_key` do storage para um arquivo temporário local — per `phase-03-videos/TD-03`
3. Extrair duração/metadados via `ffmpeg.ffprobe()` e gerar a thumbnail via `.screenshots({ timestamps: ['50%'] })`, enviando-a ao storage e populando `thumbnail_storage_key` — per `phase-03-videos/TD-05`
4. Em sucesso: atualizar `status → ready` e `duration_seconds` — per `phase-03-videos/TD-08`
5. Em falha (após esgotar os retries nativos do pg-boss): atualizar `status → error` e `error_message` — per `phase-03-videos/TD-08`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingWorker` | Unit: branch logic — sucesso atualiza `ready` + duração; falha atualiza `error` + `error_message` (mock ffmpeg/storage/repo) | `src/worker/video-processing.worker.spec.ts` |
| `VideoProcessingWorker` | Integration: MinIO real + `fluent-ffmpeg` real (arquivo de vídeo de fixture) + DB real — processa um vídeo e popula duração/thumbnail/status | `src/worker/video-processing.worker.integration-spec.ts` |

**Dependencies:** SI-03.11, SI-03.3

**Acceptance criteria:**

- Consumir o job `video.process` de um vídeo válido transiciona `status: processing → ready`, populando `duration_seconds` e `thumbnail_storage_key`
- Falha no processamento (após esgotar os retries) transiciona `status → error` e popula `error_message`
- O worker é idempotente — reprocessar o mesmo `video_id` re-extrai e reescreve os mesmos campos, sem efeito colateral duplicado

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated — also serves as the video's unique URL identifier *(per phase-03-videos/TD-06)* |
| channel_id | uuid | FK → `Channel.id`, not null |
| title | varchar(255) | not null |
| description | text | nullable |
| status | enum (`draft`, `processing`, `ready`, `error`) | not null, default `draft` *(per phase-03-videos/TD-08 — enum linear de status)* |
| error_message | text | nullable — populated only when `status = error` *(per phase-03-videos/TD-08)* |
| storage_key | varchar(1024) | not null — chave do arquivo de vídeo no bucket de storage *(per phase-03-videos/TD-03)* |
| thumbnail_storage_key | varchar(1024) | nullable — populada pelo worker após geração do thumbnail *(per phase-03-videos/TD-05)* |
| upload_id | varchar(255) | nullable — id do multipart upload no storage; limpo após `complete-upload` *(per phase-03-videos/TD-02)* |
| duration_seconds | integer | nullable — extraído via `ffprobe` pelo worker *(per phase-03-videos/TD-05)* |
| size_bytes | bigint | nullable — populado ao completar o upload |
| mime_type | varchar(255) | nullable — populado ao completar o upload |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | auto-update on change |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to one `Channel`.
**Indexes:** PK on `id`; index on `channel_id`; index on `status` (consultas do worker/consulta de progresso).

**Convenção de nomenclatura:** propriedades da entidade e campos do corpo JSON (request/response) usam `snake_case`, consistente com `Channel`/`User`/`AuthController` já existentes no projeto (nenhuma `NamingStrategy` configurada no `DataSource` — o nome da propriedade TypeScript é o nome da coluna). Identificadores puramente internos (parâmetros de método, variáveis TypeScript) seguem `camelCase` por convenção padrão do projeto.

---

### API Contracts

#### POST /videos (SI-03.X)

**Request headers:**
- Authorization: Bearer {access_token}, required

**Request body:**
- title: string, required — min 1, max 255 characters
- description: string, optional
- size_bytes: number, required — tamanho total do arquivo em bytes; usado para calcular o número de partes do multipart upload
- mime_type: string, required — deve começar com `video/`

**Response 201:**
- id: string (uuid) — identificador único do vídeo, usado como URL única
- status: string (`draft`)
- upload_id: string — id do multipart upload iniciado no storage
- storage_key: string

**Error responses:**
- 400 validation error: quando o corpo da requisição falha a validação (título ausente, `mime_type` fora do padrão `video/*`, `size_bytes` acima do limite de 10GB)
- 401 Unauthorized: quando o token de acesso é ausente ou inválido

---

#### POST /videos/:id/upload-urls (SI-03.X)

**Request headers:**
- Authorization: Bearer {access_token}, required

**Request body:**
- part_numbers: number[], required — números das partes do multipart upload para as quais se deseja uma URL pré-assinada

**Response 200:**
- urls: array of `{ part_number: number, url: string }` — uma URL pré-assinada de escrita por parte solicitada *(per phase-03-videos/TD-02, TD-03)*

**Error responses:**
- 403 VIDEO_NOT_OWNED: quando o vídeo não pertence ao canal do usuário autenticado
- 404 VIDEO_NOT_FOUND: quando o `id` não corresponde a um vídeo existente
- 409 UPLOAD_ALREADY_COMPLETED: quando o upload do vídeo já foi concluído
- 400 INVALID_PART_NUMBERS: quando algum `part_number` está fora do intervalo válido do multipart upload iniciado

---

#### POST /videos/:id/complete-upload (SI-03.X)

**Request headers:**
- Authorization: Bearer {access_token}, required

**Request body:**
- parts: array of `{ part_number: number, etag: string }`, required — partes enviadas diretamente ao storage pelo cliente

**Response 200:**
- id: string (uuid)
- status: string (`processing`)

**Error responses:**
- 403 VIDEO_NOT_OWNED: quando o vídeo não pertence ao canal do usuário autenticado
- 404 VIDEO_NOT_FOUND: quando o `id` não corresponde a um vídeo existente
- 409 UPLOAD_ALREADY_COMPLETED: quando o upload do vídeo já foi concluído anteriormente
- 400 validation error: quando `parts` está vazio ou mal formado

**Side effect:** ao completar o multipart upload no storage, publica o evento `video.process` na fila (ver `### Events/Messages`) e transiciona `status: draft → processing` *(per phase-03-videos/TD-01, TD-04, TD-08)*.

---

#### GET /videos/:id (SI-03.X)

**Request headers:**
- Authorization: Bearer {access_token}, opcional — necessário apenas para visualizar vídeos em `draft` ou `processing` do próprio canal

**Response 200:**
- id: string (uuid)
- title: string
- description: string | null
- status: string (`draft` | `processing` | `ready` | `error`)
- duration_seconds: number | null
- created_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o `id` não corresponde a um vídeo existente, ou quando o vídeo está em `draft`/`processing`/`error` e o requisitante não é o dono do canal (oculta a existência de rascunhos alheios)

---

#### GET /videos/:id/stream (SI-03.X)

**Request headers:**
- Range: bytes={start}-{end}, opcional — repassado ao redirecionamento *(per phase-03-videos/TD-07)*

**Response 302:** Redirecionamento para uma URL pré-assinada de leitura do arquivo de vídeo no storage, com suporte nativo a `Range` / `206 Partial Content` pelo storage S3-compatível *(per phase-03-videos/TD-07)*.

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o `id` não corresponde a um vídeo existente
- 409 VIDEO_NOT_READY: quando o vídeo existe mas `status != ready`

---

#### GET /videos/:id/download (SI-03.X)

**Response 302:** Redirecionamento para uma URL pré-assinada de leitura do arquivo de vídeo no storage, com `Content-Disposition: attachment` *(per phase-03-videos/TD-07)*.

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o `id` não corresponde a um vídeo existente
- 409 VIDEO_NOT_READY: quando o vídeo existe mas `status != ready`

---

#### Validation Rules — Backend

- `title`: required, min 1, max 255 characters
- `mime_type`: required, must start with `video/`
- `size_bytes`: required, must not exceed 10GB (10 × 1024³ bytes)
- `part_numbers` / `parts`: required, non-empty array

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ | ✗ | ✓ |
| POST /videos/:id/upload-urls | ✗ | ✗ | ✓ |
| POST /videos/:id/complete-upload | ✗ | ✗ | ✓ |
| GET /videos/:id (status `ready`) | ✓ | ✓ | ✓ |
| GET /videos/:id (status `draft`\|`processing`\|`error`) | ✗ | ✗ | ✓ |
| GET /videos/:id/stream (status `ready`) | ✓ | ✓ | ✓ |
| GET /videos/:id/download (status `ready`) | ✓ | ✓ | ✓ |

_"Owner" = usuário autenticado dono do canal ao qual o vídeo pertence. Anonymous streaming/download reflete a regra geral do projeto ("usuários anônimos podem assistir livremente") — aplicável apenas a vídeos com `status: ready`._

---

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `id` não corresponde a um vídeo existente, ou vídeo em rascunho/processamento não pertencente ao requisitante |
| VIDEO_NOT_OWNED | 403 | Usuário autenticado tenta operar sobre um vídeo de um canal que não é o seu |
| VIDEO_NOT_READY | 409 | Streaming/download solicitado para um vídeo cujo `status` ainda não é `ready` |
| UPLOAD_ALREADY_COMPLETED | 409 | Nova solicitação de `upload-urls` ou `complete-upload` para um vídeo cujo upload já foi concluído |
| INVALID_PART_NUMBERS | 400 | `part_numbers` fora do intervalo válido do multipart upload iniciado |

_Formato de erro herdado de `phase-02-auth/TD-07` — `{ statusCode, error, message }` via Custom Domain Exception Filter._

---

### Events/Messages

#### video.process

**Payload:**

```json
{ "video_id": "uuid" }
```

**Producer:** `VideosService` — publicado ao completar o multipart upload em `POST /videos/:id/complete-upload` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
**Consumer:** `VideoProcessingWorker` — aplicação NestJS standalone em container próprio (per `phase-03-videos/TD-04`)
**Trigger:** conclusão bem-sucedida do multipart upload no storage (transição `draft → processing`)
**Delivery semantics:** at-least-once, com retry/backoff nativo do pg-boss (per `phase-03-videos/TD-01`) — o worker deve ser idempotente: reprocessar o mesmo `video_id` apenas re-extrai metadados/thumbnail e reescreve o status, sem efeito colateral duplicado

**Worker behavior on consume:**
1. Baixa o arquivo (ou usa acesso direto ao storage) referenciado por `Video.storage_key`.
2. Extrai duração e metadados via `ffprobe()` (per `phase-03-videos/TD-05`).
3. Gera thumbnail a partir de um frame via `.screenshots()` (per `phase-03-videos/TD-05`) e envia ao storage, populando `thumbnail_storage_key` (per `phase-03-videos/TD-03`).
4. Em caso de sucesso: `status → ready`, popula `duration_seconds`.
5. Em caso de falha (após esgotar os retries da fila): `status → error`, popula `error_message` (per `phase-03-videos/TD-08`).

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root — infra: storage + fila)
SI-03.2 (root — entidade Video + migration)
├── SI-03.3 — depends on SI-03.1, SI-03.2 (upload multipart precisa de storage/fila + entidade)
│   ├── SI-03.4 — depends on SI-03.3 (endpoint POST /videos)
│   │   ├── SI-03.5 — depends on SI-03.4 (mesmo controller — POST /videos/:id/upload-urls)
│   │   └── SI-03.6 — depends on SI-03.4 (mesmo controller — POST /videos/:id/complete-upload)
│   └── SI-03.12 — depends on SI-03.11, SI-03.3 (worker consome o evento publicado em complete-upload)
├── SI-03.7 — depends on SI-03.1, SI-03.2 (leitura/entrega precisa de storage + entidade)
│   ├── SI-03.8 — depends on SI-03.7, SI-03.4 (endpoint GET /videos/:id)
│   ├── SI-03.9 — depends on SI-03.7, SI-03.4 (endpoint GET /videos/:id/stream)
│   └── SI-03.10 — depends on SI-03.7, SI-03.4 (endpoint GET /videos/:id/download)
└── SI-03.11 — depends on SI-03.1, SI-03.2 (infra: bootstrap do worker standalone)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: object storage (MinIO) e configuração de fila (pg-boss)
- [ ] SI-03.2 — Entidade Video e migration
- [ ] SI-03.3 — VideosService: criação de vídeo e upload multipart pré-assinado
- [ ] SI-03.4 — Endpoint POST /videos
- [ ] SI-03.5 — Endpoint POST /videos/:id/upload-urls
- [ ] SI-03.6 — Endpoint POST /videos/:id/complete-upload
- [ ] SI-03.7 — VideosDeliveryService: consulta e URLs de entrega
- [ ] SI-03.8 — Endpoint GET /videos/:id
- [ ] SI-03.9 — Endpoint GET /videos/:id/stream
- [ ] SI-03.10 — Endpoint GET /videos/:id/download
- [ ] SI-03.11 — Infra: worker de processamento de vídeo (bootstrap)
- [ ] SI-03.12 — VideoProcessingWorker: processamento do vídeo

**Full test suites:**

- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
