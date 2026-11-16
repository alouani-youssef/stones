---
name: fastapi
description: Use when writing or reviewing a FastAPI app — adding a route, router, Pydantic schema, dependency, settings, auth, startup/shutdown code, background work or API tests — or when a FastAPI endpoint blocks the event loop, leaks fields in its response, returns the wrong status code, or is hard to test.
metadata:
  title: FastAPI
  frameworks: FastAPI
  summary: Routers by feature, separate input and output schemas, Annotated dependencies, lifespan-managed resources, no blocking calls in async routes, and tests through dependency overrides.
---

# FastAPI

FastAPI turns type hints into validation, serialization, dependency injection and OpenAPI docs. Most FastAPI bugs come from fighting that. Typical examples: returning ORM objects instead of declared schemas, building resources at import time instead of through dependencies, or calling blocking code inside `async def`. Let the types and dependencies do the work, and keep business logic out of the route functions.

## Quick reference

| Concern | Do | Instead of |
| --- | --- | --- |
| Layout | one `APIRouter` per feature (`orders/router.py`, `schemas.py`, `service.py`), included in `main.py` | every route in `main.py` |
| Input vs output | `OrderCreate`, `OrderUpdate`, `OrderRead` schemas; declare the return type or `response_model` | one model for everything, or returning the ORM row |
| Dependencies | `SessionDep = Annotated[Session, Depends(get_session)]`, reused everywhere | `db = Depends(get_db)` defaults repeated per route, or a global session |
| Resources | `yield` dependencies for per-request ones (sessions); `lifespan` for app-wide ones (HTTP clients, pools) | `@app.on_event`, or clients created at import time |
| Settings | `pydantic-settings` `BaseSettings`, served by an `lru_cache` dependency | `os.environ[...]` scattered through modules |
| Async | `async def` only when everything awaited inside is async; plain `def` for blocking libraries | `requests`, `time.sleep` or a sync DB driver inside `async def` |
| Errors | domain exceptions mapped once with `@app.exception_handler`; `HTTPException` at the edge | `try/except` returning `{"error": ...}` with status 200 |
| Status codes | `status_code=status.HTTP_201_CREATED` on create, `204` with no body on delete | 200 for everything |
| Validation | `Annotated[int, Query(ge=1, le=100)]`, `Field(min_length=1)` | checking `if limit > 100` by hand |
| Partial updates | `payload.model_dump(exclude_unset=True)` | overwriting fields the client did not send with `None` |
| Heavy work | a job queue (Celery, arq, RQ); `BackgroundTasks` only for small fire-and-forget work after the response | long jobs in `BackgroundTasks` or inside the request |
| Tests | `app.dependency_overrides[get_session] = ...`, cleared after each test | patching module globals, or testing against the real database by accident |

## Example: one feature, end to end

```python
# app/orders/schemas.py: what clients send and what they get back are separate types
from pydantic import BaseModel, ConfigDict, Field

class OrderCreate(BaseModel):
    sku: str = Field(min_length=1)
    quantity: int = Field(gt=0, le=1000)

class OrderUpdate(BaseModel):
    quantity: int | None = Field(default=None, gt=0, le=1000)

class OrderRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)  # read straight from the ORM object
    id: int
    sku: str
    quantity: int
    # internal columns (cost price, customer notes) are simply not listed, so they never leak


# app/deps.py: one place builds each resource; routes only declare what they need
from collections.abc import Iterator
from functools import lru_cache
from typing import Annotated

from fastapi import Depends
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.orm import Session

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env")
    database_url: str

@lru_cache
def get_settings() -> Settings:
    return Settings()

def get_session() -> Iterator[Session]:
    with SessionLocal() as session:  # closed even when the route raises
        yield session

SessionDep = Annotated[Session, Depends(get_session)]


# app/orders/router.py: thin routes that validate, call the service, declare the response
from fastapi import APIRouter, HTTPException, status

router = APIRouter(prefix="/orders", tags=["orders"])

@router.post("", status_code=status.HTTP_201_CREATED)
def create_order(payload: OrderCreate, session: SessionDep) -> OrderRead:
    return service.create_order(session, payload)  # plain def: the sync session runs in the threadpool

@router.patch("/{order_id}")
def update_order(order_id: int, payload: OrderUpdate, session: SessionDep) -> OrderRead:
    order = service.get_order(session, order_id)
    if order is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "order not found")
    return service.update_order(session, order, payload.model_dump(exclude_unset=True))


# app/main.py: app-wide resources live and die with the app
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(timeout=10)
    yield
    await app.state.http.aclose()

app = FastAPI(lifespan=lifespan)
app.include_router(router)
```

```python
# tests/test_orders.py: swap the dependency, not the module
from fastapi.testclient import TestClient

def test_create_order_returns_201_without_internal_fields(session):  # session: a fixture on a test database
    app.dependency_overrides[get_session] = lambda: session
    try:
        response = TestClient(app).post("/orders", json={"sku": "A-1", "quantity": 2})
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 201
    assert set(response.json()) == {"id", "sku", "quantity"}
```

## async def or def

FastAPI runs a `def` route in a threadpool, but runs an `async def` route directly on the event loop. One blocking call inside `async def` (`requests.get`, `time.sleep`, a sync SQLAlchemy session, heavy CPU work) stalls **every** request the worker is serving.

- The whole call chain is async (`httpx.AsyncClient`, `asyncpg`, SQLAlchemy `AsyncSession`): use `async def` and `await`.
- Any part blocks: use plain `def`, or move the blocking part into `await run_in_threadpool(fn, ...)` (from `fastapi.concurrency`).
- CPU-heavy work (image processing, large exports) belongs in a job queue or process pool, not in the request.

## Security

- Authenticate with a dependency (`CurrentUser = Annotated[User, Depends(get_current_user)]`) built on `OAuth2PasswordBearer` or an API-key header, so a route cannot forget the check. Apply it to a whole router with `APIRouter(dependencies=[...])`.
- Hash passwords with Argon2 or bcrypt (`pwdlib`, `passlib`). Never store or log the raw password or token.
- Configure CORS with an explicit `allow_origins` list. `["*"]` with `allow_credentials=True` is rejected by browsers, and in any case it is the wrong default.
- Output schemas are your allow-list: a field reaches clients only if it appears in the `*Read` model.
- Keep secrets in `Settings`, loaded from the environment. Never put them in code or in `openapi.json` examples.

## Structure

- Routes stay thin: they parse input, call a service, and return a schema. Business rules live in `service.py` and know nothing about HTTP. Persistence goes behind a repository when queries grow (see the repository-pattern skill).
- List endpoints are paginated with a capped `limit`. Return a summary list plus a detail endpoint (see the summary-details-responses skill).
- Version or prefix the API (`/v1`) once there are outside clients. Treat the generated OpenAPI as the contract, and keep `response_model`, status codes and `responses={404: ...}` accurate so the docs are accurate.
- Run with `fastapi dev` locally and `fastapi run` (or `uvicorn --workers N`) in production. Do not use `--reload` in production.

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| All requests slow down when one is slow | blocking call inside `async def` | make the route `def`, or use async libraries end to end |
| Response contains `password_hash` or internal columns | route returns the ORM object with no output schema | declare `-> OrderRead` or `response_model=OrderRead` |
| PATCH resets fields to `null` | `model_dump()` without `exclude_unset=True` | dump only the fields the client sent |
| `DetachedInstanceError` / connection pool exhausted | session created by hand and not closed | `yield` dependency with a context manager |
| Tests hit the real database or API | resource built at import time, so it can't be overridden | build it in a dependency; override it in tests |
| `422` where the client expected `400`, or the reverse | validation done by hand inside the route | declare constraints on the schema and `Query`/`Path` |
| Startup code runs twice or never cleans up | `@app.on_event` or module-level setup | `lifespan` context manager |

Test-first rules for these endpoints are in the writing-tests and test-first-development skills: write the failing `TestClient` test for the scenario, then the route.
