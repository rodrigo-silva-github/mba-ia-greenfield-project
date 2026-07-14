---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: nestjs-project/test/videos-complete-upload.e2e-spec.ts
---

# POST /videos/:id/complete-upload Test Plan

## Application Overview

Endpoint que conclui o multipart upload no object storage e dispara o processamento assíncrono do vídeo, publicando o job `video.process` na fila pg-boss (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`, `phase-03-videos/TD-08`).

## Test Scenarios

### 1. POST /videos/:id/complete-upload

**Setup:** trunca `videos`/`channels` e as tabelas internas do pg-boss (`pgboss.job`); cria um vídeo em `draft` com multipart upload real iniciado e todas as partes já enviadas ao MinIO real.

#### 1.1. conclui-upload-e-inicia-processamento

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. POST /videos/:id/complete-upload autenticado como dono, com body `{ parts: [{ part_number: 1, etag: "..." }, ...] }` (ETags reais das partes enviadas no setup)
    - expect: retorna `200` com `{ id, status: "processing" }`

#### 1.2. rejeita-conclusao-duplicada

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. Chamar POST /videos/:id/complete-upload novamente para o mesmo vídeo já concluído no cenário anterior
    - expect: retorna `409` com `errorCode: "UPLOAD_ALREADY_COMPLETED"`

#### 1.3. publica-job-de-processamento-na-fila

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. POST /videos/:id/complete-upload autenticado com partes válidas
    - expect: retorna `200`
  2. Consultar a tabela de jobs do pg-boss (`pgboss.job`) pela fila `video-processing`
    - expect: existe um job com `data.videoId` igual ao id do vídeo concluído
