---
libs:
  "pg-boss":
    version: "^11.1.2"
    context7_id: "/timgit/pg-boss"
    fetched_at: "2026-07-13T22:56:13.936273367+00:00"
  "@aws-sdk/client-s3":
    version: "^3.1086.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-13T22:56:13.936273367+00:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1086.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-13T22:56:13.936273367+00:00"
  "@aws-sdk/lib-storage":
    version: "^3.1086.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-13T22:56:13.936273367+00:00"
  "fluent-ffmpeg":
    version: "^2.1.3"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-07-13T22:56:13.936273367+00:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-13T22:56:13.936273367+00:00"
---

# Library References — phase-03-videos

### pg-boss

Fila de processamento em background sobre PostgreSQL (per `phase-03-videos/TD-01`). Usado tanto pela API (para enfileirar o job de processamento de vídeo após o upload) quanto pelo worker (`src/worker.main.ts`, per `phase-03-videos/TD-04`), que registra o consumidor via `boss.work()`.

**Nota de versão (descoberta na implementação da SI-03.3):** a partir da v12, `pg-boss` publica `"type": "module"` (ESM-only, sem build CJS) — o Jest deste projeto (`ts-jest` visando CommonJS) não consegue carregar o pacote (`SyntaxError: Cannot use import statement outside a module`), embora o Node em runtime (`require(esm)` nativo do Node 22+) rode normalmente. Fixado em `^11.1.2` (última major com `"type": "commonjs"`, API idêntica: mesma classe `PgBoss`, mesmos métodos `createQueue`/`work`/`send`) para manter a suíte de testes funcionando sem reconfigurar o Jest para ESM. Diferença de import: v11 usa `export = PgBoss` (import default: `import PgBoss from 'pg-boss'`), não o named export `{ PgBoss }` da v12.

#### Setup e envio de job (lado API)

```javascript
const PgBoss = require('pg-boss')
const boss = new PgBoss('postgres://user:pass@host/database')

boss.on('error', console.error)
await boss.start()

const queue = 'video-processing'
await boss.createQueue(queue)

const id = await boss.send(queue, { videoId })
```

#### Consumo de job (lado worker)

```javascript
await boss.work(queue, async ([ job ]) => {
  console.log(`processing job ${job.id}`, job.data)
  // extrai metadata + gera thumbnail (fluent-ffmpeg) e atualiza o vídeo
})
```

Batch com resultado por job (útil para diferenciar `failed` de `deadletter` per o ciclo de status do TD-08):

```js
await boss.work('video-processing', { batchSize: 10, perJobResults: true }, async (jobs) => {
  return jobs.map(job => {
    try {
      const output = process(job.data)
      return { id: job.id, status: 'completed', output }
    } catch (err) {
      return err.fatal
        ? { id: job.id, status: 'deadletter', output: err }
        : { id: job.id, status: 'failed', output: err }
    }
  })
})
```

`send(name, data, options)` aceita `retryLimit`, `retryDelay` e `retryBackoff` — é o mecanismo nativo de retry referenciado no TD-08 antes de o job cair em `deadletter`/o vídeo ser marcado `error`.

**Fonte:** https://github.com/timgit/pg-boss (README.md, docs/api/jobs.md, docs/api/workers.md)

---

### @aws-sdk/client-s3

Client S3 (per `phase-03-videos/TD-03`). `endpoint` custom + `forcePathStyle: true` tornam o client compatível com MinIO em dev, trocando para S3 real em produção via configuração (sem mudança de código, per TD-03). Também expõe os comandos de multipart upload usados no fluxo de upload pré-assinado (per TD-02).

#### Client apontando para storage S3-compatível (MinIO)

```typescript
const client = new S3Client({
  endpoint: "http://minio:9000",       // usar o nome do serviço Compose, nunca localhost
  forcePathStyle: true,
  region: "us-east-1",
  credentials: {
    accessKeyId: process.env.STORAGE_ACCESS_KEY,
    secretAccessKey: process.env.STORAGE_SECRET_KEY,
  },
});
```

#### Multipart upload — CreateMultipartUpload / UploadPart / CompleteMultipartUpload

Fluxo: `CreateMultipartUploadCommand` (API pré-cadastra o rascunho e inicia o upload) → uma URL pré-assinada de `UploadPartCommand` por parte (cliente envia direto ao storage, via `@aws-sdk/s3-request-presigner`) → `CompleteMultipartUploadCommand` com a lista de `{ ETag, PartNumber }` de cada parte.

```typescript
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand } from "@aws-sdk/client-s3";

const { UploadId } = await client.send(new CreateMultipartUploadCommand({ Bucket, Key }));

await client.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: [{ ETag, PartNumber }, ...] },
}));
```

#### Leitura — GetObjectCommand

```typescript
import { GetObjectCommand } from "@aws-sdk/client-s3";

const command = new GetObjectCommand({
  Bucket, Key,
  ResponseContentDisposition: forDownload ? "attachment" : undefined,
});
```

`Range` é tratado nativamente pelo storage S3-compatível ao consumir a URL pré-assinada gerada a partir deste comando — nenhuma lógica de `206 Partial Content` precisa ser reimplementada na API (per TD-07).

**Fonte:** https://github.com/aws/aws-sdk-js-v3 (clients/client-s3, supplemental-docs/CLIENTS.md, UPGRADING.md)

---

### @aws-sdk/s3-request-presigner

Gera URLs pré-assinadas a partir de um `S3Client` (`@aws-sdk/client-s3`) + um Command (per `phase-03-videos/TD-03`). Usado tanto para as partes do multipart upload (write, per TD-02) quanto para as URLs de leitura de streaming/download (per TD-07).

```javascript
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client, GetObjectCommand, UploadPartCommand } from "@aws-sdk/client-s3";

// leitura (streaming/download)
const readUrl = await getSignedUrl(client, new GetObjectCommand(getObjectParams), { expiresIn: 3600 });

// escrita (uma parte do multipart upload)
const partUrl = await getSignedUrl(client, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber: n }), { expiresIn: 3600 });
```

`expiresIn` (segundos) precisa ser calibrado: longo o bastante para cobrir uma sessão de reprodução/upload completa (per TD-07 — trade-off documentado: a URL fica compartilhável até expirar).

**Fonte:** https://github.com/aws/aws-sdk-js-v3 (packages/s3-request-presigner/README.md)

---

### @aws-sdk/lib-storage

`Upload` helper (per `phase-03-videos/TD-03`) — substituto v3 do `ManagedUpload`/`upload()` do SDK v2. Usado internamente pelo worker/serviço quando é necessário fazer upload de um arquivo já em disco local (ex.: a thumbnail gerada pelo `fluent-ffmpeg`) para o storage, sem orquestrar manualmente as partes de um multipart upload.

> S3 Multipart Upload in v3 is provided through the `@aws-sdk/lib-storage` package, which replaces v2's `ManagedUpload` class and `upload()` operation... It enables efficient uploading of large objects by breaking them into multiple parts that are uploaded in parallel.

**Fonte:** https://github.com/aws/aws-sdk-js-v3 (UPGRADING.md)

---

### fluent-ffmpeg

Wrapper sobre o CLI do FFmpeg/ffprobe (per `phase-03-videos/TD-05`), usado pelo worker para extrair metadados e gerar a thumbnail.

#### Metadados via ffprobe (duração, streams, format)

```javascript
const ffmpeg = require('fluent-ffmpeg')

ffmpeg.ffprobe('/path/to/video.mp4', function(err, metadata) {
  console.dir(metadata.streams)
  console.dir(metadata.format) // metadata.format.duration
})
```

#### Thumbnail via screenshots()

```javascript
ffmpeg('/path/to/video.mp4')
  .on('filenames', (filenames) => console.log('Will generate', filenames.join(', ')))
  .on('end', () => console.log('Screenshot taken'))
  .screenshots({
    timestamps: ['50%'],       // um frame do meio do vídeo
    filename: 'thumbnail.jpg',
    folder: '/tmp/output',
    size: '320x240',
  });
```

`screenshots()` (aliases: `thumbnail()`, `thumbnails()`) não funciona em streams de entrada — o worker precisa baixar/ter o arquivo em disco local antes de chamar ffprobe/screenshots. Requer os binários `ffmpeg`/`ffprobe` disponíveis no container do worker (instalação de sistema no `Dockerfile` do worker).

**Fonte:** https://github.com/fluent-ffmpeg/node-fluent-ffmpeg (README.md, doc/index.html, wiki/Migrating-from-fluent-ffmpeg-1.x)
