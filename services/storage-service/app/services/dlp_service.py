"""
Data Loss Prevention (DLP) Service

Detects sensitive data in files to prevent accidental exposure:
- Social Security Numbers (SSN)
- Credit Card Numbers
- API Keys and Tokens
- Email Addresses
- Phone Numbers
- IP Addresses
- AWS Keys, JWT tokens, etc.
"""

import re
import logging
from typing import List, Dict, Set, Optional
from dataclasses import dataclass
from datetime import datetime

logger = logging.getLogger(__name__)


@dataclass
class SensitiveDataMatch:
    """Represents a match of sensitive data"""
    type: str  # e.g., "SSN", "CREDIT_CARD", "API_KEY"
    value: str  # The matched value (may be redacted)
    position: int  # Character position in file
    line_number: int  # Line number where found
    confidence: float  # 0.0 to 1.0
    risk_level: str  # "low", "medium", "high", "critical"


@dataclass
class DLPScanResult:
    """Result of DLP scan"""
    has_sensitive_data: bool
    matches: List[SensitiveDataMatch]
    risk_score: float  # 0-100
    scanned_at: datetime
    scan_time: float
    total_matches: int
    blocked: bool = False  # Whether file should be blocked

    def to_dict(self) -> Dict:
        return {
            'has_sensitive_data': self.has_sensitive_data,
            'matches': [
                {
                    'type': m.type,
                    'value': m.value,
                    'position': m.position,
                    'line_number': m.line_number,
                    'confidence': m.confidence,
                    'risk_level': m.risk_level
                }
                for m in self.matches
            ],
            'risk_score': self.risk_score,
            'total_matches': self.total_matches,
            'blocked': self.blocked,
            'scanned_at': self.scanned_at.isoformat(),
            'scan_time': self.scan_time
        }


class DLPService:
    """Data Loss Prevention service for detecting sensitive data"""

    # SSN patterns (US Social Security Numbers)
    SSN_PATTERNS = [
        re.compile(r'\b\d{3}-\d{2}-\d{4}\b'),  # 123-45-6789
        re.compile(r'\b\d{9}\b'),  # 123456789 (must validate with Luhn)
    ]

    # Credit card patterns (Visa, MasterCard, Amex, Discover)
    CREDIT_CARD_PATTERNS = [
        re.compile(r'\b4\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b'),  # Visa
        re.compile(r'\b5[1-5]\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b'),  # MasterCard
        re.compile(r'\b3[47]\d{2}[\s-]?\d{6}[\s-]?\d{5}\b'),  # Amex
        re.compile(r'\b6011[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b'),  # Discover
    ]

    # API Keys and tokens
    API_KEY_PATTERNS = [
        # AWS Access Key
        re.compile(r'AKIA[0-9A-Z]{16}', re.IGNORECASE),
        # Generic API key patterns
        re.compile(r'api[_-]?key[\s=:]+["\']?([a-zA-Z0-9_\-]{20,})["\']?', re.IGNORECASE),
        re.compile(r'apikey[\s=:]+["\']?([a-zA-Z0-9_\-]{20,})["\']?', re.IGNORECASE),
        # Bearer tokens
        re.compile(r'Bearer\s+[a-zA-Z0-9\-._~+/]+=*', re.IGNORECASE),
        # JWT tokens
        re.compile(r'eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*'),
    ]

    # AWS Secret Key
    AWS_SECRET_PATTERNS = [
        re.compile(r'aws[_-]?secret[_-]?access[_-]?key[\s=:]+["\']?([a-zA-Z0-9/+=]{40})["\']?', re.IGNORECASE),
    ]

    # GitHub/GitLab tokens
    GITHUB_TOKEN_PATTERNS = [
        re.compile(r'gh[pousr]_[a-zA-Z0-9]{36}'),  # GitHub personal tokens
        re.compile(r'github[_-]?token[\s=:]+["\']?([a-zA-Z0-9]{40})["\']?', re.IGNORECASE),
    ]

    # Private keys
    PRIVATE_KEY_PATTERNS = [
        re.compile(r'-----BEGIN (?:RSA|DSA|EC|OPENSSH) PRIVATE KEY-----'),
    ]

    # Email addresses
    EMAIL_PATTERN = re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b')

    # Phone numbers (US format)
    PHONE_PATTERNS = [
        re.compile(r'\b\d{3}-\d{3}-\d{4}\b'),  # 123-456-7890
        re.compile(r'\(\d{3}\)\s*\d{3}-\d{4}'),  # (123) 456-7890
        re.compile(r'\b\d{10}\b'),  # 1234567890
    ]

    # IP Addresses
    IP_PATTERN = re.compile(r'\b(?:\d{1,3}\.){3}\d{1,3}\b')

    # Password patterns
    PASSWORD_PATTERNS = [
        re.compile(r'password[\s=:]+["\']?([^\s"\']{8,})["\']?', re.IGNORECASE),
        re.compile(r'passwd[\s=:]+["\']?([^\s"\']{8,})["\']?', re.IGNORECASE),
    ]

    def __init__(self,
                 max_file_size: int = 10 * 1024 * 1024,  # 10MB default
                 block_threshold: float = 80.0):  # Block if risk score > 80
        self.max_file_size = max_file_size
        self.block_threshold = block_threshold

    def luhn_check(self, card_number: str) -> bool:
        """Validate credit card using Luhn algorithm"""
        def digits_of(n):
            return [int(d) for d in str(n)]

        digits = digits_of(card_number.replace(' ', '').replace('-', ''))
        odd_digits = digits[-1::-2]
        even_digits = digits[-2::-2]
        checksum = sum(odd_digits)
        for d in even_digits:
            checksum += sum(digits_of(d * 2))
        return checksum % 10 == 0

    async def scan_bytes(self, data: bytes, filename: str = '') -> DLPScanResult:
        """
        Scan byte data for sensitive information

        Args:
            data: File content as bytes
            filename: Optional filename for context

        Returns:
            DLPScanResult with detected sensitive data
        """
        import time
        start_time = time.time()

        matches: List[SensitiveDataMatch] = []

        # Skip binary files (common image/video formats)
        if self._is_likely_binary(data):
            logger.info(f"Skipping binary file: {filename}")
            return DLPScanResult(
                has_sensitive_data=False,
                matches=[],
                risk_score=0.0,
                scanned_at=datetime.utcnow(),
                scan_time=time.time() - start_time,
                total_matches=0
            )

        try:
            # Try to decode as text
            text = data.decode('utf-8', errors='ignore')
        except Exception as e:
            logger.warning(f"Failed to decode file as text: {e}")
            return DLPScanResult(
                has_sensitive_data=False,
                matches=[],
                risk_score=0.0,
                scanned_at=datetime.utcnow(),
                scan_time=time.time() - start_time,
                total_matches=0
            )

        lines = text.split('\n')

        # Scan for SSNs
        for line_num, line in enumerate(lines, 1):
            for pattern in self.SSN_PATTERNS:
                for match in pattern.finditer(line):
                    ssn = match.group(0)
                    # Basic validation: not all zeros or sequential
                    if not (ssn.replace('-', '') == '000000000' or
                           ssn.replace('-', '') == '123456789'):
                        matches.append(SensitiveDataMatch(
                            type='SSN',
                            value='***-**-' + ssn[-4:],  # Redact
                            position=match.start(),
                            line_number=line_num,
                            confidence=0.9,
                            risk_level='critical'
                        ))

        # Scan for credit cards
        for line_num, line in enumerate(lines, 1):
            for pattern in self.CREDIT_CARD_PATTERNS:
                for match in pattern.finditer(line):
                    card = match.group(0).replace(' ', '').replace('-', '')
                    if self.luhn_check(card):
                        matches.append(SensitiveDataMatch(
                            type='CREDIT_CARD',
                            value='****-****-****-' + card[-4:],
                            position=match.start(),
                            line_number=line_num,
                            confidence=0.95,
                            risk_level='critical'
                        ))

        # Scan for API keys
        for line_num, line in enumerate(lines, 1):
            for pattern in self.API_KEY_PATTERNS:
                for match in pattern.finditer(line):
                    key_value = match.group(0)
                    matches.append(SensitiveDataMatch(
                        type='API_KEY',
                        value=key_value[:8] + '...' + key_value[-4:] if len(key_value) > 12 else '***',
                        position=match.start(),
                        line_number=line_num,
                        confidence=0.85,
                        risk_level='high'
                    ))

        # Scan for AWS secrets
        for line_num, line in enumerate(lines, 1):
            for pattern in self.AWS_SECRET_PATTERNS:
                for match in pattern.finditer(line):
                    matches.append(SensitiveDataMatch(
                        type='AWS_SECRET_KEY',
                        value='***REDACTED***',
                        position=match.start(),
                        line_number=line_num,
                        confidence=0.95,
                        risk_level='critical'
                    ))

        # Scan for GitHub tokens
        for line_num, line in enumerate(lines, 1):
            for pattern in self.GITHUB_TOKEN_PATTERNS:
                for match in pattern.finditer(line):
                    matches.append(SensitiveDataMatch(
                        type='GITHUB_TOKEN',
                        value='***REDACTED***',
                        position=match.start(),
                        line_number=line_num,
                        confidence=0.9,
                        risk_level='high'
                    ))

        # Scan for private keys
        for line_num, line in enumerate(lines, 1):
            for pattern in self.PRIVATE_KEY_PATTERNS:
                for match in pattern.finditer(line):
                    matches.append(SensitiveDataMatch(
                        type='PRIVATE_KEY',
                        value='***PRIVATE_KEY_DETECTED***',
                        position=match.start(),
                        line_number=line_num,
                        confidence=1.0,
                        risk_level='critical'
                    ))

        # Calculate risk score
        risk_score = self._calculate_risk_score(matches)
        blocked = risk_score > self.block_threshold

        scan_time = time.time() - start_time

        logger.info(f"DLP scan completed: {len(matches)} matches, risk score: {risk_score:.1f}")

        return DLPScanResult(
            has_sensitive_data=len(matches) > 0,
            matches=matches,
            risk_score=risk_score,
            scanned_at=datetime.utcnow(),
            scan_time=scan_time,
            total_matches=len(matches),
            blocked=blocked
        )

    def _is_likely_binary(self, data: bytes) -> bool:
        """Check if data is likely binary (images, videos, executables)"""
        # Check common binary file signatures
        signatures = [
            b'\xff\xd8\xff',  # JPEG
            b'\x89PNG',  # PNG
            b'GIF8',  # GIF
            b'%PDF',  # PDF
            b'PK\x03\x04',  # ZIP
            b'\x1f\x8b',  # GZIP
            b'MZ',  # EXE
            b'\x00\x00\x00\x18ftypmp4',  # MP4
        ]

        for sig in signatures:
            if data.startswith(sig):
                return True

        # Check for high ratio of non-printable characters
        sample = data[:8192]  # Check first 8KB
        non_printable = sum(1 for byte in sample if byte < 32 and byte not in (9, 10, 13))
        ratio = non_printable / len(sample) if sample else 0

        return ratio > 0.3  # More than 30% non-printable = likely binary

    def _calculate_risk_score(self, matches: List[SensitiveDataMatch]) -> float:
        """Calculate overall risk score based on matches"""
        if not matches:
            return 0.0

        # Risk weights
        risk_weights = {
            'critical': 40,
            'high': 25,
            'medium': 15,
            'low': 5
        }

        total_risk = sum(risk_weights.get(m.risk_level, 10) for m in matches)

        # Cap at 100
        return min(total_risk, 100.0)


# Singleton instance
_dlp_service = None

def get_dlp_service() -> DLPService:
    """Get or create DLP service singleton"""
    global _dlp_service
    if _dlp_service is None:
        _dlp_service = DLPService()
    return _dlp_service
