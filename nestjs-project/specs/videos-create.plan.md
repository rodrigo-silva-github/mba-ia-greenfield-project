---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.4
target_file: nestjs-project/test/videos-create.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

Endpoint que pré-cadastra um vídeo como rascunho e inicia o multipart upload pré-assinado no object storage. É o primeiro passo do fluxo de upload de até 10GB sem travar a API (per `phase-03-videos/TD-02`).

## Test Scenarios

### 1. POST /videos

**Setup:** trunca as tabelas `videos` e `channels` (mantendo o usuário/canal de teste); bootstrap via `Test.createTestingModule(...).compile()` com MinIO real (Compose) para o multipart upload e login prévio para obter o `access_token`.

#### 1.1. cria-rascunho-e-inicia-multipart-upload

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. POST /videos com body `{ title, mime_type: "video/mp4", size_bytes: 104857600 }` autenticado com `Authorization: Bearer {access_token}` de um canal existente
    - expect: retorna `201`
    - expect: body contém `{ id, status: "draft", upload_id, storage_key }` com `id` e `upload_id` não-nulos

#### 1.2. rejeita-sem-autenticacao

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. POST /videos com body válido, sem header `Authorization`
    - expect: retorna `401`

#### 1.3. rejeita-payload-invalido

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. POST /videos autenticado com `mime_type: "application/pdf"` (fora do padrão `video/*`)
    - expect: retorna `400`
  2. POST /videos autenticado com `size_bytes` acima de `10 * 1024^3` (10GB)
    - expect: retorna `400`
