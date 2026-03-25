"""
Elasticsearch Search Service for Full-Text Search
"""
import asyncio
import logging
from typing import List, Dict, Any, Optional
from datetime import datetime
from elasticsearch import AsyncElasticsearch
from elasticsearch.helpers import async_bulk
import os

from ..config import settings

logger = logging.getLogger(__name__)


def safe_isoformat(dt):
    """Safely convert datetime to ISO format string, handling both datetime objects and strings."""
    if dt is None:
        return datetime.utcnow().isoformat()
    if hasattr(dt, 'isoformat'):
        return dt.isoformat()
    return str(dt)

class SearchService:
    def __init__(self):
        self.es_url = settings.ELASTICSEARCH_URL
        self.client: Optional[AsyncElasticsearch] = None
        self.connected: bool = False  # Track connection state
        self.files_index = f'{settings.ELASTICSEARCH_INDEX_PREFIX}_files'
        self.folders_index = f'{settings.ELASTICSEARCH_INDEX_PREFIX}_folders'

    async def connect(self):
        """Initialize Elasticsearch connection"""
        # Check if ES is enabled
        if not settings.ELASTICSEARCH_ENABLED:
            logger.info("Elasticsearch is disabled by configuration (ELASTICSEARCH_ENABLED=false)")
            return

        try:
            self.client = AsyncElasticsearch(
                [self.es_url],
                retry_on_timeout=settings.ELASTICSEARCH_RETRY_ON_TIMEOUT,
                max_retries=settings.ELASTICSEARCH_MAX_RETRIES,
                request_timeout=settings.ELASTICSEARCH_TIMEOUT
            )
            # Test connection
            await self.client.info()
            await self.create_indices()
            self.connected = True
            logger.info(f"Connected to Elasticsearch at {self.es_url}")
        except Exception as e:
            logger.error(f"Failed to connect to Elasticsearch: {e}")
            self.connected = False
            raise

    async def close(self):
        """Close Elasticsearch connection"""
        if self.client:
            await self.client.close()

    async def create_indices(self):
        """Create indices with proper mappings"""
        # Files index mapping
        files_mapping = {
            "mappings": {
                "properties": {
                    "id": {"type": "keyword"},
                    "name": {
                        "type": "text",
                        "fields": {
                            "keyword": {"type": "keyword"},
                            "completion": {"type": "completion"}
                        }
                    },
                    "original_name": {"type": "text"},
                    "mime_type": {"type": "keyword"},
                    "size": {"type": "long"},
                    "hash": {"type": "keyword"},
                    "storage_tier": {"type": "keyword"},
                    "folder_id": {"type": "keyword"},
                    "user_id": {"type": "keyword"},
                    "created_at": {"type": "date"},
                    "updated_at": {"type": "date"},
                    "tags": {"type": "keyword"},
                    "description": {"type": "text"},
                    "ocr_text": {"type": "text"},
                    "searchable_content": {"type": "text"}
                }
            },
            "settings": {
                "analysis": {
                    "analyzer": {
                        "autocomplete": {
                            "type": "custom",
                            "tokenizer": "standard",
                            "filter": ["lowercase", "autocomplete_filter"]
                        }
                    },
                    "filter": {
                        "autocomplete_filter": {
                            "type": "edge_ngram",
                            "min_gram": 2,
                            "max_gram": 20
                        }
                    }
                }
            }
        }

        # Folders index mapping
        folders_mapping = {
            "mappings": {
                "properties": {
                    "id": {"type": "keyword"},
                    "name": {
                        "type": "text",
                        "fields": {
                            "keyword": {"type": "keyword"},
                            "completion": {"type": "completion"}
                        }
                    },
                    "parent_id": {"type": "keyword"},
                    "user_id": {"type": "keyword"},
                    "created_at": {"type": "date"},
                    "updated_at": {"type": "date"},
                    "path": {"type": "text"}
                }
            }
        }

        # Create files index
        if not await self.client.indices.exists(index=self.files_index):
            await self.client.indices.create(index=self.files_index, body=files_mapping)
            logger.info(f"Created index: {self.files_index}")

        # Create folders index
        if not await self.client.indices.exists(index=self.folders_index):
            await self.client.indices.create(index=self.folders_index, body=folders_mapping)
            logger.info(f"Created index: {self.folders_index}")

    async def index_file(self, file_data: Dict[str, Any], retries: int = 3) -> bool:
        """
        Index a file document with retry logic.

        Returns:
            bool: True if indexing succeeded, False otherwise
        """
        # Check if connected
        if not self.connected or self.client is None:
            logger.warning(f"Elasticsearch not connected, skipping file indexing for: {file_data.get('name', 'unknown')}")
            return False

        doc = {
            "id": str(file_data['id']),
            "name": file_data['name'],
            "original_name": file_data.get('original_name', file_data['name']),
            "mime_type": file_data.get('mime_type', ''),
            "size": file_data.get('size', 0),
            "hash": file_data.get('hash', ''),
            "storage_tier": file_data.get('storage_tier', 'warm'),
            "folder_id": str(file_data['folder_id']) if file_data.get('folder_id') else None,
            "user_id": str(file_data['user_id']),
            "created_at": safe_isoformat(file_data.get('created_at')),
            "updated_at": safe_isoformat(file_data.get('updated_at')),
            "tags": file_data.get('tags', []),
            "description": file_data.get('description', '')
        }

        for attempt in range(retries):
            try:
                await self.client.index(
                    index=self.files_index,
                    id=str(file_data['id']),
                    document=doc,
                    request_timeout=5,
                )
                logger.debug(f"Indexed file: {file_data['name']}")
                return True
            except Exception as e:
                if attempt < retries - 1:
                    wait_time = (attempt + 1) * 1  # Exponential backoff: 1s, 2s, 3s
                    logger.warning(f"Failed to index file (attempt {attempt + 1}/{retries}): {e}. Retrying in {wait_time}s...")
                    await asyncio.sleep(wait_time)
                else:
                    logger.error(f"Failed to index file after {retries} attempts: {e}")
                    return False

        return False

    async def index_folder(self, folder_data: Dict[str, Any], retries: int = 3) -> bool:
        """
        Index a folder document with retry logic.

        Returns:
            bool: True if indexing succeeded, False otherwise
        """
        # Check if connected
        if not self.connected or self.client is None:
            logger.warning(f"Elasticsearch not connected, skipping folder indexing for: {folder_data.get('name', 'unknown')}")
            return False

        doc = {
            "id": str(folder_data['id']),
            "name": folder_data['name'],
            "parent_id": str(folder_data['parent_id']) if folder_data.get('parent_id') else None,
            "user_id": str(folder_data['user_id']),
            "created_at": safe_isoformat(folder_data.get('created_at')),
            "updated_at": safe_isoformat(folder_data.get('updated_at')),
            "path": folder_data.get('path', '')
        }

        for attempt in range(retries):
            try:
                await self.client.index(
                    index=self.folders_index,
                    id=str(folder_data['id']),
                    document=doc
                )
                logger.debug(f"Indexed folder: {folder_data['name']}")
                return True
            except Exception as e:
                if attempt < retries - 1:
                    wait_time = (attempt + 1) * 1
                    logger.warning(f"Failed to index folder (attempt {attempt + 1}/{retries}): {e}. Retrying in {wait_time}s...")
                    await asyncio.sleep(wait_time)
                else:
                    logger.error(f"Failed to index folder after {retries} attempts: {e}")
                    return False

        return False

    async def search(
        self,
        query: str,
        user_id: str,
        filters: Optional[Dict[str, Any]] = None,
        size: int = 20,
        from_: int = 0,
        fuzzy: bool = True
    ) -> Dict[str, Any]:
        """
        Full-text search across files and folders

        Args:
            query: Search query
            user_id: User ID for access control
            filters: Additional filters (file_type, size_range, date_range, etc.)
            size: Number of results to return
            from_: Offset for pagination
            fuzzy: Enable fuzzy matching for typo tolerance
        """
        # Check if connected
        if not self.connected or self.client is None:
            logger.warning("Elasticsearch not connected, search unavailable")
            return {"files": {"total": 0, "hits": []}, "folders": {"total": 0, "hits": []}}

        try:
            # Build search query with prioritized exact matches
            must_clauses = [
                {"term": {"user_id": user_id}}
            ]
            
            # Should clauses for boosting (exact matches get higher scores)
            should_clauses = []

            if query:
                # 1. Exact match on filename (highest priority - 100x boost)
                should_clauses.append({
                    "term": {
                        "name.keyword": {
                            "value": query,
                            "boost": 100.0
                        }
                    }
                })

                # 2. Case-insensitive exact match (50x boost)
                should_clauses.append({
                    "term": {
                        "name.keyword": {
                            "value": query.lower(),
                            "boost": 50.0
                        }
                    }
                })

                # 3. Prefix match (starts with query - 20x boost)
                should_clauses.append({
                    "prefix": {
                        "name": {
                            "value": query.lower(),
                            "boost": 20.0
                        }
                    }
                })

                # 4. Phrase match - all words in order (10x boost)
                # This matches "renewalpdf (Copy)" as a phrase, not individual words
                should_clauses.append({
                    "match_phrase": {
                        "name": {
                            "query": query,
                            "boost": 10.0
                        }
                    }
                })

                # 5. Wildcard match (contains full query - 5x boost)
                # Escape Elasticsearch special characters for wildcard queries
                safe_query = query.lower()
                for char in ['\\', '(', ')', '[', ']', '{', '}', '^', '"', '~', '/', ':']:
                    safe_query = safe_query.replace(char, f'\\{char}')
                should_clauses.append({
                    "wildcard": {
                        "name": {
                            "value": f"*{safe_query}*",
                            "boost": 5.0
                        }
                    }
                })

                # 6. Multi-match with AND operator (requires all terms)
                # This ensures "renewalpdf Copy pdf" matches only files with ALL words
                fuzziness_value = "1" if fuzzy else "0"
                search_clause = {
                    "multi_match": {
                        "query": query,
                        "fields": ["name^3", "original_name^2", "description"],
                        "fuzziness": fuzziness_value,
                        "prefix_length": 3,
                        "operator": "and",  # Require ALL terms to match
                        "boost": 1.0
                    }
                }
                must_clauses.append(search_clause)

            # Apply filters
            filter_clauses = []
            if filters:
                if filters.get('mime_type'):
                    filter_clauses.append({"term": {"mime_type": filters['mime_type']}})

                if filters.get('storage_tier'):
                    filter_clauses.append({"term": {"storage_tier": filters['storage_tier']}})

                if filters.get('size_min') or filters.get('size_max'):
                    size_range = {}
                    if filters.get('size_min'):
                        size_range['gte'] = filters['size_min']
                    if filters.get('size_max'):
                        size_range['lte'] = filters['size_max']
                    filter_clauses.append({"range": {"size": size_range}})

                if filters.get('date_from') or filters.get('date_to'):
                    date_range = {}
                    if filters.get('date_from'):
                        date_range['gte'] = filters['date_from']
                    if filters.get('date_to'):
                        date_range['lte'] = filters['date_to']
                    filter_clauses.append({"range": {"created_at": date_range}})

            # Search files - include should clauses for boosting exact matches
            files_query = {
                "bool": {
                    "must": must_clauses,
                    "should": should_clauses,
                    "filter": filter_clauses,
                    "minimum_should_match": 0  # Should clauses are optional boosters
                }
            }

            files_response = await self.client.search(
                index=self.files_index,
                body={
                    "query": files_query,
                    "from": from_,
                    "size": size,
                    "min_score": 1.0,  # Filter out low-relevance results
                    "highlight": {
                        "fields": {
                            "name": {},
                            "description": {}
                        }
                    },
                    "sort": [
                        {"_score": {"order": "desc"}},
                        {"created_at": {"order": "desc"}}
                    ]
                }
            )

            # Search folders
            folders_response = await self.client.search(
                index=self.folders_index,
                body={
                    "query": {
                        "bool": {
                            "must": [
                                {"term": {"user_id": user_id}},
                                {"multi_match": {
                                    "query": query,
                                    "fields": ["name^2", "path"],
                                    "fuzziness": "AUTO" if fuzzy else 0
                                }} if query else {"match_all": {}}
                            ]
                        }
                    },
                    "from": from_,
                    "size": size,
                    "highlight": {
                        "fields": {
                            "name": {}
                        }
                    }
                }
            )

            return {
                "files": {
                    "total": files_response['hits']['total']['value'],
                    "hits": [
                        {
                            **hit['_source'],
                            "highlight": hit.get('highlight', {}),
                            "score": hit['_score']
                        }
                        for hit in files_response['hits']['hits']
                    ]
                },
                "folders": {
                    "total": folders_response['hits']['total']['value'],
                    "hits": [
                        {
                            **hit['_source'],
                            "highlight": hit.get('highlight', {}),
                            "score": hit['_score']
                        }
                        for hit in folders_response['hits']['hits']
                    ]
                }
            }
        except Exception as e:
            logger.error(f"Search failed: {e}")
            raise

    async def autocomplete(self, query: str, user_id: str, size: int = 5) -> List[str]:
        """Get autocomplete suggestions using prefix search"""
        # Check if connected
        if not self.connected or self.client is None:
            logger.debug("Elasticsearch not connected, autocomplete unavailable")
            return []

        try:
            # Use prefix query instead of completion suggester
            response = await self.client.search(
                index=self.files_index,
                body={
                    "query": {
                        "bool": {
                            "must": [
                                {"term": {"user_id": user_id}},
                                {"prefix": {"name": {"value": query}}}
                            ]
                        }
                    },
                    "size": size,
                    "_source": ["name"]
                }
            )

            suggestions = []
            seen = set()
            for hit in response['hits']['hits']:
                name = hit['_source']['name']
                if name not in seen:
                    suggestions.append(name)
                    seen.add(name)

            return suggestions
        except Exception as e:
            logger.error(f"Autocomplete failed: {e}")
            return []

    async def update_file_text(self, file_id: str, ocr_text: str) -> bool:
        """Update file with OCR extracted text for searchability"""
        # Check if connected
        if not self.connected or self.client is None:
            logger.warning(f"Elasticsearch not connected, skipping OCR text update for file: {file_id}")
            return False

        try:
            await self.client.update(
                index=self.files_index,
                id=str(file_id),
                body={
                    "doc": {
                        "ocr_text": ocr_text,
                        "searchable_content": ocr_text
                    }
                }
            )
            logger.debug(f"Updated file text in index: {file_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to update file text in index: {e}")
            return False

    async def update_file_tags(self, file_id: str, tags: list[str]) -> bool:
        """Update file tags in index without overwriting other fields"""
        if not self.connected or self.client is None:
            logger.warning(f"Elasticsearch not connected, skipping tag update for file: {file_id}")
            return False

        try:
            await self.client.update(
                index=self.files_index,
                id=str(file_id),
                body={
                    "doc": {
                        "tags": tags
                    }
                }
            )
            logger.debug(f"Updated file tags in index: {file_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to update file tags in index: {e}")
            return False

    async def delete_file(self, file_id: str) -> bool:
        """Remove file from index"""
        # Check if connected
        if not self.connected or self.client is None:
            logger.warning(f"Elasticsearch not connected, skipping file deletion from index: {file_id}")
            return False

        try:
            await self.client.delete(index=self.files_index, id=str(file_id))
            logger.debug(f"Deleted file from index: {file_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete file from index: {e}")
            return False

    async def delete_folder(self, folder_id: str) -> bool:
        """Remove folder from index"""
        # Check if connected
        if not self.connected or self.client is None:
            logger.warning(f"Elasticsearch not connected, skipping folder deletion from index: {folder_id}")
            return False

        try:
            await self.client.delete(index=self.folders_index, id=str(folder_id))
            logger.debug(f"Deleted folder from index: {folder_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to delete folder from index: {e}")
            return False

# Global search service instance
search_service = SearchService()
