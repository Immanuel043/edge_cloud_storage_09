# services/storage-service/app/__init__.py
"""Edge Cloud Storage Service"""
def __getattr__(name):
    if name == "__version__":
        from .config import settings
        return settings.VERSION
    raise AttributeError(name)








