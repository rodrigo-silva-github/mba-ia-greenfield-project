---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: nestjs-project/test/videos-stream.e2e-spec.ts
---

# GET /videos/:id/stream Test Plan

## Application Overview

Endpoint de streaming — redireciona para uma URL pré-assinada de leitura no object storage, que trata `Range`/`206 Partial Content` nativamente (per `phase-03-videos/TD-07`). Disponível apenas para vídeos `status: ready`.

## Test Scenarios

### 1. GET /videos/:id/stream

**Setup:** trunca `videos`/`channels`; cria um vídeo `ready` com `storage_key` apontando para um objeto real no MinIO, e um vídeo `processing`.

#### 1.1. redireciona-para-url-pre-assinada-quando-ready

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. GET /videos/:id/stream de um vídeo `ready`, sem header `Authorization`
    - expect: retorna `302`
    - expect: header `Location` aponta para uma URL pré-assinada de leitura no storage

#### 1.2. rejeita-video-nao-pronto

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. GET /videos/:id/stream de um vídeo `processing`
    - expect: retorna `409` com `errorCode: "VIDEO_NOT_READY"`

#### 1.3. rejeita-id-inexistente

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-07-13T23:17:11Z

**Steps:**
  1. GET /videos/{uuid-inexistente}/stream
    - expect: retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`
