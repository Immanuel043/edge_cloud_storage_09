"""
WebSocket Connection Manager for ZK Service

Manages WebSocket connections and event broadcasting for real-time updates.
Provides user-specific connection routing and automatic cleanup.
"""
from typing import Dict, Set
from uuid import UUID
from fastapi import WebSocket
from datetime import datetime, timezone
import structlog
import json

logger = structlog.get_logger()


class ConnectionManager:
    """Manages WebSocket connections for real-time updates"""

    def __init__(self):
        # user_id (UUID) -> set of WebSocket connections
        self.active_connections: Dict[UUID, Set[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, user_id: UUID):
        """Register new WebSocket connection

        Args:
            websocket: WebSocket connection to register
            user_id: User ID (UUID) for routing messages
        """
        await websocket.accept()

        if user_id not in self.active_connections:
            self.active_connections[user_id] = set()

        self.active_connections[user_id].add(websocket)
        logger.info(
            "websocket_connected",
            user_id=user_id,
            total_connections=len(self.active_connections[user_id])
        )

    def disconnect(self, websocket: WebSocket, user_id: UUID):
        """Remove WebSocket connection

        Args:
            websocket: WebSocket connection to remove
            user_id: User ID (UUID) for the connection
        """
        if user_id in self.active_connections:
            self.active_connections[user_id].discard(websocket)
            if not self.active_connections[user_id]:
                del self.active_connections[user_id]

        logger.info("websocket_disconnected", user_id=user_id)

    async def send_to_user(self, user_id: UUID, event: str, data: dict):
        """Send event to all connections for a specific user

        Args:
            user_id: Target user ID (UUID)
            event: Event type (e.g., 'zk:file:uploaded')
            data: Event payload
        """
        if user_id not in self.active_connections:
            logger.debug(
                "websocket_send_skipped_no_connections",
                user_id=user_id,
                event=event
            )
            return

        message = json.dumps({
            "event": event,
            "data": data,
            "timestamp": datetime.now(timezone.utc).isoformat()
        })

        # Send to all user's connections
        disconnected = set()
        for websocket in self.active_connections[user_id]:
            try:
                await websocket.send_text(message)
                logger.debug(
                    "websocket_message_sent",
                    user_id=user_id,
                    event=event
                )
            except Exception as e:
                logger.error(
                    "websocket_send_failed",
                    user_id=user_id,
                    event=event,
                    error=str(e)
                )
                disconnected.add(websocket)

        # Cleanup failed connections
        for ws in disconnected:
            self.disconnect(ws, user_id)

    def get_stats(self) -> dict:
        """Get connection statistics

        Returns:
            dict: Statistics about active connections
        """
        return {
            "total_users": len(self.active_connections),
            "total_connections": sum(len(conns) for conns in self.active_connections.values()),
            "users_online": [str(uid) for uid in self.active_connections.keys()]
        }


# Singleton instance
connection_manager = ConnectionManager()
