"""Unit tests for `ultra_paint.interrupt_api` (Phase 3 follow-up, T41)."""

import sys
import types

import pytest


@pytest.fixture
def fake_forge_modules(monkeypatch):
    fake_modules = types.ModuleType("modules")
    fake_modules.__path__ = []

    class _FakeSharedState:
        def __init__(self):
            self.interrupted = False

        def interrupt(self):
            self.interrupted = True

    fake_shared_module = types.ModuleType("modules.shared")
    fake_shared_module.state = _FakeSharedState()

    fake_modules.shared = fake_shared_module

    modules_to_install = {
        "modules": fake_modules,
        "modules.shared": fake_shared_module,
    }
    for name, module in modules_to_install.items():
        monkeypatch.setitem(sys.modules, name, module)

    monkeypatch.delitem(sys.modules, "ultra_paint.interrupt_api", raising=False)

    import ultra_paint.interrupt_api as interrupt_api_module

    yield interrupt_api_module, fake_shared_module

    monkeypatch.delitem(sys.modules, "ultra_paint.interrupt_api", raising=False)


def test_interrupt_sets_shared_state_flag(fake_forge_modules):
    interrupt_api, fake_shared = fake_forge_modules

    assert fake_shared.state.interrupted is False

    response = interrupt_api.interrupt_generation()

    assert fake_shared.state.interrupted is True
    assert response.interrupted is True


def test_interrupt_route_constant():
    from ultra_paint.interrupt_api import INTERRUPT_ROUTE

    assert INTERRUPT_ROUTE == "/ultra_paint/api/interrupt"
