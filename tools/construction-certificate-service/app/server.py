import asyncio
import os
import uuid
from dataclasses import asdict
from typing import Dict, List, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from .service import (
    BatchRequestCoordinator,
    CertificateService,
    ClientDisconnectedError,
    QueueFullError,
    QueueTimeoutError,
)


MAX_BATCH_SIZE = 20
REQUEST_COORDINATOR = BatchRequestCoordinator(
    max_queue_size=int(os.environ.get("MAX_QUEUE_SIZE", "100")),
    queue_timeout_seconds=int(os.environ.get("QUEUE_TIMEOUT_SECONDS", "300")),
)

app = FastAPI(title="Construction Certificate Query API", version="1.0.0")


class FeishuConfig(BaseModel):
    app_id: str
    app_secret: str
    app_token: str
    table_id: str


class LookupConfig(BaseModel):
    id_number_field: str
    name_field: Optional[str] = None


class CertificateFieldMapping(BaseModel):
    expire_field: str
    review_due_field: str
    review_actual_field: str
    attachment_field: str


class BatchPerson(BaseModel):
    record_id: Optional[str] = None
    name: str
    id_number: str


class BatchQueryPayload(BaseModel):
    feishu: FeishuConfig
    lookup: Optional[LookupConfig] = None
    field_mapping: Dict[str, CertificateFieldMapping]
    people: List[BatchPerson]


@app.get("/healthz")
def healthz() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/api/v1/query/batch")
async def batch_query(payload: BatchQueryPayload, request: Request):
    people = [
        {
            "record_id": (person.record_id or "").strip(),
            "name": person.name.strip(),
            "id_number": person.id_number.strip(),
        }
        for person in payload.people
    ]
    if not people:
        raise HTTPException(status_code=400, detail="people 不能为空")
    if len(people) > MAX_BATCH_SIZE:
        raise HTTPException(status_code=400, detail=f"单次最多查询 {MAX_BATCH_SIZE} 人")

    field_mapping = {
        cert_type: mapping.dict()
        for cert_type, mapping in payload.field_mapping.items()
    }
    if not field_mapping:
        raise HTTPException(status_code=400, detail="field_mapping 不能为空")

    service = CertificateService(feishu_config=payload.feishu.dict())
    request_id = str(uuid.uuid4())

    async def run_work():
        return await asyncio.to_thread(
            service.process_batch_request,
            request_id=request_id,
            people=people,
            lookup=payload.lookup.dict() if payload.lookup else None,
            field_mapping=field_mapping,
        )

    try:
        queued = await REQUEST_COORDINATOR.run(
            request_id=request_id,
            work=run_work,
            is_disconnected=request.is_disconnected,
        )
    except QueueFullError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except QueueTimeoutError as exc:
        raise HTTPException(status_code=504, detail=str(exc)) from exc
    except ClientDisconnectedError as exc:
        raise HTTPException(status_code=499, detail=str(exc)) from exc

    result = queued.result
    return {
        "request_id": request_id,
        "total": result.total,
        "success": result.success,
        "failed": result.failed,
        "query_seconds": result.query_seconds,
        "writeback_seconds": result.writeback_seconds,
        "queued_seconds": queued.queued_seconds,
        "execution_seconds": queued.execution_seconds,
        "results": [asdict(row) for row in result.results],
    }


if __name__ == "__main__":
    uvicorn.run(
        "app.server:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "58000")),
        reload=False,
    )
