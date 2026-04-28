"""
URL Validation and SSRF Protection Service

Provides comprehensive security checks for URL-based file uploads:
- SSRF (Server-Side Request Forgery) prevention
- Private IP blocking
- Cloud metadata endpoint protection
- URL scheme validation
- Redirect chain validation
"""

import ipaddress
import logging
import re
import socket
from typing import Optional, Tuple
from urllib.parse import urlparse

logger = logging.getLogger(__name__)


class SSRFProtectionError(Exception):
    """Raised when SSRF protection blocks a URL"""

    pass


class URLValidator:
    """
    Validates URLs and protects against SSRF attacks

    Security measures:
    - Blocks private IP addresses (RFC1918)
    - Blocks localhost and loopback
    - Blocks link-local addresses
    - Blocks cloud metadata endpoints
    - Validates URL schemes (http/https only)
    - DNS rebinding protection
    """

    # Private IP ranges to block (RFC1918, RFC6598, etc.)
    BLOCKED_IP_RANGES = [
        ipaddress.ip_network("0.0.0.0/8"),  # Current network
        ipaddress.ip_network("10.0.0.0/8"),  # Private network
        ipaddress.ip_network("127.0.0.0/8"),  # Loopback
        ipaddress.ip_network("169.254.0.0/16"),  # Link-local (AWS metadata!)
        ipaddress.ip_network("172.16.0.0/12"),  # Private network
        ipaddress.ip_network("192.168.0.0/16"),  # Private network
        ipaddress.ip_network("224.0.0.0/4"),  # Multicast
        ipaddress.ip_network("240.0.0.0/4"),  # Reserved
        ipaddress.ip_network("::1/128"),  # IPv6 loopback
        ipaddress.ip_network("fe80::/10"),  # IPv6 link-local
        ipaddress.ip_network("fc00::/7"),  # IPv6 private
    ]

    # Cloud metadata endpoints to explicitly block
    BLOCKED_HOSTS = [
        "metadata.google.internal",
        "169.254.169.254",  # AWS, Azure, GCP metadata
        "metadata",
        "localhost",
    ]

    # Allowed URL schemes
    ALLOWED_SCHEMES = ["http", "https"]

    # Maximum redirect depth
    MAX_REDIRECTS = 5

    def __init__(
        self, whitelist_domains: Optional[list] = None, blacklist_domains: Optional[list] = None
    ):
        """
        Initialize URL validator

        Args:
            whitelist_domains: If provided, only these domains are allowed
            blacklist_domains: Additional domains to block
        """
        self.whitelist_domains = set(whitelist_domains or [])
        self.blacklist_domains = set(blacklist_domains or [])

    def validate_url(self, url: str) -> Tuple[bool, Optional[str]]:
        """
        Validate URL and check for SSRF vulnerabilities

        Args:
            url: URL to validate

        Returns:
            Tuple of (is_valid, error_message)

        Raises:
            SSRFProtectionError: If URL is blocked for security reasons
        """
        try:
            # Parse URL
            parsed = urlparse(url)

            # Check scheme
            if parsed.scheme not in self.ALLOWED_SCHEMES:
                raise SSRFProtectionError(
                    f"Invalid URL scheme: {parsed.scheme}. Only http/https allowed."
                )

            # Extract hostname
            hostname = parsed.hostname
            if not hostname:
                raise SSRFProtectionError("URL must have a valid hostname")

            # Check against blacklist
            if hostname.lower() in self.blacklist_domains:
                raise SSRFProtectionError(f"Domain is blacklisted: {hostname}")

            # Check against explicitly blocked hosts
            if hostname.lower() in self.BLOCKED_HOSTS:
                raise SSRFProtectionError(f"Access to {hostname} is blocked (metadata endpoint)")

            # If whitelist is configured, check it
            if self.whitelist_domains and hostname.lower() not in self.whitelist_domains:
                raise SSRFProtectionError(f"Domain not in whitelist: {hostname}")

            # Resolve hostname to IP and check for private ranges
            self._check_ip_address(hostname)

            return True, None

        except SSRFProtectionError as e:
            logger.warning(f"SSRF protection blocked URL {url}: {e}")
            raise
        except Exception as e:
            logger.error(f"URL validation error for {url}: {e}")
            return False, str(e)

    def _check_ip_address(self, hostname: str) -> None:
        """
        Resolve hostname to IP and check if it's in blocked ranges

        Args:
            hostname: Hostname to check

        Raises:
            SSRFProtectionError: If IP is in blocked range
        """
        try:
            # Try to parse as IP address directly
            try:
                ip = ipaddress.ip_address(hostname)
                self._validate_ip(ip, hostname)
                return
            except ValueError:
                # Not a direct IP, need to resolve
                pass

            # Resolve hostname to IP addresses
            try:
                addr_info = socket.getaddrinfo(hostname, None)
            except socket.gaierror as e:
                raise SSRFProtectionError(f"Cannot resolve hostname: {hostname} ({e})")

            # Check all resolved IPs
            for info in addr_info:
                ip_str = info[4][0]
                try:
                    ip = ipaddress.ip_address(ip_str)
                    self._validate_ip(ip, hostname)
                except ValueError:
                    # Skip invalid IPs
                    continue

        except SSRFProtectionError:
            raise
        except Exception as e:
            logger.error(f"IP check failed for {hostname}: {e}")
            raise SSRFProtectionError(f"IP validation failed: {e}")

    def _validate_ip(
        self, ip: ipaddress.IPv4Address | ipaddress.IPv6Address, hostname: str
    ) -> None:
        """
        Check if IP address is in blocked range

        Args:
            ip: IP address object
            hostname: Original hostname (for logging)

        Raises:
            SSRFProtectionError: If IP is blocked
        """
        # Check against blocked ranges
        for blocked_range in self.BLOCKED_IP_RANGES:
            if ip in blocked_range:
                raise SSRFProtectionError(
                    f"Access to private/reserved IP blocked: {hostname} -> {ip} "
                    f"(in range {blocked_range})"
                )

        # Additional check for private addresses
        if ip.is_private:
            raise SSRFProtectionError(f"Access to private IP blocked: {hostname} -> {ip}")

        # Check for loopback
        if ip.is_loopback:
            raise SSRFProtectionError(f"Access to loopback address blocked: {hostname} -> {ip}")

        # Check for link-local
        if ip.is_link_local:
            raise SSRFProtectionError(f"Access to link-local address blocked: {hostname} -> {ip}")

        # Check for multicast
        if ip.is_multicast:
            raise SSRFProtectionError(f"Access to multicast address blocked: {hostname} -> {ip}")

    def sanitize_url(self, url: str) -> str:
        """
        Sanitize URL by removing dangerous components

        Args:
            url: URL to sanitize

        Returns:
            Sanitized URL
        """
        # Remove whitespace
        url = url.strip()

        # Remove any embedded credentials
        parsed = urlparse(url)
        if parsed.username or parsed.password:
            # Rebuild URL without credentials
            netloc = parsed.hostname
            if parsed.port:
                netloc = f"{netloc}:{parsed.port}"

            url = f"{parsed.scheme}://{netloc}{parsed.path}"
            if parsed.query:
                url = f"{url}?{parsed.query}"
            if parsed.fragment:
                url = f"{url}#{parsed.fragment}"

        return url

    def validate_after_redirect(self, final_url: str, original_url: str) -> None:
        """
        Re-validate URL after following redirects

        Important for DNS rebinding protection - the redirect target
        must also pass SSRF checks.

        Args:
            final_url: URL after following redirects
            original_url: Original URL

        Raises:
            SSRFProtectionError: If final URL fails validation
        """
        logger.info(f"Validating redirect: {original_url} -> {final_url}")

        # Validate the final URL
        self.validate_url(final_url)

        # Additional check: ensure scheme didn't downgrade
        original_parsed = urlparse(original_url)
        final_parsed = urlparse(final_url)

        if original_parsed.scheme == "https" and final_parsed.scheme == "http":
            raise SSRFProtectionError(
                f"HTTPS-to-HTTP downgrade blocked: {original_url} -> {final_url}"
            )


# Singleton instance
url_validator = URLValidator()


def create_url_validator(
    whitelist: Optional[list] = None, blacklist: Optional[list] = None
) -> URLValidator:
    """
    Factory function to create a URL validator with custom lists

    Args:
        whitelist: Domain whitelist
        blacklist: Additional domain blacklist

    Returns:
        URLValidator instance
    """
    return URLValidator(whitelist_domains=whitelist, blacklist_domains=blacklist)
