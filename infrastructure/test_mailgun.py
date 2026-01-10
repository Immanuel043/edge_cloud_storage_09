#!/usr/bin/env python3
"""
Test script to validate Mailgun email configuration
"""
import os
import sys
import requests
from pathlib import Path
from dotenv import load_dotenv

# Load environment variables from .env file
env_path = Path(__file__).parent / '.env'
load_dotenv(env_path)

def send_test_email():
    """Send a test email using Mailgun API"""
    
    # Get configuration from environment
    api_key = os.getenv('MAILGUN_API_KEY')
    domain = os.getenv('MAILGUN_DOMAIN', 'mg.edgevaultcloud.com')
    from_email = os.getenv('MAILGUN_FROM_EMAIL', 'noreply@edgevaultcloud.com')
    from_name = os.getenv('MAILGUN_FROM_NAME', 'EdgeVault')
    api_url = os.getenv('MAILGUN_API_URL', 'https://api.mailgun.net/v3')
    
    # Test recipient
    to_email = "imman.raj95@gmail.com"
    to_name = "Immanuelraj A"
    
    # Construct API endpoint
    api_endpoint = f"{api_url}/{domain}/messages"
    
    print("=" * 60)
    print("Mailgun Email Test")
    print("=" * 60)
    print(f"API Endpoint: {api_endpoint}")
    print(f"Domain: {domain}")
    print(f"From: {from_name} <{from_email}>")
    print(f"To: {to_name} <{to_email}>")
    print(f"API Key: {api_key[:10]}..." if api_key else "NOT SET")
    print("=" * 60)
    
    if not api_key:
        print("ERROR: MAILGUN_API_KEY not found in .env file")
        return False
    
    try:
        response = requests.post(
            api_endpoint,
            auth=("api", api_key),
            data={
                "from": f"{from_name} <{from_email}>",
                "to": f"{to_name} <{to_email}>",
                "subject": "Mailgun Test - EdgeVault Email Verification",
                "text": f"Hello {to_name},\n\nThis is a test email from EdgeVault to verify Mailgun configuration.\n\nIf you received this email, your Mailgun setup is working correctly!\n\nDomain: {domain}\nFrom: {from_email}",
                "html": f"""
                <html>
                <body>
                    <h2>Mailgun Test - EdgeVault Email Verification</h2>
                    <p>Hello {to_name},</p>
                    <p>This is a test email from EdgeVault to verify Mailgun configuration.</p>
                    <p><strong>If you received this email, your Mailgun setup is working correctly!</strong></p>
                    <hr>
                    <p><small>Domain: {domain}<br>From: {from_email}</small></p>
                </body>
                </html>
                """
            },
            timeout=10
        )
        
        print(f"\nResponse Status: {response.status_code}")
        print(f"Response Body: {response.text}")
        
        if response.status_code == 200:
            print("\n✅ SUCCESS: Email sent successfully!")
            print(f"Message ID: {response.json().get('id', 'N/A')}")
            return True
        else:
            print(f"\n❌ ERROR: Failed to send email")
            print(f"Status Code: {response.status_code}")
            print(f"Response: {response.text}")
            return False
            
    except requests.exceptions.RequestException as e:
        print(f"\n❌ ERROR: Request failed")
        print(f"Error: {str(e)}")
        return False
    except Exception as e:
        print(f"\n❌ ERROR: Unexpected error")
        print(f"Error: {str(e)}")
        return False

if __name__ == "__main__":
    success = send_test_email()
    sys.exit(0 if success else 1)

