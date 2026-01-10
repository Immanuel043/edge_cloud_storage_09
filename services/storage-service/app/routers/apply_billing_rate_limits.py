"""
Script to apply rate limiting to all critical billing endpoints.
This adds http_request: Request parameter and rate limiting calls.
"""

import re
import sys

def add_rate_limiting():
    # Read the file
    with open('billing_v2.py', 'r') as f:
        content = f.read()

    # Define endpoints and their rate limits
    endpoints = [
        # (function_name, rate_config, endpoint_name)
        ('create_subscription', 'SUBSCRIPTION_CREATE', 'subscription_create'),
        ('upgrade_subscription', 'SUBSCRIPTION_MODIFY', 'subscription_upgrade'),
        ('downgrade_subscription', 'SUBSCRIPTION_MODIFY', 'subscription_downgrade'),
        ('cancel_subscription', 'SUBSCRIPTION_CANCEL', 'subscription_cancel'),
        ('create_billing_portal_session', 'BILLING_PORTAL', 'billing_portal'),
    ]

    for func_name, rate_config, endpoint_name in endpoints:
        # Pattern to find the function definition
        pattern = rf'(@router\.(get|post|put|delete)\([^)]+\)\s*\nasync def {func_name}\([^)]*\):)'

        def replace_func(match):
            # Check if http_request already exists
            if 'http_request' in match.group(0):
                return match.group(0)  # Already has rate limiting

            # Add http_request parameter and rate limiting
            func_def = match.group(0)

            # Insert http_request parameter before current_user
            func_def = func_def.replace(
                'current_user: User',
                'http_request: Request,\n    current_user: User'
            )

            return func_def

        content = re.sub(pattern, replace_func, content, flags=re.MULTILINE)

    # Write back
    with open('billing_v2_updated.py', 'w') as f:
        f.write(content)

    print("Rate limiting applied successfully!")

if __name__ == '__main__':
    add_rate_limiting()
