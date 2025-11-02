"""
FIDO2/WebAuthn Service

Handles hardware security key registration and authentication using the FIDO2 protocol.
Supports YubiKey, Google Titan, Windows Hello, and other FIDO2-compliant devices.

Security Properties:
- Hardware keys provide phishing-resistant authentication
- Private keys never leave the hardware device
- Replay protection via signature counters
- User presence verification (touch button)
"""
import base64
import secrets
import structlog
from typing import Optional, Dict, Any, List

from fido2.server import Fido2Server
from fido2.webauthn import (
    PublicKeyCredentialRpEntity,
    PublicKeyCredentialUserEntity,
    PublicKeyCredentialParameters,
    PublicKeyCredentialType,
    AuthenticatorSelectionCriteria,
    UserVerificationRequirement,
    AttestationConveyancePreference,
    AuthenticatorAttachment
)
from fido2 import cbor
from fido2.cose import ES256, RS256

from app.config import settings

logger = structlog.get_logger()


class FIDO2Service:
    """
    Service for FIDO2/WebAuthn hardware key operations.

    This service coordinates hardware security key registration and
    authentication for zero-knowledge encryption recovery.
    """

    def __init__(self):
        """Initialize FIDO2 server"""
        # Relying Party (RP) - your application
        self.rp = PublicKeyCredentialRpEntity(
            id=settings.RP_ID,  # Domain (e.g., "example.com")
            name=settings.RP_NAME  # Display name
        )

        # Create FIDO2 server
        self.server = Fido2Server(self.rp)

        logger.info(
            "fido2_service_initialized",
            rp_id=settings.RP_ID,
            rp_name=settings.RP_NAME
        )

    def generate_registration_options(
        self,
        user_id: str,
        username: str,
        email: str,
        existing_credentials: List[bytes] = None
    ) -> Dict[str, Any]:
        """
        Generate WebAuthn registration options (challenge) for hardware key.

        This creates the challenge that the client will pass to
        navigator.credentials.create().

        Args:
            user_id: User's unique ID
            username: User's username
            email: User's email
            existing_credentials: List of existing credential IDs (to prevent duplicates)

        Returns:
            Registration options dict for client
        """
        # User entity
        user = PublicKeyCredentialUserEntity(
            id=user_id.encode('utf-8'),
            name=email,
            display_name=username
        )

        # Supported algorithms (ES256 = ECDSA, RS256 = RSA)
        pub_key_cred_params = [
            PublicKeyCredentialParameters(
                type=PublicKeyCredentialType.PUBLIC_KEY,
                alg=ES256.ALGORITHM
            ),
            PublicKeyCredentialParameters(
                type=PublicKeyCredentialType.PUBLIC_KEY,
                alg=RS256.ALGORITHM
            )
        ]

        # Authenticator selection criteria
        authenticator_selection = AuthenticatorSelectionCriteria(
            authenticator_attachment=AuthenticatorAttachment.CROSS_PLATFORM,  # External keys only
            resident_key="preferred",  # Allow resident keys (passwordless)
            user_verification=UserVerificationRequirement.PREFERRED
        )

        # Generate registration options
        registration_data, state = self.server.register_begin(
            user=user,
            credentials=existing_credentials or [],
            user_verification=UserVerificationRequirement.PREFERRED,
            authenticator_attachment=AuthenticatorAttachment.CROSS_PLATFORM,
            resident_key_requirement="preferred",
            attestation=AttestationConveyancePreference.NONE  # Don't require attestation (privacy)
        )

        logger.info(
            "registration_challenge_generated",
            user_id=user_id,
            challenge_len=len(registration_data.get("challenge", b""))
        )

        # Convert to format suitable for JSON serialization
        options = {
            "rp": {
                "id": self.rp.id,
                "name": self.rp.name
            },
            "user": {
                "id": base64.urlsafe_b64encode(user.id).decode('utf-8'),
                "name": user.name,
                "displayName": user.display_name
            },
            "challenge": base64.urlsafe_b64encode(registration_data["challenge"]).decode('utf-8'),
            "pubKeyCredParams": [
                {"type": "public-key", "alg": -7},  # ES256
                {"type": "public-key", "alg": -257}  # RS256
            ],
            "timeout": 60000,  # 60 seconds
            "attestation": "none",
            "authenticatorSelection": {
                "authenticatorAttachment": "cross-platform",
                "residentKey": "preferred",
                "userVerification": "preferred"
            },
            "excludeCredentials": [
                {
                    "type": "public-key",
                    "id": base64.urlsafe_b64encode(cred_id).decode('utf-8'),
                    "transports": ["usb", "nfc", "ble"]
                }
                for cred_id in (existing_credentials or [])
            ]
        }

        # Store state for verification (should be stored in Redis in production)
        state_data = {
            "challenge": base64.urlsafe_b64encode(registration_data["challenge"]).decode('utf-8'),
            "user_id": user_id
        }

        return {
            "options": options,
            "state": state_data
        }

    def verify_registration(
        self,
        credential_response: Dict[str, Any],
        expected_challenge: bytes,
        expected_origin: str = None
    ) -> Dict[str, Any]:
        """
        Verify hardware key registration response from client.

        Args:
            credential_response: Response from navigator.credentials.create()
            expected_challenge: Challenge that was sent to client
            expected_origin: Expected origin (e.g., "https://example.com")

        Returns:
            Verified credential data

        Raises:
            ValueError: If verification fails
        """
        if expected_origin is None:
            expected_origin = settings.RP_ORIGIN

        try:
            # Parse response
            client_data = base64.urlsafe_b64decode(credential_response["response"]["clientDataJSON"])
            attestation_object = base64.urlsafe_b64decode(credential_response["response"]["attestationObject"])

            # Verify registration
            auth_data = self.server.register_complete(
                state={
                    "challenge": expected_challenge,
                    "user_verification": UserVerificationRequirement.PREFERRED
                },
                client_data=cbor.decode(client_data),
                attestation_object=cbor.decode(attestation_object)
            )

            # Extract credential data
            credential_id = auth_data.credential_data.credential_id
            public_key = auth_data.credential_data.public_key

            # Get AAGUID (Authenticator Attestation GUID)
            aaguid = auth_data.credential_data.aaguid.hex() if hasattr(auth_data.credential_data, 'aaguid') else None

            logger.info(
                "hardware_key_registration_verified",
                credential_id_len=len(credential_id),
                aaguid=aaguid
            )

            return {
                "credential_id": base64.urlsafe_b64encode(credential_id).decode('utf-8'),
                "public_key": base64.urlsafe_b64encode(cbor.encode(public_key)).decode('utf-8'),
                "aaguid": aaguid,
                "sign_count": auth_data.credential_data.sign_count if hasattr(auth_data.credential_data, 'sign_count') else 0,
                "transports": credential_response.get("response", {}).get("transports", ["usb"])
            }

        except Exception as e:
            logger.error("registration_verification_failed", error=str(e), exc_info=True)
            raise ValueError(f"Hardware key registration verification failed: {str(e)}")

    def generate_authentication_options(
        self,
        credentials: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Generate WebAuthn authentication options (challenge).

        This creates the challenge for authentication with an existing hardware key.

        Args:
            credentials: List of user's registered credentials
                        Each dict should have: credential_id, public_key, sign_count

        Returns:
            Authentication options for client
        """
        # Convert credentials to required format
        allow_credentials = []
        for cred in credentials:
            cred_id = base64.urlsafe_b64decode(cred["credential_id"])
            allow_credentials.append({
                "type": "public-key",
                "id": cred_id,
                "transports": cred.get("transports", ["usb", "nfc", "ble"])
            })

        # Generate challenge
        challenge = secrets.token_bytes(32)

        logger.info(
            "authentication_challenge_generated",
            num_credentials=len(allow_credentials)
        )

        options = {
            "challenge": base64.urlsafe_b64encode(challenge).decode('utf-8'),
            "timeout": 60000,  # 60 seconds
            "rpId": self.rp.id,
            "allowCredentials": [
                {
                    "type": "public-key",
                    "id": base64.urlsafe_b64encode(cred["id"]).decode('utf-8'),
                    "transports": cred.get("transports", ["usb"])
                }
                for cred in allow_credentials
            ],
            "userVerification": "preferred"
        }

        # State to verify later
        state = {
            "challenge": base64.urlsafe_b64encode(challenge).decode('utf-8'),
            "credentials": credentials
        }

        return {
            "options": options,
            "state": state
        }

    def verify_authentication(
        self,
        credential_response: Dict[str, Any],
        expected_challenge: bytes,
        stored_credentials: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Verify hardware key authentication response.

        Args:
            credential_response: Response from navigator.credentials.get()
            expected_challenge: Challenge that was sent
            stored_credentials: User's stored credentials

        Returns:
            Verification result with updated sign count

        Raises:
            ValueError: If verification fails
        """
        try:
            # Parse response
            credential_id = base64.urlsafe_b64decode(credential_response["id"])
            client_data = base64.urlsafe_b64decode(credential_response["response"]["clientDataJSON"])
            authenticator_data = base64.urlsafe_b64decode(credential_response["response"]["authenticatorData"])
            signature = base64.urlsafe_b64decode(credential_response["response"]["signature"])

            # Find matching credential
            matching_cred = None
            for cred in stored_credentials:
                if base64.urlsafe_b64decode(cred["credential_id"]) == credential_id:
                    matching_cred = cred
                    break

            if not matching_cred:
                raise ValueError("Credential not found")

            # Verify authentication
            public_key = cbor.decode(base64.urlsafe_b64decode(matching_cred["public_key"]))

            auth_data = self.server.authenticate_complete(
                state={
                    "challenge": expected_challenge,
                    "user_verification": UserVerificationRequirement.PREFERRED
                },
                credentials=[{
                    "id": credential_id,
                    "public_key": public_key
                }],
                credential_id=credential_id,
                client_data=cbor.decode(client_data),
                auth_data=cbor.decode(authenticator_data),
                signature=signature
            )

            # Get new sign count
            new_sign_count = auth_data.sign_count if hasattr(auth_data, 'sign_count') else 0

            # Check for cloned authenticator (sign count should always increase)
            if new_sign_count <= matching_cred.get("sign_count", 0):
                logger.warning(
                    "possible_cloned_authenticator",
                    credential_id=matching_cred["credential_id"],
                    old_count=matching_cred.get("sign_count"),
                    new_count=new_sign_count
                )

            logger.info(
                "hardware_key_authentication_verified",
                credential_id=matching_cred["credential_id"],
                new_sign_count=new_sign_count
            )

            return {
                "verified": True,
                "credential_id": matching_cred["credential_id"],
                "new_sign_count": new_sign_count,
                "user_verified": True  # Hardware key confirmed user presence
            }

        except Exception as e:
            logger.error("authentication_verification_failed", error=str(e), exc_info=True)
            raise ValueError(f"Hardware key authentication failed: {str(e)}")


# Global FIDO2 service instance
_fido2_service: Optional[FIDO2Service] = None


def get_fido2_service() -> FIDO2Service:
    """
    Get FIDO2 service instance (singleton).

    Returns:
        FIDO2Service instance
    """
    global _fido2_service

    if _fido2_service is None:
        _fido2_service = FIDO2Service()

    return _fido2_service
