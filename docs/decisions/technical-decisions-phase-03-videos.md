---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-13
scope_description: "Upload, processamento assíncrono, storage, fila, streaming e URL única de vídeos (Fase 03)"
---

# Technical Decisions — Fase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — recebe o novo módulo de vídeos, a integração com storage/fila/worker, a migration da tabela de vídeos e os novos serviços no `compose.yaml` (storage, fila, worker).
- `next-frontend/` — fora do escopo desta fase. O enunciado da Fase 03 é explícito: "Há um frontend no repositório, mas a interface de vídeo não faz parte do escopo desta fase." Nenhum TD neste documento toca o frontend.

---

## TD-01: Tecnologia de Fila de Processamento

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/project-plan.md` e `docs/diagrams/software-arch.mermaid` já preveem um container `Message Queue` dedicado entre a API e o Video Worker (`Rel(api, queue, "Publishes job")`, `Rel(queue, worker, "Delivers job")`), mas a tecnologia está marcada como `TBD` no diagrama. É a principal decisão de stack em aberto desta fase — nenhuma decisão anterior (Fases 01/02) cobre filas ou brokers.

**Options:**

### Option A: BullMQ (Redis) via `@nestjs/bullmq`
- Fila baseada em Redis, com API de `Queue`/`Worker`/`Processor` (padrão `WorkerHost` + `@Processor`), suporte nativo a `attempts`/`backoff` exponencial, concorrência configurável e eventos (`@OnWorkerEvent`).
- **Pros:** biblioteca mais madura e documentada do ecossistema Node para filas de background job; integração oficial com NestJS (`@nestjs/bullmq`); `bull-board` dá um dashboard de observação de jobs pronto, útil para demonstrar o pipeline de processamento; concorrência e retry finos por fila.
- **Cons:** adiciona Redis como novo serviço de infraestrutura no `compose.yaml` (nenhum Redis existe hoje no projeto).

### Option B: pg-boss (PostgreSQL)
- Fila implementada como tabelas dentro do próprio Postgres (`boss.createQueue`, `boss.send`, `boss.work`), com `retryLimit`/`retryDelay`/`retryBackoff` e `deadLetter` nativos por fila.
- **Pros:** zero infraestrutura nova — reaproveita o PostgreSQL 17 já no `compose.yaml`; modelo de retry/dead-letter nativo cobre bem o ciclo de falha do TD-08; simples de operar para o volume de uma fila (processamento de vídeo) neste projeto.
- **Cons:** acopla a fila às mesmas tabelas/carga do banco transacional da aplicação; sem tooling de observação visual pronto (ao contrário do Bull Board); throughput/latência de polling inferior a um broker dedicado (não é um problema neste escopo, mas é a troca real).

### Option C: RabbitMQ (AMQP) via `@golevelup/nestjs-rabbitmq`
- Broker de mensageria dedicado, exchanges/filas com dead-letter exchange nativo, entrega garantida via ack/nack.
- **Pros:** padrão de mercado para filas de mensagens desacopladas do banco de dados da aplicação; dead-letter exchange nativo.
- **Cons:** maior custo de infraestrutura e operação entre as três opções (broker próprio + management UI, curva de configuração de exchanges/bindings) para um projeto que precisa de um único tipo de job (processar vídeo) — desproporcional ao escopo desta fase.

**Recommendation:** Option A (BullMQ + Redis) — a arquitetura já reserva um container dedicado de fila (`ContainerQueue(queue, "Message Queue", "TBD", ...)`), então introduzir Redis está dentro do escopo pretendido, não é overhead extra. Entre as três, BullMQ é a opção mais madura e documentada para exatamente este tipo de carga (jobs de processamento de mídia com retry/backoff/concorrência), com o menor risco de faltar alguma funcionalidade durante a implementação. pg-boss é uma alternativa legítima e mais barata em infraestrutura para quem quer evitar Redis; fica registrada como a segunda opção viável caso o custo de mais um serviço no Compose seja indesejado.

**Decision:** Option B (pg-boss)

**Note:** Decisão divergiu da recomendação — optou-se por reaproveitar o PostgreSQL 17 já existente no `compose.yaml` em vez de introduzir Redis como novo serviço de infraestrutura, trocando a observabilidade visual (Bull Board) e o throughput mais alto do BullMQ pela simplicidade operacional de zero infra nova, aceitável para o volume de um único tipo de job (processamento de vídeo) neste projeto.

**Libraries:** pg-boss

---

## TD-02: Estratégia de Upload de Vídeos de até 10GB

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Arquivos de até 10GB não podem passar pelo corpo de uma requisição HTTP tratada pela API sob risco de esgotar memória/conexões e travar o sistema (reprovação automática explícita no enunciado). O C4 já modela `Rel(frontend, storage, "Streams", "HTTPS")` — o app cliente conversa diretamente com o Object Storage, não só com a API.

**Options:**

### Option A: Upload via API com streaming para o storage
- A API recebe o `multipart/form-data` e faz streaming (sem bufferizar o arquivo inteiro em memória) direto para o storage usando `@aws-sdk/lib-storage` (`Upload`).
- **Pros:** fluxo mais simples do ponto de vista do cliente (uma única requisição).
- **Cons:** cada upload mantém uma conexão HTTP e recursos da API ocupados pela duração inteira da transferência (potencialmente horas em conexões lentas para 10GB); contraria o objetivo de "sem impacto na performance" da API e diverge do relacionamento `frontend → storage` já modelado no diagrama.

### Option B: Upload direto ao storage via URL pré-assinada multipart (S3 Multipart Upload)
- O cliente chama a API para pré-cadastrar o vídeo como rascunho e iniciar um `CreateMultipartUpload`; a API devolve `uploadId` + uma URL pré-assinada (`getSignedUrl` + `UploadPartCommand`) por parte; o cliente envia cada parte diretamente ao storage (MinIO/S3); ao final, o cliente chama a API para `CompleteMultipartUpload`.
- **Pros:** a API nunca toca os bytes do arquivo — fica livre para atender outras requisições durante o upload inteiro; um único `PUT` pré-assinado tem limite de 5GB no protocolo S3 (insuficiente para 10GB), enquanto o multipart upload suporta até 5TB por objeto, cobrindo o requisito com folga; alinhado ao relacionamento `frontend → storage` do C4.
- **Cons:** mais peças móveis — o cliente precisa implementar o loop de envio de partes (e idealmente retry por parte); a API precisa de um endpoint de "completar upload" separado do pré-cadastro.

### Option C: Protocolo tus (upload resumível)
- Protocolo aberto para upload resumível via `PATCH` incrementais, com um servidor tus dedicado (ex.: `tusd` como sidecar) ou lib `@tus/server`.
- **Pros:** resiliência superior a conexões instáveis — retoma de onde parou após queda de rede, sem repetir partes já enviadas.
- **Cons:** exige um novo componente de infraestrutura dedicado (servidor tus) e um conector para persistir no storage S3-compatível, desproporcional ao escopo desta fase quando o multipart nativo do S3 (Option B) já atende ao requisito de 10GB.

**Recommendation:** Option B (Upload pré-assinado multipart direto ao storage) — é a única opção que mantém a API fora do caminho dos bytes do arquivo (satisfazendo literalmente "sem travar o sistema"), resolve o limite de 10GB dentro do protocolo S3 padrão (multipart, não single-PUT) e é consistente com o relacionamento já desenhado no C4 (`frontend → storage`, streaming). O pré-cadastro do vídeo como rascunho acontece na mesma chamada que inicia o multipart upload, satisfazendo a segunda capability coberta por este TD.

**Decision:** Option B (Upload pré-assinado multipart direto ao storage)

---

## TD-03: SDK e Organização do Object Storage

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O object storage em si não é uma decisão em aberto — o projeto já aponta para S3-compatível (MinIO em dev, S3 em produção, conforme o enunciado). O que precisa ser decidido é qual biblioteca cliente usar e como as chaves/buckets são organizados, já que essa convenção é referenciada pela entidade de vídeo (colunas de chave de storage), pelo worker (leitura/escrita) e pela geração de URLs pré-assinadas (upload, streaming, download) — um contrato entre múltiplos componentes.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` + `@aws-sdk/lib-storage`)
- SDK oficial da AWS, compatível com qualquer storage S3-compatível via `endpoint` custom + `forcePathStyle: true` (confirmado na doc do SDK para uso com serviços não-AWS).
- **Pros:** o enunciado já declara a intenção de trocar MinIO por S3 real em produção — o AWS SDK v3 torna essa troca uma mudança de configuração (endpoint/credenciais), não de código; documentação e adoção amplas; suporta multipart + presigned URLs nativamente (necessário para o TD-02).
- **Cons:** API um pouco mais verbosa que clientes dedicados ao MinIO.

### Option B: Cliente oficial MinIO (`minio` npm package)
- SDK de alto nível voltado especificamente à API do MinIO.
- **Pros:** API mais simples para operações básicas.
- **Cons:** acopla o código à SDK específica do MinIO — migrar para S3 real em produção (intenção explícita do projeto) exigiria trocar a biblioteca inteira, não só configuração.

**Recommendation:** Option A (AWS SDK v3) — é a única opção compatível com a migração MinIO → S3 já planejada pelo projeto sem reescrever código, além de já ser a base necessária para o upload multipart pré-assinado decidido no TD-02.

Convenção de organização (aplica-se independente da SDK escolhida): um único bucket (`streamtube`) com chaves hierárquicas por canal e vídeo — `videos/{channelId}/{videoId}/original.<ext>` para o arquivo de vídeo e `videos/{channelId}/{videoId}/thumbnail.jpg` para a thumbnail gerada pelo worker. Um bucket único com prefixos evita a necessidade de provisionar/gerenciar múltiplos buckets no MinIO em dev, e o prefixo por canal+vídeo garante que a chave nunca colide entre vídeos.

**Decision:** Option A (AWS SDK v3)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/lib-storage

---

## TD-04: Arquitetura do Worker de Processamento de Vídeo

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** O C4 modela o Video Worker como um container próprio, separado da API (`Container(worker, "Video Worker", "FFmpeg", ...)`), que lê/escreve no storage e atualiza o banco diretamente (`Rel(worker, storage, ...)`, `Rel(worker, db, "Updates")`). É preciso decidir como esse processo roda de fato.

**Options:**

### Option A: Aplicação standalone NestJS (`NestFactory.createApplicationContext`) em container próprio
- Um segundo entrypoint (ex.: `src/worker.main.ts`) inicializa o mesmo `AppModule`/módulos compartilhados via `NestFactory.createApplicationContext()` — sem listener HTTP — e registra o consumidor da fila escolhida no TD-01 (`WorkerHost`/`@Processor` no caso do BullMQ). Roda como um novo serviço `video-worker` no `compose.yaml`.
- **Pros:** reaproveita as mesmas entidades TypeORM, o mesmo `registerAs`/`ConfigModule`, o mesmo repository pattern e a mesma configuração de DB já estabelecidos nas Fases 01/02 — soma trabalho ao invés de reescrever (princípio "Continuidade, não retrabalho"); container isolado da API, alinhado ao diagrama.
- **Cons:** cold start e footprint de memória levemente maiores que um script Node puro (irrelevante na escala deste projeto).

### Option B: Script Node/TypeScript standalone (sem NestJS)
- Processo mínimo, sem DI container, que conecta diretamente no banco e na fila.
- **Pros:** footprint menor.
- **Cons:** duplica manualmente a configuração de banco/entidades/env validation já resolvida via NestJS nas fases anteriores, divergindo das convenções do projeto sem ganho real neste porte de aplicação.

### Option C: Worker embutido no processo da própria `nestjs-api` (sem container separado)
- Um `Worker`/processor da fila rodando dentro do mesmo processo Node que atende HTTP.
- **Pros:** menos um serviço no `compose.yaml`.
- **Cons:** contraria explicitamente o C4 (que modela um container `Video Worker` separado); acopla a carga de processamento de mídia (FFmpeg) ao mesmo processo que atende requisições da API, borrando a fronteira de escala e responsabilidade que o diagrama define.

**Recommendation:** Option A (Aplicação standalone NestJS, container próprio) — é a única opção que respeita simultaneamente o C4 (container separado) e o princípio de reaproveitar os padrões já estabelecidos do projeto (config, entidades, repository pattern), evitando duplicar infraestrutura de acesso a dados só para o worker.

**Decision:** Option A (Aplicação standalone NestJS, container próprio) — o entrypoint `src/worker.main.ts` registra o consumidor de jobs via `boss.work()` (pg-boss, per TD-01), não mais via `WorkerHost`/`@Processor` do BullMQ.

---

## TD-05: Biblioteca de Integração com FFmpeg

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O worker (TD-04) precisa extrair duração/metadados do vídeo e gerar uma thumbnail a partir de um frame, usando FFmpeg/ffprobe conforme o C4 (`Container(worker, "Video Worker", "FFmpeg", ...)`).

**Options:**

### Option A: `fluent-ffmpeg`
- Wrapper Node maduro sobre o CLI do FFmpeg/ffprobe, com API fluente. `ffmpeg.ffprobe(path, callback)` retorna JSON estruturado (`streams`, `format.duration`, etc.) e `.screenshots({ timestamps, folder, size })` extrai thumbnails de frames específicos ou por percentual do vídeo.
- **Pros:** as duas capacidades exigidas nesta fase (metadados via ffprobe, thumbnail via screenshot) já são métodos de primeira classe, testados e documentados — sem precisar montar/parsear comandos CLI manualmente; grande base de exemplos.
- **Cons:** requer os binários `ffmpeg`/`ffprobe` disponíveis no container do worker (instalação de sistema ou pacotes `ffmpeg-static`/`@ffprobe-installer/ffprobe`) — mesma exigência de qualquer opção baseada no CLI do FFmpeg.

### Option B: `child_process.spawn` direto sobre os binários `ffmpeg`/`ffprobe`
- Invocação manual do CLI com arrays de argumentos montados à mão (`-print_format json` para metadados, `-ss <tempo> -frames:v 1` para thumbnail).
- **Pros:** zero dependência além do `child_process` nativo do Node; controle total sobre as flags.
- **Cons:** exige reimplementar manualmente o parsing de JSON do ffprobe e a lógica de extração de frame que o `fluent-ffmpeg` já oferece pronta e testada, sem ganho real para as duas operações necessárias nesta fase.

**Recommendation:** Option A (`fluent-ffmpeg`) — cobre exatamente as duas operações exigidas (`ffprobe()` para metadados, `.screenshots()` para thumbnail) com métodos documentados e testados, evitando código de parsing/CLI feito à mão sem benefício correspondente neste escopo.

**Decision:** Option A (`fluent-ffmpeg`)

**Libraries:** fluent-ffmpeg

---

## TD-06: Estratégia de Identificador Único do Vídeo (URL)

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Toda entidade existente no projeto (`users`, `channels`, `refresh_tokens`, `verification_tokens`) usa `id uuid NOT NULL DEFAULT uuid_generate_v4()` como chave primária (confirmado nas migrations das Fases 01/02). É preciso decidir se o vídeo segue a mesma convenção ou introduz um identificador de URL separado.

**Options:**

### Option A: Reaproveitar o UUID v4 da chave primária como identificador de rota (`GET /videos/:id`)
- Nenhuma coluna nova; unicidade garantida pela própria constraint de PK; zero risco de colisão.
- **Pros:** consistente com todas as entidades já existentes no projeto (Fases 01/02); nenhuma lógica de geração/verificação de unicidade adicional.
- **Cons:** URLs mais longas e não-legíveis (irrelevante para o requisito, que pede apenas unicidade, não legibilidade).

### Option B: Slug curto dedicado (nanoid/base62) em coluna própria
- Um identificador curto gerado na criação, com checagem de unicidade no banco (mesmo padrão de retry usado para `channels.nickname` na Fase 02).
- **Pros:** URLs mais curtas e compartilháveis.
- **Cons:** adiciona uma coluna e uma lógica de geração+retry de unicidade só para encurtar a URL — nenhuma capability desta fase pede um identificador legível/curto, apenas "sem conflito com outros vídeos", já satisfeito pela PK.

### Option C: UUID v7 / ULID (variante ordenável por tempo) como chave primária
- Substituiria o `uuid_generate_v4()` por uma geração ordenável cronologicamente.
- **Pros:** ordenação natural por data de criação, útil para futuras listagens "mais recentes".
- **Cons:** quebra a convenção `uuid_generate_v4()` usada por toda entidade existente; a extensão `uuid-ossp` já instalada no Postgres 17 do projeto não gera UUID v7 nativamente (exigiria extensão adicional ou geração no código da aplicação) — nenhuma capability desta fase pede ordenação, só unicidade.

**Recommendation:** Option A — reaproveitar o UUID v4 da PK evita introduzir uma nova coluna/mecanismo de geração só para a URL, é o caminho de menor risco de colisão e mantém a consistência com toda entidade já existente no projeto.

**Decision:** Option A (Reaproveitar o UUID v4 da chave primária)

---

## TD-07: Estratégia de Entrega de Vídeo (Streaming e Download)

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** O `StreamableFile` do NestJS não interpreta o header `Range` automaticamente (confirmado na documentação oficial — é preciso implementar manualmente o parsing de `Range` e a resposta `206 Partial Content` ao usar streaming via API). O C4 já modela `Rel(frontend, storage, "Streams", "HTTPS")`, ou seja, o app cliente foi desenhado para conversar com o storage diretamente na reprodução, não só no upload.

**Options:**

### Option A: Proxy de bytes pela API
- `GET /videos/:id/stream` lê o objeto do storage (`GetObjectCommand` repassando o header `Range` recebido) e implementa manualmente o parsing de `Range`/resposta `206`/`Content-Range` via `@Res()` + pipe de stream.
- **Pros:** um único domínio (a API) serve todo o tráfego, sem expor o storage publicamente.
- **Cons:** todo byte reproduzido por todo espectador passa pelo processo da API, contrariando o objetivo de manter a API leve; reimplementa manualmente uma lógica de `Range`/`206` que o storage S3-compatível já resolve nativamente; diverge do relacionamento `frontend → storage` já modelado no C4.

### Option B: Redirecionamento para URL pré-assinada de leitura
- `GET /videos/:id/stream` e `GET /videos/:id/download` validam o vídeo (existe, status `ready`) e devolvem/redirecionam (302 ou JSON com a URL) para uma `GetObjectCommand` pré-assinada contra o storage; o MinIO/S3 já trata `Range` nativamente. O download usa a mesma URL pré-assinada, mas com `ResponseContentDisposition: attachment` no presign para forçar o download em vez da reprodução inline.
- **Pros:** alinhado ao C4 (`frontend → storage`, streaming); nenhuma lógica de `Range` reimplementada — o storage já faz isso; a API fica fora do caminho dos bytes, tanto no upload (TD-02) quanto na entrega, mantendo o mesmo princípio nas duas pontas.
- **Cons:** é preciso calibrar o tempo de expiração da URL pré-assinada (longo o bastante para uma sessão de reprodução completa) — a URL fica tecnicamente compartilhável até expirar.

**Recommendation:** Option B (redirecionamento/URL pré-assinada) — é a única opção coerente com o relacionamento já desenhado no C4 e evita reimplementar manualmente o suporte a `Range`/`206` que o storage S3-compatível já oferece pronto, mantendo a API fora do caminho dos bytes tanto no upload quanto na entrega.

**Decision:** Option B (Redirecionamento para URL pré-assinada de leitura)

---

## TD-08: Ciclo de Status do Vídeo e Tratamento de Falha no Processamento

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** É preciso definir os estados possíveis do vídeo e o que acontece quando o processamento (worker) falha, já que o enunciado exige que esse ciclo fique "refletido no banco".

**Options:**

### Option A: Enum de status linear + coluna de erro
- `draft → uploaded → processing → ready`, com um estado terminal paralelo `error` alcançável a partir de `uploaded`/`processing`. Uma coluna `processing_error` (nullable) grava o motivo da última falha. O retentativa de processamento fica inteiramente a cargo da política nativa de retry/backoff da fila escolhida no TD-01 (ex.: `attempts`/`backoff` do BullMQ, ou `retryLimit`/`retryBackoff` do pg-boss) antes de o job ser definitivamente marcado como `error`.
- **Pros:** um enum + uma coluna de texto satisfazem literalmente a capability ("ciclo de status... refletido no banco") sem infraestrutura extra; reaproveita o mecanismo de retry que a fila já oferece nativamente, sem reimplementar lógica de tentativas na aplicação.
- **Cons:** não mantém histórico das tentativas anteriores, apenas o erro mais recente.

### Option B: Enum de status + tabela de auditoria de transições
- Igual à Option A, mas cada transição de status é também gravada em uma tabela `video_processing_events` (status, timestamp, detalhe do erro), permitindo reconstruir o histórico completo de processamento de um vídeo.
- **Pros:** rastreabilidade completa de tentativas e falhas ao longo do tempo.
- **Cons:** nenhuma capability desta fase pede histórico de auditoria — apenas o estado atual "refletido no banco"; tabela e escritas extras para uma necessidade não solicitada nesta fase (candidata a entrar em uma fase futura, se necessário).

**Recommendation:** Option A — atende literalmente à capability desta fase (estado atual refletido no banco) sem construir infraestrutura de auditoria não solicitada; o retry nativo da fila escolhida no TD-01 já cobre a resiliência a falhas transitórias antes de o vídeo chegar ao estado terminal `error`.

**Decision:** Option A (Enum de status linear + coluna de erro) — retry via `retryLimit`/`retryBackoff` nativos do pg-boss (TD-01).

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia de Fila de Processamento | BullMQ (Redis) via `@nestjs/bullmq` | Option B — pg-boss (PostgreSQL) |
| TD-02 | Backend | Estratégia de Upload de Vídeos de até 10GB | Upload pré-assinado multipart direto ao storage | Option B — Upload pré-assinado multipart direto ao storage |
| TD-03 | Backend | SDK e Organização do Object Storage | AWS SDK v3 (`@aws-sdk/client-s3` + presigner + lib-storage) | Option A — AWS SDK v3 |
| TD-04 | Backend | Arquitetura do Worker de Processamento de Vídeo | Aplicação standalone NestJS em container próprio | Option A — Aplicação standalone NestJS |
| TD-05 | Backend | Biblioteca de Integração com FFmpeg | `fluent-ffmpeg` | Option A — `fluent-ffmpeg` |
| TD-06 | Backend | Estratégia de Identificador Único do Vídeo (URL) | Reaproveitar o UUID v4 da chave primária | Option A — Reaproveitar o UUID v4 da PK |
| TD-07 | Backend | Estratégia de Entrega de Vídeo (Streaming e Download) | Redirecionamento para URL pré-assinada de leitura | Option B — Redirecionamento para URL pré-assinada |
| TD-08 | Backend | Ciclo de Status do Vídeo e Tratamento de Falha | Enum de status linear + coluna de erro | Option A — Enum linear + coluna de erro |
