"""`POST /ultra_paint/api/interrupt` -- cancel the in-flight generation.

Ultra Paint runs generation via `main_thread.run_and_wait_result` on Forge's
single GPU worker thread (see `generation.py`'s module docstring); this route
runs on the ordinary FastAPI request thread and simply flips
`shared.state.interrupted`, the exact same flag `Interrupt` in the stock
txt2img/img2img tabs sets (`modules/shared_state.py:89-91`,
`modules/ui_toprow.py`). Forge's sampling loop polls this flag between steps
and stops early -- this route does no GPU work itself and does not need
`main_thread`/`queue_lock` involvement, matching how the stock UI's own
interrupt button works (fire-and-forget, no wait for acknowledgement).

Deliberately a no-op (not an error) when nothing is running: `shared.state`
has no notion of "which job", so this can't distinguish "no job running" from
"an Ultra Paint job specifically" -- same ambiguity the stock UI's Interrupt
button already has and is not in scope to fix here.
"""

from pydantic import BaseModel

from modules import shared

__all__ = ["INTERRUPT_ROUTE", "InterruptResponse", "interrupt_generation"]

INTERRUPT_ROUTE = "/ultra_paint/api/interrupt"


class InterruptResponse(BaseModel):
    interrupted: bool


def interrupt_generation() -> InterruptResponse:
    shared.state.interrupt()
    return InterruptResponse(interrupted=True)
