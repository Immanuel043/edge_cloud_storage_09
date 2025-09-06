from aiocache import Cache
from aiocache.serializers import JsonSerializer
from functools import wraps
import hashlib
import json
import uuid
import datetime
import decimal

def _custom_default(obj):
    """Convert unsupported types to JSON-safe values"""
    if isinstance(obj, uuid.UUID):
        return str(obj)
    if isinstance(obj, (datetime.datetime, datetime.date)):
        return obj.isoformat()
    if isinstance(obj, decimal.Decimal):
        return float(obj)
    # Let json raise TypeError for anything else
    raise TypeError(f"Object of type {obj.__class__.__name__} is not JSON serializable")

def _custom_dumps(value):
    return json.dumps(value, default=_custom_default)

def _custom_loads(value):
    if value is None:   # ✅ handle cache misses
        return None
    return json.loads(value)

# Custom JSON serializer with safe None handling
class CustomJsonSerializer(JsonSerializer):
    def dumps(self, value):
        return _custom_dumps(value)

    def loads(self, value):
        if value is None:   # ✅ handle cache misses
            return None
        return _custom_loads(value)

# Global cache client
cache = Cache(Cache.REDIS, endpoint="redis", port=6379, serializer=CustomJsonSerializer())

def cache_key(*args, **kwargs):
    """Generate cache key from function + args"""
    key = hashlib.md5(f"{args}{kwargs}".encode()).hexdigest()
    return f"cache:{key}"

def cached(expire=60):
    """Decorator for caching async function results"""
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            key = cache_key(func.__name__, args, kwargs)
            
            # Try cache
            result = await cache.get(key)
            if result is not None:
                return result
            
            # Compute & store
            result = await func(*args, **kwargs)
            try:
                await cache.set(key, result, ttl=expire)
            except TypeError as e:
                # Log but don’t fail if serialization breaks
                print(f"[Cache Warning] Could not cache result for {func.__name__}: {e}")
            return result
        return wrapper
    return decorator
