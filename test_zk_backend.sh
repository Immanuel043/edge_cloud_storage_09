#!/bin/bash
# Zero-Knowledge Encryption Backend Test Suite
# Tests all ZK service endpoints with curl

# set -e temporarily disabled to see all test results
# set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
ZK_SERVICE_URL="http://localhost:8002"
API_PREFIX="/api/v1/zk"
TEST_EMAIL="zktest@example.com"
TEST_PASSWORD="SecurePassword123!"
TEST_USERNAME="zktest"

# Test result tracking
TESTS_PASSED=0
TESTS_FAILED=0

# Helper functions
print_header() {
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""
}

print_test() {
    echo -e "${YELLOW}TEST: $1${NC}"
}

print_success() {
    echo -e "${GREEN}✓ PASS: $1${NC}"
    ((TESTS_PASSED++))
}

print_error() {
    echo -e "${RED}✗ FAIL: $1${NC}"
    echo -e "${RED}  Error: $2${NC}"
    ((TESTS_FAILED++))
}

print_info() {
    echo -e "${BLUE}ℹ INFO: $1${NC}"
}

# Function to make API calls and check response
api_call() {
    local method=$1
    local endpoint=$2
    local data=$3
    local expected_status=$4
    local description=$5

    print_test "$description"

    response=$(curl -s -w "\n%{http_code}" -X "$method" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $TOKEN" \
        -d "$data" \
        "${ZK_SERVICE_URL}${API_PREFIX}${endpoint}")

    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')

    if [ "$http_code" -eq "$expected_status" ]; then
        print_success "$description (HTTP $http_code)"
        echo "$body" | jq '.' 2>/dev/null || echo "$body"
        return 0
    else
        print_error "$description" "Expected HTTP $expected_status, got $http_code"
        echo "$body" | jq '.' 2>/dev/null || echo "$body"
        return 1
    fi
}

# ==================== START TESTS ====================

print_header "Zero-Knowledge Encryption Backend Test Suite"

# Test 1: Health Check
print_header "1. Health Check"
print_test "ZK Service Health"
response=$(curl -s "${ZK_SERVICE_URL}/health")
if echo "$response" | jq -e '.status == "healthy"' > /dev/null 2>&1; then
    print_success "ZK Service is healthy"
    echo "$response" | jq '.'
else
    print_error "Health check failed" "$response"
fi

# Test 2: KDF Parameters (Public Endpoint)
print_header "2. KDF Parameters Endpoint"
print_test "Get KDF params for non-existent user"
response=$(curl -s -w "\n%{http_code}" "${ZK_SERVICE_URL}${API_PREFIX}/kdf-params?email=${TEST_EMAIL}")
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" -eq 404 ]; then
    print_success "KDF params returns 404 for non-existent user"
else
    print_error "KDF params test" "Expected 404, got $http_code"
fi

# Test 3: ZK Registration
print_header "3. Zero-Knowledge Registration"

# Generate client-side derived key (simulated)
print_info "In real implementation, client derives key from password using PBKDF2"
print_info "Server never sees the password or derived key"

# Simulated registration data (remove newlines from base64)
KDF_SALT=$(openssl rand -hex 32)
PASSWORD_HASH=$(echo -n "derived_key_hash" | openssl dgst -sha256 | cut -d' ' -f2)
ENCRYPTED_MASTER_KEY=$(openssl rand -base64 64 | tr -d '\n')

registration_data=$(cat <<EOF
{
    "email": "$TEST_EMAIL",
    "username": "$TEST_USERNAME",
    "password_hash": "$PASSWORD_HASH",
    "encrypted_master_key": "$ENCRYPTED_MASTER_KEY",
    "kdf_salt": "$KDF_SALT",
    "kdf_algorithm": "pbkdf2",
    "kdf_iterations": 600000
}
EOF
)

print_test "Register ZK user"
response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d "$registration_data" \
    "${ZK_SERVICE_URL}${API_PREFIX}/register-zk")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" -eq 201 ]; then
    print_success "ZK Registration successful"
    echo "$body" | jq '.'
    USER_ID=$(echo "$body" | jq -r '.user_id')
    TOKEN=$(echo "$body" | jq -r '.access_token')
else
    print_error "ZK Registration" "Expected 201, got $http_code"
    echo "$body"
    exit 1
fi

# Test 4: Get KDF Params (After Registration)
print_header "4. Get KDF Parameters (Registered User)"
print_test "Get KDF params for registered user"
response=$(curl -s -w "\n%{http_code}" "${ZK_SERVICE_URL}${API_PREFIX}/kdf-params?email=${TEST_EMAIL}")
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" -eq 200 ]; then
    print_success "KDF params retrieved successfully"
    echo "$body" | jq '.'
else
    print_error "Get KDF params" "Expected 200, got $http_code"
fi

# Test 5: ZK Login
print_header "5. Zero-Knowledge Login"

login_data=$(cat <<EOF
{
    "email": "$TEST_EMAIL",
    "password_hash": "$PASSWORD_HASH"
}
EOF
)

print_test "Login with ZK credentials"
response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d "$login_data" \
    "${ZK_SERVICE_URL}${API_PREFIX}/login-zk")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" -eq 200 ]; then
    print_success "ZK Login successful"
    echo "$body" | jq '.'
    TOKEN=$(echo "$body" | jq -r '.access_token')
    ENCRYPTED_MASTER_KEY_RETURNED=$(echo "$body" | jq -r '.encrypted_master_key')
else
    print_error "ZK Login" "Expected 200, got $http_code"
    echo "$body"
fi

# Test 6: Get ZK Status
print_header "6. Get ZK Status"
print_test "Check ZK status for user"
response=$(curl -s -w "\n%{http_code}" -X GET \
    -H "Authorization: Bearer $TOKEN" \
    "${ZK_SERVICE_URL}${API_PREFIX}/status")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" -eq 200 ]; then
    print_success "ZK status retrieved"
    echo "$body" | jq '.'
else
    print_error "Get ZK status" "Expected 200, got $http_code"
fi

# Test 7: Enable Recovery Phrase
print_header "7. Recovery Phrase Management"

# Use a consistent test recovery phrase (24 words)
TEST_RECOVERY_PHRASE="abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
RECOVERY_PHRASE_HASH=$(echo -n "$TEST_RECOVERY_PHRASE" | openssl dgst -sha256 | cut -d' ' -f2)

recovery_data=$(cat <<EOF
{
    "recovery_encrypted_master_key": "$(openssl rand -base64 64 | tr -d '\n')",
    "recovery_phrase_hash": "$RECOVERY_PHRASE_HASH"
}
EOF
)

print_test "Enable recovery phrase"
response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "$recovery_data" \
    "${ZK_SERVICE_URL}${API_PREFIX}/recovery/enable")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" -eq 200 ]; then
    print_success "Recovery phrase enabled"
    echo "$body" | jq '.'
else
    print_error "Enable recovery phrase" "Expected 200, got $http_code"
    echo "$body"
fi

# Test 8: Verify Recovery Phrase
print_header "8. Verify Recovery Phrase"

# Use the same recovery phrase that was used when enabling recovery
verify_data=$(cat <<EOF
{
    "recovery_phrase": "$TEST_RECOVERY_PHRASE"
}
EOF
)

print_test "Verify recovery phrase"
response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "$verify_data" \
    "${ZK_SERVICE_URL}${API_PREFIX}/recovery/verify")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" -eq 200 ]; then
    print_success "Recovery phrase verified"
    echo "$body" | jq '.'
else
    print_error "Verify recovery phrase" "Expected 200, got $http_code"
    echo "$body"
fi

# Test 9: File Upload Initialization
print_header "9. Zero-Knowledge File Upload"

upload_init_data=$(cat <<EOF
{
    "filename": "test_encrypted_file.pdf",
    "file_size": 1048576,
    "mime_type": "application/pdf",
    "encrypted_file_key": "$(openssl rand -base64 44 | tr -d '\n')",
    "file_key_iv": "$(openssl rand -base64 16 | tr -d '\n')",
    "encryption_algorithm": "AES-256-GCM",
    "chunk_size": 1048576
}
EOF
)

print_test "Initialize encrypted file upload"
response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "$upload_init_data" \
    "${ZK_SERVICE_URL}${API_PREFIX}/upload/init")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" -eq 200 ]; then
    print_success "Upload initialized"
    echo "$body" | jq '.'
    UPLOAD_ID=$(echo "$body" | jq -r '.upload_id')
    FILE_ID=$(echo "$body" | jq -r '.file_id')
else
    print_error "Initialize upload" "Expected 200, got $http_code"
    echo "$body"
fi

# Test 10: List Files
print_header "10. List Encrypted Files"
print_test "List user's encrypted files"
response=$(curl -s -w "\n%{http_code}" -X GET \
    -H "Authorization: Bearer $TOKEN" \
    "${ZK_SERVICE_URL}${API_PREFIX}/files")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" -eq 200 ]; then
    print_success "Files listed successfully"
    echo "$body" | jq '.'
else
    print_error "List files" "Expected 200, got $http_code"
    echo "$body"
fi

# Test 11: Storage Usage
print_header "11. Storage Usage"
print_test "Get storage usage statistics"
response=$(curl -s -w "\n%{http_code}" -X GET \
    -H "Authorization: Bearer $TOKEN" \
    "${ZK_SERVICE_URL}${API_PREFIX}/storage/usage")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" -eq 200 ]; then
    print_success "Storage usage retrieved"
    echo "$body" | jq '.'
else
    print_error "Get storage usage" "Expected 200, got $http_code"
    echo "$body"
fi

# Test 12: Logout
print_header "12. Logout"
print_test "Logout user"
response=$(curl -s -w "\n%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" \
    "${ZK_SERVICE_URL}${API_PREFIX}/logout")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" -eq 200 ]; then
    print_success "Logout successful"
    echo "$body" | jq '.'
else
    print_error "Logout" "Expected 200, got $http_code"
    echo "$body"
fi

# ==================== TEST SUMMARY ====================

print_header "Test Summary"
echo -e "${BLUE}Total Tests: $((TESTS_PASSED + TESTS_FAILED))${NC}"
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Failed: $TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}❌ Some tests failed!${NC}"
    exit 1
fi
