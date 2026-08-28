"""Unit tests for `ultra_paint.resolution_step` (Phase 3 follow-up, 2026-08-24).

Pure logic, no Forge runtime dependency -- deliberately duck-typed for
exactly this reason (see the module docstring).
"""

from ultra_paint.resolution_step import DEFAULT_RESOLUTION_STEP, resolution_step_for


class _FakeOpts:
    def __init__(self, data_labels=None, data=None):
        self.data_labels = data_labels if data_labels is not None else {}
        self.data = data if data is not None else {}


def test_default_step_is_64():
    assert DEFAULT_RESOLUTION_STEP == 64


def test_ignores_forges_configured_res_step():
    # Ultra Paint deliberately does not honor Forge's `res_step` setting for
    # its own Auto-scale target -- see the module docstring for why.
    opts = _FakeOpts(data_labels={"res_step": object()}, data={"res_step": 32})
    assert resolution_step_for(opts) == DEFAULT_RESOLUTION_STEP


def test_none_opts_like_object_falls_back_to_default():
    class BareStub:
        pass

    assert resolution_step_for(BareStub()) == DEFAULT_RESOLUTION_STEP
