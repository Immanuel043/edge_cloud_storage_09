# services/storage-service/app/routers/websocket.py

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from typing import Dict, Set
import json, uuid, asyncio
from datetime import datetime
from ..database import get_redis, async_session
from ..services.auth import auth_service
from fastapi import WebSocket, Query

router = APIRouter(prefix="/api/v1")

class ConnectionManager:
    def __init__(self):
        # Store active connections: user_id -> set of websockets
        self.active_connections: Dict[str, Set[WebSocket]] = {}
        # Store websocket to user mapping for cleanup
        self.websocket_to_user: Dict[WebSocket, str] = {}
        
    async def connect(self, websocket: WebSocket, user_id: str):
        """Accept and register a new WebSocket connection"""
        await websocket.accept()
        
        # Add to user's connections
        if user_id not in self.active_connections:
            self.active_connections[user_id] = set()
        self.active_connections[user_id].add(websocket)
        
        # Store reverse mapping
        self.websocket_to_user[websocket] = user_id
        
        # Send connection confirmation
        await websocket.send_json({
            "type": "connection",
            "status": "connected",
            "user_id": user_id,
            "timestamp": datetime.utcnow().isoformat()
        })
        
        print(f"WebSocket connected for user: {user_id}")
    
    def disconnect(self, websocket: WebSocket):
        """Remove a WebSocket connection"""
        # Get user_id from reverse mapping
        user_id = self.websocket_to_user.get(websocket)
        
        if user_id:
            # Remove from user's connections
            if user_id in self.active_connections:
                self.active_connections[user_id].discard(websocket)
                
                # Clean up empty sets
                if not self.active_connections[user_id]:
                    del self.active_connections[user_id]
            
            # Remove reverse mapping
            del self.websocket_to_user[websocket]
            
            print(f"WebSocket disconnected for user: {user_id}")
    
    async def send_to_user(self, user_id: str, message: dict):
        """Send message to all connections for a specific user"""
        if user_id in self.active_connections:
            # Send to all user's connections (multiple tabs/devices)
            disconnected = []
            
            for websocket in self.active_connections[user_id]:
                try:
                    await websocket.send_json(message)
                except:
                    # Mark for removal if send fails
                    disconnected.append(websocket)
            
            # Clean up disconnected websockets
            for ws in disconnected:
                self.disconnect(ws)
    
    async def broadcast_to_users(self, user_ids: list, message: dict):
        """Send message to multiple users"""
        for user_id in user_ids:
            await self.send_to_user(user_id, message)
    
    async def broadcast_all(self, message: dict):
        """Broadcast message to all connected users"""
        for user_id in self.active_connections:
            await self.send_to_user(user_id, message)

# Create global connection manager
manager = ConnectionManager()

@router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    token: str = Query(...),
):
    """Main WebSocket endpoint for real-time communication"""
    
    print(f"WebSocket connection attempt with token: {token[:20]}...")  # Debug log
    
    # Authenticate user from token
    try:
        # Don't re-import, use the ones from top
        async with async_session() as db:
            user = await auth_service.get_current_user_from_token(token, db)
            print(f"Authentication result: {user}")  # Debug log
            
            if not user:
                print("User not found or token invalid")  # Debug log
                await websocket.close(code=4001, reason="Unauthorized")
                return
        
        user_id = str(user.id)
        print(f"WebSocket authenticated for user: {user_id}")  # Debug log
        
    except Exception as e:
        print(f"WebSocket auth error: {e}")
        import traceback
        traceback.print_exc()
        await websocket.close(code=4001, reason="Authentication failed")
        return
    
    # Connect the WebSocket
    await manager.connect(websocket, user_id)
    
    # Get Redis for pub/sub
    redis_client = await get_redis()
    
    try:
        # Main message loop
        while True:
            # Receive message from client
            data = await websocket.receive_json()
            
            # Handle different message types
            message_type = data.get("type")
            
            if message_type == "ping":
                # Heartbeat
                await websocket.send_json({
                    "type": "pong",
                    "timestamp": datetime.utcnow().isoformat()
                })
            
            elif message_type == "upload_progress":
                # Broadcast upload progress to user's other sessions
                await manager.send_to_user(user_id, {
                    "type": "upload_progress",
                    "file_id": data.get("file_id"),
                    "progress": data.get("progress"),
                    "timestamp": datetime.utcnow().isoformat()
                })
            
            elif message_type == "file_operation":
                # Handle file operations (delete, rename, move)
                operation = data.get("operation")
                file_id = data.get("file_id")
                
                # Broadcast to user's other sessions
                await manager.send_to_user(user_id, {
                    "type": "file_update",
                    "operation": operation,
                    "file_id": file_id,
                    "timestamp": datetime.utcnow().isoformat()
                })
            
            elif message_type == "subscribe":
                # Subscribe to specific events
                channel = data.get("channel")
                if channel:
                    # Store subscription in Redis
                    await redis_client.sadd(f"ws:subs:{user_id}", channel)
            
            elif message_type == "unsubscribe":
                # Unsubscribe from events
                channel = data.get("channel")
                if channel:
                    await redis_client.srem(f"ws:subs:{user_id}", channel)
                    
    except WebSocketDisconnect:
        manager.disconnect(websocket)
        # Clean up Redis subscriptions
        await redis_client.delete(f"ws:subs:{user_id}")
        
    except Exception as e:
        print(f"WebSocket error for user {user_id}: {e}")
        manager.disconnect(websocket)
        await redis_client.delete(f"ws:subs:{user_id}")

# Helper functions to send notifications from other parts of the app

async def notify_file_uploaded(user_id: str, file_info: dict):
    """Notify user when a file is uploaded"""
    await manager.send_to_user(user_id, {
        "type": "notification",
        "event": "file_uploaded",
        "data": file_info,
        "timestamp": datetime.utcnow().isoformat()
    })

async def notify_file_deleted(user_id: str, file_id: str):
    """Notify user when a file is deleted"""
    await manager.send_to_user(user_id, {
        "type": "notification",
        "event": "file_deleted",
        "file_id": file_id,
        "timestamp": datetime.utcnow().isoformat()
    })

async def notify_storage_update(user_id: str, storage_info: dict):
    """Notify user of storage quota updates"""
    await manager.send_to_user(user_id, {
        "type": "notification",
        "event": "storage_update",
        "data": storage_info,
        "timestamp": datetime.utcnow().isoformat()
    })

async def broadcast_system_message(message: str, level: str = "info"):
    """Broadcast system message to all users"""
    await manager.broadcast_all({
        "type": "system",
        "level": level,
        "message": message,
        "timestamp": datetime.utcnow().isoformat()
    })