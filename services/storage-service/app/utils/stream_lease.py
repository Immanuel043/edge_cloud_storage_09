"""Stream-slot lease management decoupled from async-generator cleanup.

Owning a stream slot inside a try/finally on an async generator races with
PEP 525 cleanup when the client disconnects mid-stream (the await in finally
collides with aclose() of inner generators). This module owns the slot via
an explicit acquire/release pair whose release is invoked from a Starlette
BackgroundTask attached to the StreamingResponse — outside any generator's
finally block — eliminating the race by construction.
"""
import asyncio
import logging
from typing import Optional

from fastapi import HTTPException

from ..services.bandwidth_throttle import bandwidth_throttle_service

logger = logging.getLogger(__name__)


class StreamLease:
    """A non-context-manager acquire/release pair for a Redis stream slot.

    Why not __aenter__/__aexit__? Because we want acquire to happen in the
    request handler (so a 429 fails fast before StreamingResponse starts)
    and release to happen via Starlette's response.background task (so it
    runs after the body finishes streaming, success OR cancel, OUTSIDE
    any generator's finally clause).
    """

    def __init__(
        self,
        user_id: str,
        plan_type: str,
        db_streams_override: Optional[int] = None,
    ):
        self.user_id = user_id
        self.plan_type = plan_type
        self.db_streams_override = db_streams_override
        self._acquired = False
        self._release_started = False
        self._released = False

    async def acquire(self) -> None:
        """Try to take a slot. Raises HTTPException 429 on limit."""
        max_streams = await bandwidth_throttle_service.get_max_streams_with_plan(
            self.user_id, self.plan_type, self.db_streams_override
        )
        ok = await bandwidth_throttle_service.acquire_stream_slot(
            self.user_id,
            plan_type=self.plan_type,
            db_streams_override=self.db_streams_override,
        )
        if not ok:
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Too many concurrent downloads. Maximum {max_streams} "
                    f"streams allowed for your plan."
                ),
                headers={"Retry-After": "10"},
            )
        self._acquired = True

    async def release(self) -> None:
        """Best-effort, cancellation-resistant release.

        Uses asyncio.shield so caller cancellation does not interrupt the
        Redis DECR mid-flight. Shield is NOT a hard guarantee — at process
        shutdown or hard task abort, the shielded coroutine can still be
        torn down. The Redis stream-slot key has STREAM_SLOT_TTL as a
        backstop sweep that picks up any orphaned slot.

        `_release_started` guards against double-call (BackgroundTask
        firing after a manual error-path release). `_released` is only
        set after the inner call returns, so a partial failure leaves
        the lease in a state where a subsequent retry could be meaningful.
        """
        if not self._acquired or self._release_started:
            return
        self._release_started = True
        try:
            await asyncio.shield(
                bandwidth_throttle_service.release_stream_slot(self.user_id)
            )
            self._released = True
        except asyncio.CancelledError:
            # Caller task was cancelled. The shield kept the inner release
            # running to completion (in the common case); propagate cancel.
            self._released = True
            raise
        except Exception as exc:
            logger.warning(
                "Stream lease release failed for user %s: %s", self.user_id, exc
            )
