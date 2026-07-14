---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: nestjs-project/test/videos-download.e2e-spec.ts
---

# GET /videos/:id/download Test Plan

## Application Overview

Endpoint de download — redireciona para uma URL pré-assinada de leitura com `Content-Disposition: attachment`, forçando o download em vez da reprodução inline (per `phase-03-videos/TD-07`). Disponível apenas para vídeos `status: ready`.

## Test Scenarios

### 1. GET /videos/:id/download

**Setup:** trunca `videos`/`channels`; cria um vídeo `ready` com `storage_key` apontando para um objeto real no MinIO, e um vídeo `error`.

#### 1.1. redireciona-para-url-pre-assinada-de-download-quando-ready

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. GET /videos/:id/download de um vídeo `ready`, sem header `Authorization`
    - expect: retorna `302`
    - expect: a URL pré-assinada no header `Location` foi gerada com `ResponseContentDisposition: attachment`

#### 1.2. rejeita-video-nao-pronto

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. GET /videos/:id/download de um vídeo `error`
    - expect: retorna `409` com `errorCode: "VIDEO_NOT_READY"`

#### 1.3. rejeita-id-inexistente

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. GET /videos/{uuid-inexistente}/download
    - expect: retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`
