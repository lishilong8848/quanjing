"""Exercise the real certificate batch route with simulated external systems."""

import copy
import socket
import sys
import unittest
import uuid
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi.testclient import TestClient

TOOL_DIR = Path(__file__).resolve().parents[2] / "tools" / "construction-certificate-service"
sys.path.insert(0, str(TOOL_DIR))
try:
    # The external SDK is replaced before import; route and service stay real.
    reader_module = ModuleType("app.feishu_reader")
    reader_module.FeishuTableReader = Mock
    with patch.dict(sys.modules, {"app.feishu_reader": reader_module}):
        from app import server, service
finally:
    sys.path.remove(str(TOOL_DIR))

FEISHU = dict(app_id="test-app", app_secret="test-secret", app_token="test-base", table_id="test-table")
MAPPING = {"high_voltage": dict(expire_field="expire", review_due_field="due", review_actual_field="actual", attachment_field="files")}


def loopback_only(original):
    def connect(sock, address):
        if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
            raise AssertionError("External network access is forbidden in this test")
        return original(sock, address)
    return connect


class ConstructionCertificateBatchApiTests(unittest.TestCase):
    def setUp(self):
        # Windows asyncio may use a loopback socket pair for its internal wake-up.
        for method in ("connect", "connect_ex"):
            self.enterContext(patch.object(socket.socket, method, loopback_only(getattr(socket.socket, method))))
        self.reader = Mock(spec=["ensure_token", "list_records", "update_record"])
        self.reader.update_record.return_value = True
        self.reader.list_records.return_value = [{"record_id": "rec-lookup", "fields": {"id": "SYN-1", "name": "Alice"}}]
        self.reader_factory = self.enterContext(patch.object(service, "FeishuTableReader", return_value=self.reader))
        self.browser = self.enterContext(patch.object(service, "CertificateQuery"))
        self.query = self.browser.return_value.__enter__.return_value.run_batch_query
        self.query_status = "success"
        self.query.side_effect = lambda people: [
            service.PersonQueryResult(
                record_id=person["record_id"], name=person["name"], id_number=person["id_number"],
                status=self.query_status, error=None,
            ) for person in people
        ]

        async def run(*, request_id, work, is_disconnected):
            return service.QueuedRunResult(result=await work(), queued_seconds=0.01, execution_seconds=0.02)

        self.coordinator = AsyncMock(side_effect=run)
        self.enterContext(patch.object(server, "REQUEST_COORDINATOR", SimpleNamespace(run=self.coordinator)))
        self.client = self.enterContext(TestClient(server.app))

    def payload(self):
        return {
            "feishu": dict(FEISHU), "field_mapping": copy.deepcopy(MAPPING),
            "people": [{"record_id": " rec-1 ", "name": " Alice ", "id_number": " SYN-1 "}],
        }

    def test_valid_batch_constructs_real_service_and_serializes_real_result(self):
        payload = self.payload()
        payload["people"][0].pop("record_id")
        payload["lookup"] = {"id_number_field": "id", "name_field": "name"}
        response = self.client.post("/api/v1/query/batch", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.reader_factory.assert_called_once_with(**FEISHU)
        self.reader.ensure_token.assert_called_once_with()
        self.reader.list_records.assert_called_once_with(field_names=["id", "name"])
        self.query.assert_called_once_with([{"record_id": "", "name": "Alice", "id_number": "SYN-1"}])
        self.reader.update_record.assert_called_once_with("rec-lookup", {"expire": None, "due": None, "actual": None, "files": []})
        self.coordinator.assert_awaited_once()
        self.assertEqual(body["request_id"], self.coordinator.call_args.kwargs["request_id"])
        uuid.UUID(body["request_id"])
        self.assertTrue(callable(self.coordinator.call_args.kwargs["is_disconnected"]))
        self.assertEqual((body["total"], body["success"], body["failed"]), (1, 1, 0))
        self.assertEqual((body["queued_seconds"], body["execution_seconds"]), (0.01, 0.02))
        for key in ("query_seconds", "writeback_seconds"):
            self.assertGreaterEqual(body[key], 0)
        self.assertEqual(body["results"], [{
            "name": "Alice", "id_number": "SYN-1", "success": True, "record_id": "rec-lookup",
            "query_status": "查询成功", "query_error": None, "writeback_error": None,
        }])

    def assert_rejected(self, payload, detail):
        response = self.client.post("/api/v1/query/batch", json=payload)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"detail": detail})
        self.reader_factory.assert_not_called()
        self.browser.assert_not_called()
        self.coordinator.assert_not_called()

    def test_empty_people_is_rejected_before_processing(self):
        payload = self.payload()
        payload["people"] = []
        self.assert_rejected(payload, "people 不能为空")

    def test_more_than_twenty_people_is_rejected_before_processing(self):
        payload = self.payload()
        payload["people"] *= 21
        self.assert_rejected(payload, "单次最多查询 20 人")

    def test_empty_mapping_is_rejected_before_processing(self):
        payload = self.payload()
        payload["field_mapping"] = {}
        self.assert_rejected(payload, "field_mapping 不能为空")

    def test_twenty_people_is_accepted(self):
        payload = self.payload()
        payload["people"] *= 20
        response = self.client.post("/api/v1/query/batch", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual((body["total"], body["success"], body["failed"]), (20, 20, 0))

    def test_failed_query_skips_writeback_and_preserves_failure_response(self):
        self.query_status = "fail_no_data"
        response = self.client.post("/api/v1/query/batch", json=self.payload())
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual((body["total"], body["success"], body["failed"]), (1, 0, 1))
        self.assertEqual(body["results"][0]["query_status"], "未查询到证件信息")
        self.assertEqual(body["results"][0]["writeback_error"], "查询未成功，跳过回填")
        self.reader.update_record.assert_not_called()


if __name__ == "__main__":
    unittest.main()
