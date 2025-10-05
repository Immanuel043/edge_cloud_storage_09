"""
Elasticsearch Search Service for Full-Text Search
"""
import logging
from typing import List, Dict, Any, Optional
from datetime import datetime
from elasticsearch import AsyncElasticsearch
from elasticsearch.helpers import async_bulk
import os

logger = logging.getLogger(__name__)

class SearchService:
    def __init__(self):
        self.es_url = os.getenv('ELASTICSEARCH_URL', 'http://localhost:9200')
        self.client: Optional[AsyncElasticsearch] = None
        self.files_index = 'files'
        self.folders_index = 'folders'

    async def connect(self):
        """Initialize Elasticsearch connection"""
        try:
            self.client = AsyncElasticsearch([self.es_url])
            await self.create_indices()
            logger.info(f"Connected to Elasticsearch at {self.es_url}")
        except Exception as e:
            logger.error(f"Failed to connect to Elasticsearch: {e}")
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

    async def index_file(self, file_data: Dict[str, Any]):
        """Index a file document"""
        try:
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
                "created_at": file_data.get('created_at', datetime.utcnow()).isoformat(),
                "updated_at": file_data.get('updated_at', datetime.utcnow()).isoformat(),
                "tags": file_data.get('tags', []),
                "description": file_data.get('description', '')
            }

            await self.client.index(
                index=self.files_index,
                id=str(file_data['id']),
                document=doc
            )
            logger.debug(f"Indexed file: {file_data['name']}")
        except Exception as e:
            logger.error(f"Failed to index file: {e}")

    async def index_folder(self, folder_data: Dict[str, Any]):
        """Index a folder document"""
        try:
            doc = {
                "id": str(folder_data['id']),
                "name": folder_data['name'],
                "parent_id": str(folder_data['parent_id']) if folder_data.get('parent_id') else None,
                "user_id": str(folder_data['user_id']),
                "created_at": folder_data.get('created_at', datetime.utcnow()).isoformat(),
                "updated_at": folder_data.get('updated_at', datetime.utcnow()).isoformat(),
                "path": folder_data.get('path', '')
            }

            await self.client.index(
                index=self.folders_index,
                id=str(folder_data['id']),
                document=doc
            )
            logger.debug(f"Indexed folder: {folder_data['name']}")
        except Exception as e:
            logger.error(f"Failed to index folder: {e}")

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
        try:
            # Build search query
            must_clauses = [
                {"term": {"user_id": user_id}}
            ]

            if query:
                search_clause = {
                    "multi_match": {
                        "query": query,
                        "fields": ["name^3", "original_name^2", "description"],
                        "fuzziness": "AUTO" if fuzzy else 0,
                        "prefix_length": 2
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

            # Search files
            files_query = {
                "bool": {
                    "must": must_clauses,
                    "filter": filter_clauses
                }
            }

            files_response = await self.client.search(
                index=self.files_index,
                body={
                    "query": files_query,
                    "from": from_,
                    "size": size,
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

    async def update_file_text(self, file_id: str, ocr_text: str):
        """Update file with OCR extracted text for searchability"""
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
        except Exception as e:
            logger.error(f"Failed to update file text in index: {e}")

    async def delete_file(self, file_id: str):
        """Remove file from index"""
        try:
            await self.client.delete(index=self.files_index, id=str(file_id))
            logger.debug(f"Deleted file from index: {file_id}")
        except Exception as e:
            logger.error(f"Failed to delete file from index: {e}")

    async def delete_folder(self, folder_id: str):
        """Remove folder from index"""
        try:
            await self.client.delete(index=self.folders_index, id=str(folder_id))
            logger.debug(f"Deleted folder from index: {folder_id}")
        except Exception as e:
            logger.error(f"Failed to delete folder from index: {e}")

# Global search service instance
search_service = SearchService()
