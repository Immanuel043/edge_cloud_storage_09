"""
Auto-Organizer Service

Orchestrates file organization using ML clustering and rule-based systems:
- Manages organization sessions
- Applies cluster-based organization
- Applies rule-based organization
- Generates organization suggestions
"""

import logging
from typing import List, Dict, Optional, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_
from uuid import UUID
from datetime import datetime
import re

from ..models.database import (
    User, Object, Folder, OrganizationCluster, FileClusterAssignment,
    OrganizationRule, OrganizationSession
)
from .file_clustering_service import file_clustering_service

logger = logging.getLogger(__name__)


class AutoOrganizerService:
    """
    Orchestrates automatic file organization using ML and rules
    """

    async def create_organization_session(
        self,
        user_id: UUID,
        algorithm: str,
        num_clusters: Optional[int],
        min_files: int,
        preview_only: bool,
        db: AsyncSession
    ) -> OrganizationSession:
        """
        Create a new organization session

        Args:
            user_id: User ID
            algorithm: 'kmeans' or 'dbscan'
            num_clusters: Number of clusters (for k-means)
            min_files: Minimum files required
            preview_only: If True, don't move files

        Returns:
            OrganizationSession object
        """
        session = OrganizationSession(
            user_id=user_id,
            session_type='ml_clustering',
            algorithm=algorithm,
            num_clusters=num_clusters,
            min_files=min_files,
            status='pending'
        )

        db.add(session)
        await db.flush()

        logger.info(f"Created organization session {session.id} for user {user_id}")
        return session

    async def run_ml_organization(
        self,
        session: OrganizationSession,
        db: AsyncSession
    ) -> Tuple[List[OrganizationCluster], List[FileClusterAssignment]]:
        """
        Run ML-based clustering organization

        Returns:
            Tuple of (clusters, file_assignments)
        """
        try:
            session.status = 'running'
            session.started_at = datetime.utcnow()
            await db.flush()

            # Get user's files
            result = await db.execute(
                select(Object).where(Object.user_id == session.user_id)
            )
            files = result.scalars().all()

            if len(files) < session.min_files:
                raise ValueError(f"Insufficient files: {len(files)} < {session.min_files}")

            session.files_analyzed = len(files)

            logger.info(f"Running {session.algorithm} clustering on {len(files)} files")

            # Run clustering
            if session.algorithm == 'kmeans':
                clustering_result = file_clustering_service.cluster_kmeans(
                    files,
                    n_clusters=session.num_clusters
                )
            elif session.algorithm == 'dbscan':
                clustering_result = file_clustering_service.cluster_dbscan(files)
            else:
                raise ValueError(f"Unknown algorithm: {session.algorithm}")

            # Save clusters to database
            clusters = []
            file_assignments = []

            for cluster_data in clustering_result['clusters']:
                # Create cluster object
                cluster = OrganizationCluster(
                    user_id=session.user_id,
                    cluster_id=cluster_data['cluster_id'],
                    cluster_name=cluster_data['cluster_name'],
                    cluster_description=cluster_data['cluster_description'],
                    algorithm=session.algorithm,
                    num_files=cluster_data['num_files'],
                    total_size=cluster_data['total_size'],
                    top_keywords=cluster_data['top_keywords'],
                    common_extensions=cluster_data['common_extensions'],
                    date_range_start=cluster_data['date_range_start'],
                    date_range_end=cluster_data['date_range_end'],
                    silhouette_score=clustering_result['silhouette_score'],
                    cohesion_score=cluster_data['cohesion_score'],
                    suggested_folder_path=cluster_data['suggested_folder_path']
                )

                db.add(cluster)
                await db.flush()  # Get cluster ID

                clusters.append(cluster)

                # Create file assignments
                for file_id in cluster_data['file_ids']:
                    assignment = FileClusterAssignment(
                        file_id=UUID(file_id),
                        cluster_id=cluster.id,
                        user_id=session.user_id,
                        confidence_score=1.0  # Default confidence
                    )
                    db.add(assignment)
                    file_assignments.append(assignment)

            # Update session results
            session.clusters_created = len(clusters)
            session.avg_silhouette_score = clustering_result['silhouette_score']
            session.status = 'completed'
            session.completed_at = datetime.utcnow()

            await db.flush()

            logger.info(
                f"Organization session {session.id} completed: "
                f"{len(clusters)} clusters created"
            )

            return clusters, file_assignments

        except Exception as e:
            session.status = 'failed'
            session.error_message = str(e)
            session.completed_at = datetime.utcnow()
            await db.flush()

            logger.error(f"Organization session {session.id} failed: {e}", exc_info=True)
            raise

    async def apply_cluster_organization(
        self,
        cluster_id: UUID,
        target_folder_path: Optional[str],
        user_id: UUID,
        db: AsyncSession
    ) -> Dict:
        """
        Apply cluster organization by moving files to target folder

        Args:
            cluster_id: Cluster to apply
            target_folder_path: Target folder (or use suggested)
            user_id: User ID
            db: Database session

        Returns:
            Dictionary with results
        """
        try:
            # Get cluster
            result = await db.execute(
                select(OrganizationCluster).where(
                    OrganizationCluster.id == cluster_id,
                    OrganizationCluster.user_id == user_id
                )
            )
            cluster = result.scalar_one_or_none()

            if not cluster:
                raise ValueError(f"Cluster {cluster_id} not found")

            if cluster.is_applied:
                raise ValueError("Cluster already applied")

            # Use suggested path if not provided
            folder_path = target_folder_path or cluster.suggested_folder_path

            # Get or create target folder
            target_folder = await self._get_or_create_folder(
                folder_path,
                user_id,
                db
            )

            # Get file assignments
            assignments_result = await db.execute(
                select(FileClusterAssignment).where(
                    FileClusterAssignment.cluster_id == cluster_id
                )
            )
            assignments = assignments_result.scalars().all()

            # Move files to target folder
            files_moved = 0
            for assignment in assignments:
                # Get file
                file_result = await db.execute(
                    select(Object).where(Object.id == assignment.file_id)
                )
                file_obj = file_result.scalar_one_or_none()

                if file_obj:
                    file_obj.folder_id = target_folder.id
                    files_moved += 1

            # Mark cluster as applied
            cluster.is_applied = True
            cluster.applied_at = datetime.utcnow()

            await db.flush()

            logger.info(
                f"Applied cluster {cluster_id}: moved {files_moved} files "
                f"to {folder_path}"
            )

            return {
                'cluster_id': str(cluster_id),
                'folder_path': folder_path,
                'files_moved': files_moved,
                'status': 'success'
            }

        except Exception as e:
            logger.error(f"Failed to apply cluster {cluster_id}: {e}", exc_info=True)
            raise

    async def create_rule(
        self,
        user_id: UUID,
        rule_name: str,
        rule_type: str,
        target_folder_path: str,
        pattern: Optional[str],
        file_extensions: Optional[List[str]],
        keywords: Optional[List[str]],
        date_field: Optional[str],
        date_range_days: Optional[int],
        create_subfolder_by_date: bool,
        auto_apply: bool,
        priority: int,
        db: AsyncSession
    ) -> OrganizationRule:
        """
        Create organization rule

        Returns:
            OrganizationRule object
        """
        rule = OrganizationRule(
            user_id=user_id,
            rule_name=rule_name,
            rule_type=rule_type,
            pattern=pattern,
            file_extensions=file_extensions,
            keywords=keywords,
            date_field=date_field,
            date_range_days=date_range_days,
            target_folder_path=target_folder_path,
            create_subfolder_by_date=create_subfolder_by_date,
            auto_apply=auto_apply,
            priority=priority,
            source='user'
        )

        db.add(rule)
        await db.flush()

        logger.info(f"Created organization rule {rule.id} for user {user_id}")
        return rule

    async def apply_rules(
        self,
        user_id: UUID,
        db: AsyncSession,
        rule_ids: Optional[List[UUID]] = None
    ) -> Dict:
        """
        Apply organization rules to files

        Args:
            user_id: User ID
            db: Database session
            rule_ids: Specific rules to apply (or all active if None)

        Returns:
            Dictionary with results
        """
        try:
            # Get rules
            query = select(OrganizationRule).where(
                OrganizationRule.user_id == user_id,
                OrganizationRule.is_active == True
            )

            if rule_ids:
                query = query.where(OrganizationRule.id.in_(rule_ids))

            # Order by priority (higher first)
            query = query.order_by(OrganizationRule.priority.desc())

            result = await db.execute(query)
            rules = result.scalars().all()

            # Get user's files
            files_result = await db.execute(
                select(Object).where(Object.user_id == user_id)
            )
            files = files_result.scalars().all()

            total_organized = 0

            for rule in rules:
                # Match files against rule
                matched_files = self._match_files_to_rule(files, rule)

                if not matched_files:
                    continue

                # Get or create target folder
                for file_obj in matched_files:
                    target_path = self._get_target_path_for_file(
                        rule.target_folder_path,
                        file_obj,
                        rule.create_subfolder_by_date
                    )

                    target_folder = await self._get_or_create_folder(
                        target_path,
                        user_id,
                        db
                    )

                    # Move file
                    file_obj.folder_id = target_folder.id
                    total_organized += 1

                # Update rule statistics
                rule.files_organized += len(matched_files)
                rule.last_applied_at = datetime.utcnow()

            await db.flush()

            logger.info(
                f"Applied {len(rules)} rules: organized {total_organized} files "
                f"for user {user_id}"
            )

            return {
                'rules_applied': len(rules),
                'files_organized': total_organized,
                'status': 'success'
            }

        except Exception as e:
            logger.error(f"Failed to apply rules for user {user_id}: {e}", exc_info=True)
            raise

    def _match_files_to_rule(
        self,
        files: List[Object],
        rule: OrganizationRule
    ) -> List[Object]:
        """
        Match files against organization rule

        Returns list of matching files
        """
        matched = []

        for file_obj in files:
            if self._file_matches_rule(file_obj, rule):
                matched.append(file_obj)

        return matched

    def _file_matches_rule(self, file_obj: Object, rule: OrganizationRule) -> bool:
        """Check if file matches rule criteria"""
        # Pattern matching
        if rule.pattern:
            if not self._matches_pattern(file_obj.file_name, rule.pattern):
                return False

        # Extension matching
        if rule.file_extensions:
            file_ext = file_obj.file_name.rsplit('.', 1)[-1].lower() if '.' in file_obj.file_name else ''
            if file_ext not in rule.file_extensions:
                return False

        # Keyword matching
        if rule.keywords:
            filename_lower = file_obj.file_name.lower()
            if not any(keyword.lower() in filename_lower for keyword in rule.keywords):
                return False

        # Date matching
        if rule.date_range_days:
            from datetime import timedelta
            cutoff_date = datetime.utcnow() - timedelta(days=rule.date_range_days)

            if rule.date_field == 'created_at':
                if not file_obj.created_at or file_obj.created_at < cutoff_date:
                    return False
            elif rule.date_field == 'modified_at':
                if not file_obj.updated_at or file_obj.updated_at < cutoff_date:
                    return False

        return True

    def _matches_pattern(self, filename: str, pattern: str) -> bool:
        """Check if filename matches wildcard pattern"""
        # Convert wildcard pattern to regex
        regex_pattern = pattern.replace('*', '.*').replace('?', '.')
        return re.match(regex_pattern, filename, re.IGNORECASE) is not None

    def _get_target_path_for_file(
        self,
        base_path: str,
        file_obj: Object,
        create_subfolder_by_date: bool
    ) -> str:
        """
        Get target folder path for file

        Optionally creates date-based subfolders (YYYY/MM)
        """
        if not create_subfolder_by_date:
            return base_path

        # Use file creation date
        file_date = file_obj.created_at or datetime.utcnow()
        year = file_date.year
        month = f"{file_date.month:02d}"

        return f"{base_path}/{year}/{month}"

    async def _get_or_create_folder(
        self,
        folder_path: str,
        user_id: UUID,
        db: AsyncSession
    ) -> Folder:
        """
        Get existing folder or create new one

        Handles nested paths like /Work/Reports/2024
        """
        # Normalize path
        folder_path = folder_path.strip('/')

        # Check if folder exists
        result = await db.execute(
            select(Folder).where(
                Folder.user_id == user_id,
                Folder.path == folder_path
            )
        )
        existing_folder = result.scalar_one_or_none()

        if existing_folder:
            return existing_folder

        # Create folder (and parent folders if needed)
        parts = folder_path.split('/')
        current_path = ''
        parent_id = None

        for part in parts:
            current_path = f"{current_path}/{part}" if current_path else part

            # Check if this level exists
            level_result = await db.execute(
                select(Folder).where(
                    Folder.user_id == user_id,
                    Folder.path == current_path
                )
            )
            level_folder = level_result.scalar_one_or_none()

            if not level_folder:
                # Create this level
                level_folder = Folder(
                    user_id=user_id,
                    folder_name=part,
                    path=current_path,
                    parent_id=parent_id
                )
                db.add(level_folder)
                await db.flush()

            parent_id = level_folder.id

        # Return the final folder
        return level_folder


# Singleton instance
auto_organizer = AutoOrganizerService()
