# services/storage-service/app/routers/websocket_optimized.py

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query, HTTPException, Depends
from typing import Dict, Set, Optional
import json, asyncio, time
from datetime import datetime, timedelta
from collections import defaultdict
import logging
from ..database import get_redis, async_session
from ..services.auth import auth_service
from ..dependencies import get_current_user  # Add this import

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1")

class RateLimiter:
    """Simple rate limiter for WebSocket messages"""
    
    def __init__(self, max_messages: int = 100, window_seconds: int = 60):
        self.max_messages = max_messages
        self.window_seconds = window_seconds
        self.user_messages = defaultdict(list)
    
    def is_allowed(self, user_id: str) -> bool:
        now = time.time()
        # Clean old messages
        self.user_messages[user_id] = [
            timestamp for timestamp in self.user_messages[user_id]
            if now - timestamp < self.window_seconds
        ]
        
        # Check rate limit
        if len(self.user_messages[user_id]) >= self.max_messages:
            return False
        
        # Add current message
        self.user_messages[user_id].append(now)
        return True

class EnhancedConnectionManager:
    def __init__(self, 
                 max_connections_per_user: int = 5,
                 max_total_connections: int = 500,
                 heartbeat_interval: int = 30):
        
        # Connection storage
        self.active_connections: Dict[str, Set[WebSocket]] = {}
        self.websocket_to_user: Dict[WebSocket, str] = {}
        
        # Connection limits
        self.max_connections_per_user = max_connections_per_user
        self.max_total_connections = max_total_connections
        
        # Heartbeat settings
        self.heartbeat_interval = heartbeat_interval
        self.last_ping: Dict[WebSocket, datetime] = {}
        
        # Rate limiting
        self.rate_limiter = RateLimiter()
        
        # Metrics
        self.metrics = {
            "total_connections": 0,
            "messages_sent": 0,
            "messages_received": 0,
            "errors": 0,
            "rate_limit_hits": 0
        }
    
    @property
    def total_connections(self) -> int:
        return sum(len(sockets) for sockets in self.active_connections.values())
    
    async def can_connect(self, user_id: str) -> tuple[bool, str]:
        """Check if a new connection is allowed"""
        
        # Check total connections limit
        if self.total_connections >= self.max_total_connections:
            return False, "Server at capacity"
        
        # Check per-user limit
        user_connections = len(self.active_connections.get(user_id, set()))
        if user_connections >= self.max_connections_per_user:
            return False, f"User connection limit reached ({self.max_connections_per_user})"
        
        return True, "OK"
    
    async def connect(self, websocket: WebSocket, user_id: str) -> bool:
        """Accept and register a new WebSocket connection"""
        
        # Check connection limits
        can_connect, reason = await self.can_connect(user_id)
        if not can_connect:
            await websocket.close(code=4008, reason=reason)
            logger.warning(f"Connection rejected for user {user_id}: {reason}")
            return False
        
        # Accept the connection
        try:
            await websocket.accept()
        except Exception as e:
            logger.error(f"Failed to accept WebSocket: {e}")
            return False
        
        # Register connection
        if user_id not in self.active_connections:
            self.active_connections[user_id] = set()
        self.active_connections[user_id].add(websocket)
        self.websocket_to_user[websocket] = user_id
        self.last_ping[websocket] = datetime.utcnow()
        
        # Update metrics
        self.metrics["total_connections"] += 1
        
        # Send connection confirmation
        await self.send_json_safe(websocket, {
            "type": "connection",
            "status": "connected",
            "user_id": user_id,
            "timestamp": datetime.utcnow().isoformat(),
            "limits": {
                "max_connections": self.max_connections_per_user,
                "current_connections": len(self.active_connections[user_id])
            }
        })
        
        logger.info(f"WebSocket connected for user: {user_id} (total: {self.total_connections})")
        return True
    
    def disconnect(self, websocket: WebSocket):
        """Remove a WebSocket connection"""
        user_id = self.websocket_to_user.get(websocket)
        
        if user_id:
            # Remove from active connections
            if user_id in self.active_connections:
                self.active_connections[user_id].discard(websocket)
                if not self.active_connections[user_id]:
                    del self.active_connections[user_id]
            
            # Clean up mappings
            self.websocket_to_user.pop(websocket, None)
            self.last_ping.pop(websocket, None)
            
            logger.info(f"WebSocket disconnected for user: {user_id} (total: {self.total_connections})")
    
    async def send_json_safe(self, websocket: WebSocket, data: dict) -> bool:
        """Send JSON data safely, handling disconnections"""
        try:
            await websocket.send_json(data)
            self.metrics["messages_sent"] += 1
            return True
        except (WebSocketDisconnect, ConnectionResetError, BrokenPipeError) as e:
            logger.debug(f"WebSocket send failed (disconnected): {e}")
            self.metrics["errors"] += 1
            return False
        except Exception as e:
            logger.error(f"WebSocket send error: {e}")
            self.metrics["errors"] += 1
            return False
    
    async def handle_message(self, websocket: WebSocket, user_id: str, message: dict):
        """Process incoming WebSocket message with rate limiting"""
        
        # Check rate limit
        if not self.rate_limiter.is_allowed(user_id):
            self.metrics["rate_limit_hits"] += 1
            await self.send_json_safe(websocket, {
                "type": "error",
                "message": "Rate limit exceeded. Please slow down.",
                "timestamp": datetime.utcnow().isoformat()
            })
            return
        
        self.metrics["messages_received"] += 1
        message_type = message.get("type")
        
        # Handle different message types
        if message_type == "ping":
            self.last_ping[websocket] = datetime.utcnow()
            await self.send_json_safe(websocket, {
                "type": "pong",
                "timestamp": datetime.utcnow().isoformat()
            })
        
        elif message_type == "upload_progress":
            # Broadcast to user's other sessions
            await self.send_to_user(user_id, {
                "type": "upload_progress",
                "file_id": message.get("file_id"),
                "progress": message.get("progress"),
                "timestamp": datetime.utcnow().isoformat()
            }, exclude_socket=websocket)
        
        # Add more message handlers as needed
    
    async def send_to_user(self, user_id: str, message: dict, exclude_socket: WebSocket = None):
        """Send message to all connections for a user"""
        if user_id not in self.active_connections:
            return
        
        connections = list(self.active_connections[user_id])
        failed_sockets = []
        
        for websocket in connections:
            if websocket == exclude_socket:
                continue
            
            if not await self.send_json_safe(websocket, message):
                failed_sockets.append(websocket)
        
        # Clean up failed connections
        for websocket in failed_sockets:
            self.disconnect(websocket)
    
    async def check_heartbeats(self):
        """Background task to check connection health"""
        while True:
            try:
                await asyncio.sleep(self.heartbeat_interval)
                now = datetime.utcnow()
                timeout = timedelta(seconds=self.heartbeat_interval * 3)
                
                disconnected = []
                for websocket, last_ping in list(self.last_ping.items()):
                    if now - last_ping > timeout:
                        logger.warning(f"WebSocket timeout for socket {id(websocket)}")
                        disconnected.append(websocket)
                
                # Close timed-out connections
                for websocket in disconnected:
                    try:
                        await websocket.close(code=4009, reason="Heartbeat timeout")
                    except:
                        pass
                    self.disconnect(websocket)
                    
            except Exception as e:
                logger.error(f"Heartbeat check error: {e}")
    
    def get_metrics(self) -> dict:
        """Get connection metrics"""
        return {
            **self.metrics,
            "active_connections": self.total_connections,
            "users_connected": len(self.active_connections)
        }

# Create global connection manager
manager = EnhancedConnectionManager(
    max_connections_per_user=5,
    max_total_connections=500,  # For 100 users with headroom
    heartbeat_interval=30
)

# Start heartbeat checker on startup
@router.on_event("startup")
async def startup_event():
    asyncio.create_task(manager.check_heartbeats())

@router.websocket("/ws")
async def websocket_endpoint(
    websocket: WebSocket,
    token: str = Query(...),
):
    """Enhanced WebSocket endpoint with connection pooling and rate limiting"""
    
    # Authenticate user
    try:
        async with async_session() as db:
            user = await auth_service.get_current_user_from_token(token, db)
            if not user:
                await websocket.close(code=4001, reason="Unauthorized")
                return
        
        user_id = str(user.id)
        
    except Exception as e:
        logger.error(f"WebSocket auth error: {e}")
        await websocket.close(code=4001, reason="Authentication failed")
        return
    
    # Connect with limits
    if not await manager.connect(websocket, user_id):
        return
    
    redis_client = await get_redis()
    
    try:
        # Main message loop
        while True:
            # Receive with timeout for better connection management
            try:
                data = await asyncio.wait_for(
                    websocket.receive_json(),
                    timeout=60.0  # 60 second timeout
                )
            except asyncio.TimeoutError:
                # Send ping on timeout
                if await manager.send_json_safe(websocket, {"type": "ping"}):
                    continue
                else:
                    break
            
            # Handle message
            await manager.handle_message(websocket, user_id, data)
            
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected normally for user {user_id}")
    except Exception as e:
        logger.error(f"WebSocket error for user {user_id}: {e}")
    finally:
        manager.disconnect(websocket)
        # Clean up Redis subscriptions
        try:
            await redis_client.delete(f"ws:subs:{user_id}")
        except:
            pass

# API endpoint to check WebSocket metrics
@router.get("/ws/metrics")
async def get_websocket_metrics(
    current_user = Depends(get_current_user)  # Optional: require auth
):
    """Get WebSocket connection metrics"""
    return manager.get_metrics()