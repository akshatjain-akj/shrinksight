import pytest
from fastapi.testclient import TestClient

from app import main
from app.config import Settings
from app.demo import MemoryDemoStore
from app.gemini import FunctionCall, GenResult
from app.repo import MemoryRepo


class FakeGateway:
    """Returns scripted GenResults (or raises scripted exceptions) in order; records every call."""

    def __init__(self, script: list):
        self.script = list(script)
        self.calls: list[tuple] = []

    uploads: list = []
    deleted: list = []

    def upload_video(self, data, mime, timeout_s=60):
        from app.gemini import UploadedFile

        self.uploads = [*self.uploads, (len(data), mime)]
        return UploadedFile(name="files/test-1", uri="https://files.test/1", mime_type=mime)

    def delete_file(self, name):
        self.deleted = [*self.deleted, name]

    def generate(self, model, contents, config, deadline=None, retries=None, timeout_ms=None):
        self.calls.append((model, contents, config))
        if not self.script:
            raise AssertionError("FakeGateway: no scripted response left")
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def call(name: str, **args) -> GenResult:
    return GenResult(function_calls=[FunctionCall(name=name, args=args)])


def text(value: str) -> GenResult:
    return GenResult(text=value)


@pytest.fixture
def repo() -> MemoryRepo:
    return MemoryRepo()


@pytest.fixture
def settings() -> Settings:
    return Settings(gemini_api_key="test-key", investigator_model="test-model", gemini_model="test-model",
                    fallback_models=(), auth_secret="")


@pytest.fixture
def api(repo, settings):
    """TestClient wired to the in-memory repo. Set `api.gateway = FakeGateway([...])` per test."""
    main.app.state.repo = repo
    main.app.state.settings = settings
    main.app.state.gateway = FakeGateway([])
    main.app.state.demo_store = MemoryDemoStore()
    client = TestClient(main.app)
    client.repo = repo
    yield client
    main.app.state.repo = None
    main.app.state.gateway = None
    main.app.state.demo_store = None
    main.app.state.settings = main.settings
