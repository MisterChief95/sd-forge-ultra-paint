"""Unit tests for `ultra_paint.resolution_step` (Phase 3 follow-up, 2026-08-24).

Pure logic, no Forge runtime dependency -- deliberately duck-typed for
exactly this reason (see the module docstring).
"""

from ultra_paint.resolution_step import (
    DEFAULT_RESOLUTION_STEP,
    has_resolution_step_setting,
    resolution_step_for,
)


class _FakeOpts:
    def __init__(self, data_labels=None, data=None):
        self.data_labels = data_labels if data_labels is not None else {}
        self.data = data if data is not None else {}


def test_default_step_is_64():
    assert DEFAULT_RESOLUTION_STEP == 64


def test_has_resolution_step_setting_true_when_registered():
    opts = _FakeOpts(data_labels={"res_step": object()})
    assert has_resolution_step_setting(opts) is True


def test_has_resolution_step_setting_false_when_not_registered():
    opts = _FakeOpts(data_labels={})
    assert has_resolution_step_setting(opts) is False


def test_has_resolution_step_setting_false_for_bare_object_missing_data_labels():
    class BareStub:
        pass

    assert has_resolution_step_setting(BareStub()) is False


def test_reads_configured_value_when_registered_and_set():
    opts = _FakeOpts(data_labels={"res_step": object()}, data={"res_step": 32})
    assert resolution_step_for(opts) == 32


def test_falls_back_to_default_when_registered_but_unset():
    # Common case: setting is registered but the user never overrode it, so
    # opts.data has no "res_step" key at all -- Options only stores overrides.
    opts = _FakeOpts(data_labels={"res_step": object()}, data={})
    assert resolution_step_for(opts) == DEFAULT_RESOLUTION_STEP


def test_falls_back_to_default_when_not_registered_even_if_data_has_a_value():
    # Registration gates whether we trust the value at all -- a stale/unrelated
    # "res_step" key in .data on a build that doesn't register the option
    # should not be trusted.
    opts = _FakeOpts(data_labels={}, data={"res_step": 128})
    assert resolution_step_for(opts) == DEFAULT_RESOLUTION_STEP


def test_falls_back_to_default_for_non_positive_value():
    opts = _FakeOpts(data_labels={"res_step": object()}, data={"res_step": 0})
    assert resolution_step_for(opts) == DEFAULT_RESOLUTION_STEP

    opts_negative = _FakeOpts(
        data_labels={"res_step": object()}, data={"res_step": -64}
    )
    assert resolution_step_for(opts_negative) == DEFAULT_RESOLUTION_STEP


def test_falls_back_to_default_for_non_numeric_value():
    opts = _FakeOpts(
        data_labels={"res_step": object()}, data={"res_step": "not-a-number"}
    )
    assert resolution_step_for(opts) == DEFAULT_RESOLUTION_STEP


def test_none_opts_like_object_falls_back_to_default():
    class BareStub:
        pass

    assert resolution_step_for(BareStub()) == DEFAULT_RESOLUTION_STEP
