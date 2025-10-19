"""
Auto-Organization Router

API endpoints for ML-based file organization:
- Start ML clustering organization
- View organization clusters
- Apply cluster organization
- Manage organization rules
- Get organization preview
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from typing import List, Optional
from datetime import datetime
import logging

from ..dependencies import get_db, get_current_user
from ..models.database import (
    User, OrganizationCluster, OrganizationRule, OrganizationSession
)
from ..models.schemas import (
    OrganizationClusterResponse,
    OrganizationRuleResponse,
    OrganizationSessionResponse,
    StartOrganizationRequest,
    ApplyClusterRequest,
    CreateRuleRequest,
    UpdateRuleRequest,
    OrganizationPreview
)
from ..services.auto_organizer import auto_organizer
from ..monitoring.metrics import metrics_collector

router = APIRouter(prefix="/api/v1/organization", tags=["auto-organization"])
logger = logging.getLogger(__name__)


@router.post("/start", response_model=OrganizationSessionResponse)
async def start_organization(
    request: StartOrganizationRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Start ML-based file organization

    Runs clustering algorithm to group similar files together.

    Args:
        request: Organization parameters

    Returns:
        OrganizationSessionResponse with session details
    """
    try:
        logger.info(f"Starting organization for user {current_user.id} with {request.algorithm}")

        # Create session
        session = await auto_organizer.create_organization_session(
            user_id=current_user.id,
            algorithm=request.algorithm,
            num_clusters=request.num_clusters,
            min_files=request.min_files,
            preview_only=request.preview_only,
            db=db
        )

        # Run clustering
        clusters, assignments = await auto_organizer.run_ml_organization(session, db)

        await db.commit()

        # Update metrics
        metrics_collector.increment_counter('organization_sessions_started_total')
        metrics_collector.increment_counter('organization_clusters_created_total', len(clusters))

        logger.info(f"Organization session {session.id} completed: {len(clusters)} clusters")

        return OrganizationSessionResponse(
            id=str(session.id),
            user_id=str(session.user_id),
            session_type=session.session_type,
            algorithm=session.algorithm,
            num_clusters=session.num_clusters,
            min_files=session.min_files,
            files_analyzed=session.files_analyzed,
            files_organized=session.files_organized,
            clusters_created=session.clusters_created,
            folders_created=session.folders_created,
            avg_silhouette_score=session.avg_silhouette_score,
            status=session.status,
            error_message=session.error_message,
            created_at=session.created_at,
            started_at=session.started_at,
            completed_at=session.completed_at
        )

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to start organization: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Organization failed: {str(e)}")


@router.get("/clusters", response_model=List[OrganizationClusterResponse])
async def get_clusters(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    include_applied: bool = Query(False, description="Include applied clusters"),
    algorithm: Optional[str] = Query(None, description="Filter by algorithm")
):
    """
    Get organization clusters for current user

    Returns list of ML-generated file clusters.

    Args:
        include_applied: Include already-applied clusters
        algorithm: Filter by algorithm (kmeans, dbscan)

    Returns:
        List of OrganizationClusterResponse
    """
    try:
        query = select(OrganizationCluster).where(
            OrganizationCluster.user_id == current_user.id,
            OrganizationCluster.is_dismissed == False
        )

        if not include_applied:
            query = query.where(OrganizationCluster.is_applied == False)

        if algorithm:
            query = query.where(OrganizationCluster.algorithm == algorithm)

        query = query.order_by(desc(OrganizationCluster.created_at))

        result = await db.execute(query)
        clusters = result.scalars().all()

        response = [
            OrganizationClusterResponse(
                id=str(c.id),
                user_id=str(c.user_id),
                cluster_id=c.cluster_id,
                cluster_name=c.cluster_name,
                cluster_description=c.cluster_description,
                algorithm=c.algorithm,
                num_files=c.num_files,
                total_size=c.total_size,
                top_keywords=c.top_keywords or [],
                common_extensions=c.common_extensions or [],
                date_range_start=c.date_range_start,
                date_range_end=c.date_range_end,
                silhouette_score=c.silhouette_score,
                cohesion_score=c.cohesion_score,
                suggested_folder_path=c.suggested_folder_path,
                is_applied=c.is_applied,
                is_dismissed=c.is_dismissed,
                created_at=c.created_at
            )
            for c in clusters
        ]

        logger.info(f"Retrieved {len(response)} clusters for user {current_user.id}")
        return response

    except Exception as e:
        logger.error(f"Failed to get clusters: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to retrieve clusters: {str(e)}")


@router.post("/clusters/{cluster_id}/apply")
async def apply_cluster(
    cluster_id: str,
    request: ApplyClusterRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Apply cluster organization

    Moves files in cluster to suggested folder.

    Args:
        cluster_id: Cluster ID to apply
        request: Apply parameters (optional custom path)

    Returns:
        Result of organization
    """
    try:
        from uuid import UUID

        logger.info(f"Applying cluster {cluster_id} for user {current_user.id}")

        result = await auto_organizer.apply_cluster_organization(
            cluster_id=UUID(cluster_id),
            target_folder_path=request.target_folder_path,
            user_id=current_user.id,
            db=db
        )

        await db.commit()

        # Update metrics
        metrics_collector.increment_counter('organization_clusters_applied_total')
        metrics_collector.increment_counter('organization_files_moved_total', result['files_moved'])

        logger.info(f"Applied cluster {cluster_id}: {result['files_moved']} files moved")

        return result

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to apply cluster: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to apply cluster: {str(e)}")


@router.post("/clusters/{cluster_id}/dismiss")
async def dismiss_cluster(
    cluster_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Dismiss a cluster suggestion

    Marks cluster as dismissed.

    Args:
        cluster_id: Cluster ID to dismiss

    Returns:
        Success message
    """
    try:
        from uuid import UUID

        result = await db.execute(
            select(OrganizationCluster).where(
                OrganizationCluster.id == UUID(cluster_id),
                OrganizationCluster.user_id == current_user.id
            )
        )
        cluster = result.scalar_one_or_none()

        if not cluster:
            raise HTTPException(status_code=404, detail="Cluster not found")

        cluster.is_dismissed = True
        cluster.dismissed_at = datetime.utcnow()

        await db.commit()

        logger.info(f"Dismissed cluster {cluster_id} for user {current_user.id}")
        metrics_collector.increment_counter('organization_clusters_dismissed_total')

        return {"status": "success", "message": "Cluster dismissed"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to dismiss cluster: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to dismiss cluster: {str(e)}")


# Organization Rules

@router.get("/rules", response_model=List[OrganizationRuleResponse])
async def get_rules(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    include_inactive: bool = Query(False, description="Include inactive rules")
):
    """
    Get organization rules for current user

    Returns:
        List of OrganizationRuleResponse
    """
    try:
        query = select(OrganizationRule).where(
            OrganizationRule.user_id == current_user.id
        )

        if not include_inactive:
            query = query.where(OrganizationRule.is_active == True)

        query = query.order_by(OrganizationRule.priority.desc())

        result = await db.execute(query)
        rules = result.scalars().all()

        response = [
            OrganizationRuleResponse(
                id=str(r.id),
                user_id=str(r.user_id),
                rule_name=r.rule_name,
                rule_type=r.rule_type,
                pattern=r.pattern,
                file_extensions=r.file_extensions,
                keywords=r.keywords,
                date_field=r.date_field,
                date_range_days=r.date_range_days,
                target_folder_path=r.target_folder_path,
                create_subfolder_by_date=r.create_subfolder_by_date,
                is_active=r.is_active,
                auto_apply=r.auto_apply,
                priority=r.priority,
                files_organized=r.files_organized,
                last_applied_at=r.last_applied_at,
                source=r.source,
                created_at=r.created_at
            )
            for r in rules
        ]

        logger.info(f"Retrieved {len(response)} rules for user {current_user.id}")
        return response

    except Exception as e:
        logger.error(f"Failed to get rules: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to retrieve rules: {str(e)}")


@router.post("/rules", response_model=OrganizationRuleResponse)
async def create_rule(
    request: CreateRuleRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Create organization rule

    Args:
        request: Rule parameters

    Returns:
        OrganizationRuleResponse
    """
    try:
        logger.info(f"Creating rule '{request.rule_name}' for user {current_user.id}")

        rule = await auto_organizer.create_rule(
            user_id=current_user.id,
            rule_name=request.rule_name,
            rule_type=request.rule_type,
            target_folder_path=request.target_folder_path,
            pattern=request.pattern,
            file_extensions=request.file_extensions,
            keywords=request.keywords,
            date_field=request.date_field,
            date_range_days=request.date_range_days,
            create_subfolder_by_date=request.create_subfolder_by_date,
            auto_apply=request.auto_apply,
            priority=request.priority,
            db=db
        )

        await db.commit()

        # Update metrics
        metrics_collector.increment_counter('organization_rules_created_total')

        return OrganizationRuleResponse(
            id=str(rule.id),
            user_id=str(rule.user_id),
            rule_name=rule.rule_name,
            rule_type=rule.rule_type,
            pattern=rule.pattern,
            file_extensions=rule.file_extensions,
            keywords=rule.keywords,
            date_field=rule.date_field,
            date_range_days=rule.date_range_days,
            target_folder_path=rule.target_folder_path,
            create_subfolder_by_date=rule.create_subfolder_by_date,
            is_active=rule.is_active,
            auto_apply=rule.auto_apply,
            priority=rule.priority,
            files_organized=rule.files_organized,
            last_applied_at=rule.last_applied_at,
            source=rule.source,
            created_at=rule.created_at
        )

    except Exception as e:
        logger.error(f"Failed to create rule: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create rule: {str(e)}")


@router.put("/rules/{rule_id}", response_model=OrganizationRuleResponse)
async def update_rule(
    rule_id: str,
    request: UpdateRuleRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Update organization rule

    Args:
        rule_id: Rule ID
        request: Update parameters

    Returns:
        Updated OrganizationRuleResponse
    """
    try:
        from uuid import UUID

        result = await db.execute(
            select(OrganizationRule).where(
                OrganizationRule.id == UUID(rule_id),
                OrganizationRule.user_id == current_user.id
            )
        )
        rule = result.scalar_one_or_none()

        if not rule:
            raise HTTPException(status_code=404, detail="Rule not found")

        # Update fields
        if request.is_active is not None:
            rule.is_active = request.is_active
        if request.auto_apply is not None:
            rule.auto_apply = request.auto_apply
        if request.priority is not None:
            rule.priority = request.priority
        if request.target_folder_path is not None:
            rule.target_folder_path = request.target_folder_path

        await db.commit()

        logger.info(f"Updated rule {rule_id} for user {current_user.id}")
        metrics_collector.increment_counter('organization_rules_updated_total')

        return OrganizationRuleResponse(
            id=str(rule.id),
            user_id=str(rule.user_id),
            rule_name=rule.rule_name,
            rule_type=rule.rule_type,
            pattern=rule.pattern,
            file_extensions=rule.file_extensions,
            keywords=rule.keywords,
            date_field=rule.date_field,
            date_range_days=rule.date_range_days,
            target_folder_path=rule.target_folder_path,
            create_subfolder_by_date=rule.create_subfolder_by_date,
            is_active=rule.is_active,
            auto_apply=rule.auto_apply,
            priority=rule.priority,
            files_organized=rule.files_organized,
            last_applied_at=rule.last_applied_at,
            source=rule.source,
            created_at=rule.created_at
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update rule: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to update rule: {str(e)}")


@router.post("/rules/apply")
async def apply_rules(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Apply all active organization rules

    Organizes files based on user-defined rules.

    Returns:
        Result of rule application
    """
    try:
        logger.info(f"Applying rules for user {current_user.id}")

        result = await auto_organizer.apply_rules(
            user_id=current_user.id,
            db=db
        )

        await db.commit()

        # Update metrics
        metrics_collector.increment_counter('organization_rules_applied_total', result['rules_applied'])
        metrics_collector.increment_counter('organization_files_moved_total', result['files_organized'])

        logger.info(
            f"Applied {result['rules_applied']} rules: "
            f"{result['files_organized']} files organized"
        )

        return result

    except Exception as e:
        logger.error(f"Failed to apply rules: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to apply rules: {str(e)}")


@router.delete("/rules/{rule_id}")
async def delete_rule(
    rule_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Delete organization rule

    Args:
        rule_id: Rule ID to delete

    Returns:
        Success message
    """
    try:
        from uuid import UUID

        result = await db.execute(
            select(OrganizationRule).where(
                OrganizationRule.id == UUID(rule_id),
                OrganizationRule.user_id == current_user.id
            )
        )
        rule = result.scalar_one_or_none()

        if not rule:
            raise HTTPException(status_code=404, detail="Rule not found")

        await db.delete(rule)
        await db.commit()

        logger.info(f"Deleted rule {rule_id} for user {current_user.id}")
        metrics_collector.increment_counter('organization_rules_deleted_total')

        return {"status": "success", "message": "Rule deleted"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete rule: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete rule: {str(e)}")
