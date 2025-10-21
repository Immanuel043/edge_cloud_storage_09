"""OAuth2 authentication service for social login"""
from authlib.integrations.starlette_client import OAuth
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Dict, Optional
from datetime import datetime
import logging

from ..config import settings

logger = logging.getLogger(__name__)

# Initialize OAuth
oauth = OAuth()

# Register Google OAuth
if settings.GOOGLE_CLIENT_ID and settings.GOOGLE_CLIENT_SECRET:
    oauth.register(
        name='google',
        client_id=settings.GOOGLE_CLIENT_ID,
        client_secret=settings.GOOGLE_CLIENT_SECRET,
        server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
        client_kwargs={
            'scope': 'openid email profile'
        }
    )
    logger.info("Google OAuth provider registered")

# Register GitHub OAuth
if settings.GITHUB_CLIENT_ID and settings.GITHUB_CLIENT_SECRET:
    oauth.register(
        name='github',
        client_id=settings.GITHUB_CLIENT_ID,
        client_secret=settings.GITHUB_CLIENT_SECRET,
        access_token_url='https://github.com/login/oauth/access_token',
        access_token_params=None,
        authorize_url='https://github.com/login/oauth/authorize',
        authorize_params=None,
        api_base_url='https://api.github.com/',
        client_kwargs={'scope': 'user:email'},
    )
    logger.info("GitHub OAuth provider registered")

# Register Microsoft OAuth
if settings.MICROSOFT_CLIENT_ID and settings.MICROSOFT_CLIENT_SECRET:
    oauth.register(
        name='microsoft',
        client_id=settings.MICROSOFT_CLIENT_ID,
        client_secret=settings.MICROSOFT_CLIENT_SECRET,
        server_metadata_url='https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
        client_kwargs={'scope': 'openid email profile'}
    )
    logger.info("Microsoft OAuth provider registered")


class OAuthService:
    """OAuth authentication service"""

    SUPPORTED_PROVIDERS = ['google', 'github', 'microsoft']

    @staticmethod
    def is_provider_configured(provider: str) -> bool:
        """Check if OAuth provider is configured"""
        if provider == 'google':
            return bool(settings.GOOGLE_CLIENT_ID and settings.GOOGLE_CLIENT_SECRET)
        elif provider == 'github':
            return bool(settings.GITHUB_CLIENT_ID and settings.GITHUB_CLIENT_SECRET)
        elif provider == 'microsoft':
            return bool(settings.MICROSOFT_CLIENT_ID and settings.MICROSOFT_CLIENT_SECRET)
        return False

    @staticmethod
    async def get_oauth_user(provider: str, token: dict) -> Dict:
        """
        Get user info from OAuth provider

        Args:
            provider: OAuth provider name ('google', 'github', 'microsoft')
            token: OAuth token response

        Returns:
            Dict with user profile (sub, name, email, picture)
        """
        try:
            if provider == 'google':
                # Google provides user info in the token
                user_info = token.get('userinfo')
                if not user_info:
                    raise HTTPException(status_code=400, detail="Failed to get user info from Google")

                return {
                    'sub': user_info.get('sub'),
                    'name': user_info.get('name'),
                    'email': user_info.get('email'),
                    'picture': user_info.get('picture'),
                    'email_verified': user_info.get('email_verified', False)
                }

            elif provider == 'github':
                # GitHub requires separate API calls for user info
                access_token = token.get('access_token')

                # Get user profile
                import httpx
                async with httpx.AsyncClient() as client:
                    # Get user info
                    user_resp = await client.get(
                        'https://api.github.com/user',
                        headers={'Authorization': f'token {access_token}'}
                    )
                    user_resp.raise_for_status()
                    profile = user_resp.json()

                    # Get email (GitHub doesn't always provide in profile)
                    email = profile.get('email')
                    if not email:
                        emails_resp = await client.get(
                            'https://api.github.com/user/emails',
                            headers={'Authorization': f'token {access_token}'}
                        )
                        emails_resp.raise_for_status()
                        emails = emails_resp.json()
                        # Get primary verified email
                        primary_email = next(
                            (e['email'] for e in emails if e.get('primary') and e.get('verified')),
                            None
                        )
                        email = primary_email or (emails[0]['email'] if emails else None)

                    return {
                        'sub': str(profile['id']),
                        'name': profile.get('name') or profile.get('login'),
                        'email': email,
                        'picture': profile.get('avatar_url'),
                        'email_verified': True  # GitHub requires verified email for API access
                    }

            elif provider == 'microsoft':
                # Microsoft provides user info in the token
                user_info = token.get('userinfo')
                if not user_info:
                    raise HTTPException(status_code=400, detail="Failed to get user info from Microsoft")

                return {
                    'sub': user_info.get('sub') or user_info.get('oid'),
                    'name': user_info.get('name'),
                    'email': user_info.get('email') or user_info.get('preferred_username'),
                    'picture': None,  # Microsoft doesn't provide picture in standard claims
                    'email_verified': True  # Microsoft emails are verified
                }

            else:
                raise HTTPException(status_code=400, detail=f"Unsupported OAuth provider: {provider}")

        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"Error getting OAuth user info from {provider}: {str(e)}")
            raise HTTPException(status_code=500, detail=f"Failed to get user info from {provider}")

    @staticmethod
    async def create_or_update_user(
        db: AsyncSession,
        oauth_profile: Dict,
        provider: str
    ):
        """
        Create or update user from OAuth profile

        Args:
            db: Database session
            oauth_profile: User profile from OAuth provider
            provider: OAuth provider name

        Returns:
            User object
        """
        from ..models.database import User, OAuthAccount

        email = oauth_profile.get('email')
        oauth_sub = oauth_profile.get('sub')

        if not email:
            raise HTTPException(status_code=400, detail="Email is required from OAuth provider")

        # Check if OAuth account exists
        result = await db.execute(
            select(OAuthAccount).filter(
                OAuthAccount.provider == provider,
                OAuthAccount.provider_user_id == oauth_sub
            )
        )
        oauth_account = result.scalar_one_or_none()

        if oauth_account:
            # Existing OAuth account, return associated user
            await db.refresh(oauth_account, ['user'])
            return oauth_account.user

        # Check if user with email exists
        result = await db.execute(
            select(User).filter(User.email == email)
        )
        user = result.scalar_one_or_none()

        if not user:
            # Create new user
            user = User(
                email=email,
                username=email.split('@')[0],  # Use email prefix as username
                full_name=oauth_profile.get('name'),
                is_active=True,
                is_verified=oauth_profile.get('email_verified', True),
                storage_quota=10 * 1024**3,  # 10 GB default
                storage_used=0,
                password_hash='',  # OAuth users don't have password
            )
            db.add(user)
            await db.flush()
            logger.info(f"Created new user from {provider} OAuth: {email}")

        # Link OAuth account to user
        oauth_account = OAuthAccount(
            user_id=user.id,
            provider=provider,
            provider_user_id=oauth_sub,
            access_token=oauth_profile.get('access_token'),
            refresh_token=oauth_profile.get('refresh_token'),
            profile_data={
                'name': oauth_profile.get('name'),
                'email': oauth_profile.get('email'),
                'picture': oauth_profile.get('picture'),
            }
        )
        db.add(oauth_account)
        await db.commit()
        await db.refresh(user)

        logger.info(f"Linked {provider} OAuth account to user: {email}")
        return user

    @staticmethod
    async def link_oauth_to_existing_user(
        db: AsyncSession,
        user_id: str,
        oauth_profile: Dict,
        provider: str
    ):
        """
        Link OAuth account to existing user

        Args:
            db: Database session
            user_id: Existing user ID
            oauth_profile: User profile from OAuth provider
            provider: OAuth provider name
        """
        from ..models.database import OAuthAccount

        oauth_sub = oauth_profile.get('sub')

        # Check if OAuth account already linked
        result = await db.execute(
            select(OAuthAccount).filter(
                OAuthAccount.provider == provider,
                OAuthAccount.provider_user_id == oauth_sub
            )
        )
        existing_account = result.scalar_one_or_none()

        if existing_account:
            if str(existing_account.user_id) == str(user_id):
                # Already linked to this user
                return
            else:
                raise HTTPException(
                    status_code=400,
                    detail=f"{provider.capitalize()} account already linked to another user"
                )

        # Create OAuth link
        oauth_account = OAuthAccount(
            user_id=user_id,
            provider=provider,
            provider_user_id=oauth_sub,
            access_token=oauth_profile.get('access_token'),
            refresh_token=oauth_profile.get('refresh_token'),
            profile_data={
                'name': oauth_profile.get('name'),
                'email': oauth_profile.get('email'),
                'picture': oauth_profile.get('picture'),
            }
        )
        db.add(oauth_account)
        await db.commit()

        logger.info(f"Linked {provider} OAuth account to user {user_id}")


oauth_service = OAuthService()
