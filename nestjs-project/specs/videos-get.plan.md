---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: nestjs-project/test/videos-get.e2e-spec.ts
---

# GET /videos/:id Test Plan

## Application Overview

Endpoint de leitura dos metadados do vídeo. Vídeos `ready` são públicos (usuários anônimos podem assistir livremente); vídeos em `draft`/`processing`/`error` só são visíveis ao dono, e a existência de rascunhos alheios é ocultada (per `### Authorization Matrix`, `### Error Catalog`).

## Test Scenarios

### 1. GET /videos/:id

**Setup:** trunca `videos`/`channels`; cria um vídeo `ready` e um vídeo `draft` pertencentes a canais distintos.

#### 1.1. retorna-metadados-de-video-ready-sem-autenticacao

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. GET /videos/:id de um vídeo `ready`, sem header `Authorization`
    - expect: retorna `200`
    - expect: body contém `{ id, title, description, status: "ready", duration_seconds, created_at }`

#### 1.2. oculta-rascunho-de-outro-canal

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. GET /videos/:id de um vídeo em `draft`, autenticado com um usuário que não é o dono do canal
    - expect: retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`

#### 1.3. rejeita-id-inexistente

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. GET /videos/{uuid-inexistente}
    - expect: retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`
