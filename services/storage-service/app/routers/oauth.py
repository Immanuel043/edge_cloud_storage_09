"""OAuth authentication endpoints for social login"""
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse, JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
import logging

from ..dependencies import get_db, get_current_user
from ..services.oauth_service import oauth, oauth_service
from ..services.auth import auth_service
from ..config import settings
from ..models.database import User

router = APIRouter(prefix="/api/v1/auth/oauth", tags=["oauth"])
logger = logging.getLogger(__name__)


@router.get("/providers")
async def get_available_providers():
    """Get list of configured OAuth providers"""
    providers = []

    for provider in ['google', 'github', 'microsoft']:
        if oauth_service.is_provider_configured(provider):
            providers.append({
                'name': provider,
                'display_name': provider.capitalize(),
                'enabled': True
            })

    return {
        "providers": providers,
        "count": len(providers)
    }


@router.get("/{provider}/login")
async def oauth_login(provider: str, request: Request):
    """
    Initiate OAuth login flow

    Args:
        provider: OAuth provider ('google', 'github', 'microsoft')

    Returns:
        Redirect to OAuth provider's authorization page
    """
    if provider not in oauth_service.SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unsupported OAuth provider: {provider}")

    if not oauth_service.is_provider_configured(provider):
        raise HTTPException(
            status_code=400,
            detail=f"{provider.capitalize()} OAuth is not configured. Please contact administrator."
        )

    try:
        oauth_client = getattr(oauth, provider)
        redirect_uri = f"{settings.API_BASE_URL}/api/v1/auth/oauth/{provider}/callback"

        logger.info(f"Initiating {provider} OAuth login with redirect_uri: {redirect_uri}")

        return await oauth_client.authorize_redirect(request, redirect_uri)
    except Exception as e:
        logger.error(f"Error initiating {provider} OAuth: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to initiate {provider} login")


@router.get("/{provider}/callback")
async def oauth_callback(
    provider: str,
    request: Request,
    db: AsyncSession = Depends(get_db)
):
    """
    Handle OAuth callback from provider

    Args:
        provider: OAuth provider
        request: FastAPI request object
        db: Database session

    Returns:
        Redirect to frontend with access token
    """
    try:
        # Get OAuth client
        oauth_client = getattr(oauth, provider)

        # Exchange authorization code for token
        try:
            token = await oauth_client.authorize_access_token(request)
        except Exception as e:
            logger.error(f"Failed to get {provider} access token: {str(e)}")
            # Redirect to frontend with error
            return RedirectResponse(
                url=f"{settings.FRONTEND_URL}/auth/error?message=Authentication failed&provider={provider}"
            )

        # Get user info from OAuth provider
        oauth_profile = await oauth_service.get_oauth_user(provider, token)

        # Add tokens to profile for storage
        oauth_profile['access_token'] = token.get('access_token')
        oauth_profile['refresh_token'] = token.get('refresh_token')

        # Create or update user
        user = await oauth_service.create_or_update_user(db, oauth_profile, provider)

        # Generate JWT tokens
        access_token = auth_service.create_access_token(data={"sub": str(user.id)})
        refresh_token = auth_service.create_refresh_token(data={"sub": str(user.id)})

        logger.info(f"Successfully authenticated user {user.email} via {provider}")

        # Redirect to frontend with tokens
        frontend_url = settings.FRONTEND_URL
        return RedirectResponse(
            url=f"{frontend_url}/auth/callback?access_token={access_token}&refresh_token={refresh_token}&provider={provider}"
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error in {provider} OAuth callback: {str(e)}", exc_info=True)
        return RedirectResponse(
            url=f"{settings.FRONTEND_URL}/auth/error?message=Authentication error&provider={provider}"
        )


@router.post("/{provider}/link")
async def link_oauth_account(
    provider: str,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Link OAuth account to existing authenticated user

    Args:
        provider: OAuth provider
        request: FastAPI request
        current_user: Currently authenticated user
        db: Database session

    Returns:
        Success message
    """
    if provider not in oauth_service.SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unsupported OAuth provider: {provider}")

    if not oauth_service.is_provider_configured(provider):
        raise HTTPException(
            status_code=400,
            detail=f"{provider.capitalize()} OAuth is not configured"
        )

    try:
        # Get OAuth client
        oauth_client = getattr(oauth, provider)

        # Exchange authorization code for token
        token = await oauth_client.authorize_access_token(request)

        # Get user info from OAuth provider
        oauth_profile = await oauth_service.get_oauth_user(provider, token)

        # Add tokens to profile
        oauth_profile['access_token'] = token.get('access_token')
        oauth_profile['refresh_token'] = token.get('refresh_token')

        # Link OAuth account to current user
        await oauth_service.link_oauth_to_existing_user(
            db,
            str(current_user.id),
            oauth_profile,
            provider
        )

        return {
            "message": f"{provider.capitalize()} account linked successfully",
            "provider": provider,
            "email": oauth_profile.get('email')
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error linking {provider} account: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to link {provider} account")


@router.delete("/{provider}/unlink")
async def unlink_oauth_account(
    provider: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Unlink OAuth account from user

    Args:
        provider: OAuth provider
        current_user: Currently authenticated user
        db: Database session

    Returns:
        Success message
    """
    from ..models.database import OAuthAccount
    from sqlalchemy import select, and_

    if provider not in oauth_service.SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unsupported OAuth provider: {provider}")

    # Find OAuth account
    result = await db.execute(
        select(OAuthAccount).filter(
            and_(
                OAuthAccount.user_id == current_user.id,
                OAuthAccount.provider == provider
            )
        )
    )
    oauth_account = result.scalar_one_or_none()

    if not oauth_account:
        raise HTTPException(
            status_code=404,
            detail=f"No {provider} account linked to this user"
        )

    # Check if user has password (can't unlink if it's the only auth method)
    if not current_user.password_hash and len(current_user.oauth_accounts) == 1:
        raise HTTPException(
            status_code=400,
            detail="Cannot unlink last authentication method. Please set a password first."
        )

    # Delete OAuth account
    await db.delete(oauth_account)
    await db.commit()

    logger.info(f"Unlinked {provider} account from user {current_user.email}")

    return {
        "message": f"{provider.capitalize()} account unlinked successfully",
        "provider": provider
    }


@router.get("/linked-accounts")
async def get_linked_accounts(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get list of OAuth accounts linked to current user

    Args:
        current_user: Currently authenticated user
        db: Database session

    Returns:
        List of linked OAuth providers
    """
    await db.refresh(current_user, ['oauth_accounts'])

    linked_accounts = []
    for oauth_account in current_user.oauth_accounts:
        linked_accounts.append({
            'provider': oauth_account.provider,
            'email': oauth_account.profile_data.get('email') if oauth_account.profile_data else None,
            'linked_at': oauth_account.created_at.isoformat() if oauth_account.created_at else None,
            'profile': {
                'name': oauth_account.profile_data.get('name') if oauth_account.profile_data else None,
                'picture': oauth_account.profile_data.get('picture') if oauth_account.profile_data else None,
            }
        })

    return {
        "linked_accounts": linked_accounts,
        "count": len(linked_accounts),
        "has_password": bool(current_user.password_hash)
    }
