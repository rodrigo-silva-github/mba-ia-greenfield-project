---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: nestjs-project/test/videos-upload-urls.e2e-spec.ts
---

# POST /videos/:id/upload-urls Test Plan

## Application Overview

Endpoint que devolve, para um vídeo cujo upload multipart já foi iniciado, uma URL pré-assinada de escrita por parte solicitada — o cliente envia cada parte diretamente ao object storage (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`).

## Test Scenarios

### 1. POST /videos/:id/upload-urls

**Setup:** trunca `videos`/`channels`; cria um vídeo em `draft` com `upload_id` via `POST /videos` real (MinIO); cria um segundo canal/usuário para os cenários de ownership.

#### 1.1. retorna-uma-url-por-parte-solicitada

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. POST /videos/:id/upload-urls autenticado como dono do vídeo, com body `{ part_numbers: [1, 2, 3] }`
    - expect: retorna `200`
    - expect: body `{ urls }` contém exatamente 3 entradas, uma por `part_number` solicitado

#### 1.2. rejeita-vídeo-de-outro-canal

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. POST /videos/:id/upload-urls autenticado com um usuário de outro canal (não-dono)
    - expect: retorna `403` com `errorCode: "VIDEO_NOT_OWNED"`

#### 1.3. rejeita-vídeo-inexistente

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. POST /videos/{uuid-inexistente}/upload-urls autenticado
    - expect: retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`
