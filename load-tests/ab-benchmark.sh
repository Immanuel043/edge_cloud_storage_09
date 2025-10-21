#!/bin/bash
###############################################################################
# Apache Bench (ab) Performance Benchmark Script
#
# Tests individual endpoints with high concurrency to measure:
# - Throughput (requests/sec)
# - Latency (response time)
# - Concurrency handling
#
# Usage:
#   chmod +x load-tests/ab-benchmark.sh
#   ./load-tests/ab-benchmark.sh
#
# Requirements:
#   - Apache Bench (ab) installed: apt-get install apache2-utils
#   - Running Edge Cloud Storage API
###############################################################################

set -e

# Configuration
API_URL="${API_URL:-http://localhost:8001}"
REQUESTS=1000
CONCURRENCY=50
OUTPUT_DIR="load-tests/results"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Create output directory
mkdir -p "$OUTPUT_DIR"

echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}  Edge Cloud Storage Performance Test${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""
echo "API URL: $API_URL"
echo "Requests per test: $REQUESTS"
echo "Concurrency: $CONCURRENCY"
echo ""

# Get auth token
echo -e "${YELLOW}Authenticating...${NC}"
AUTH_RESPONSE=$(curl -s -X POST "$API_URL/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"testpassword123"}')

TOKEN=$(echo $AUTH_RESPONSE | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo -e "${RED}❌ Authentication failed${NC}"
  exit 1
fi

echo -e "${GREEN}✅ Authentication successful${NC}"
echo ""

# Test function
run_test() {
  local NAME=$1
  local URL=$2
  local METHOD=${3:-GET}
  local BODY=${4:-}

  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}Testing: $NAME${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

  local OUTPUT_FILE="$OUTPUT_DIR/${NAME// /_}.txt"
  local HEADER_FILE="$OUTPUT_DIR/${NAME// /_}_headers.txt"

  # Create auth headers file
  echo "Authorization: Bearer $TOKEN" > "$HEADER_FILE"
  echo "Content-Type: application/json" >> "$HEADER_FILE"

  # Run benchmark
  if [ -z "$BODY" ]; then
    ab -n $REQUESTS \
       -c $CONCURRENCY \
       -H "Authorization: Bearer $TOKEN" \
       -g "$OUTPUT_DIR/${NAME// /_}_gnuplot.tsv" \
       "$URL" > "$OUTPUT_FILE" 2>&1
  else
    echo "$BODY" > "$OUTPUT_DIR/body.json"
    ab -n $REQUESTS \
       -c $CONCURRENCY \
       -p "$OUTPUT_DIR/body.json" \
       -T "application/json" \
       -H "Authorization: Bearer $TOKEN" \
       -g "$OUTPUT_DIR/${NAME// /_}_gnuplot.tsv" \
       "$URL" > "$OUTPUT_FILE" 2>&1
  fi

  # Extract key metrics
  local REQUESTS_PER_SEC=$(grep "Requests per second" "$OUTPUT_FILE" | awk '{print $4}')
  local TIME_PER_REQ=$(grep "Time per request.*mean" "$OUTPUT_FILE" | head -1 | awk '{print $4}')
  local P50=$(grep "50%" "$OUTPUT_FILE" | awk '{print $2}')
  local P95=$(grep "95%" "$OUTPUT_FILE" | awk '{print $2}')
  local P99=$(grep "99%" "$OUTPUT_FILE" | awk '{print $2}')
  local FAILED=$(grep "Failed requests" "$OUTPUT_FILE" | awk '{print $3}')

  # Display results
  echo "  Requests/sec:    ${GREEN}$REQUESTS_PER_SEC${NC}"
  echo "  Time/request:    ${YELLOW}${TIME_PER_REQ}ms${NC}"
  echo "  50th percentile: ${P50}ms"
  echo "  95th percentile: ${P95}ms"
  echo "  99th percentile: ${P99}ms"

  if [ "$FAILED" = "0" ]; then
    echo -e "  Failed requests: ${GREEN}$FAILED${NC}"
  else
    echo -e "  Failed requests: ${RED}$FAILED${NC}"
  fi

  echo ""

  # Performance check
  local TARGET_TIME=50
  case $NAME in
    "List Files")
      TARGET_TIME=50
      ;;
    "Search Files")
      TARGET_TIME=100
      ;;
    "Storage Analytics")
      TARGET_TIME=300
      ;;
    *)
      TARGET_TIME=100
      ;;
  esac

  if (( $(echo "$TIME_PER_REQ < $TARGET_TIME" | bc -l) )); then
    echo -e "${GREEN}✅ PASS - Under ${TARGET_TIME}ms target${NC}"
  else
    echo -e "${YELLOW}⚠️  SLOW - Target: ${TARGET_TIME}ms, Actual: ${TIME_PER_REQ}ms${NC}"
  fi

  echo ""
}

# Run tests

echo -e "${YELLOW}Starting performance tests...${NC}"
echo ""

# Test 1: List Files (most common)
run_test "List Files" \
  "$API_URL/api/v1/files?limit=100"

# Test 2: Search
run_test "Search Files" \
  "$API_URL/api/v1/search" \
  "POST" \
  '{"query":"test","limit":50}'

# Test 3: List Folders
run_test "List Folders" \
  "$API_URL/api/v1/folders"

# Test 4: Favorites
run_test "Get Favorites" \
  "$API_URL/api/v1/favorites/files"

# Test 5: User Profile
run_test "User Profile" \
  "$API_URL/api/v1/auth/me"

# Test 6: Storage Analytics
run_test "Storage Analytics" \
  "$API_URL/api/v1/storage/optimization/analysis"

# Test 7: Health Check
run_test "Health Check" \
  "$API_URL/api/v1/health"

# Summary
echo -e "${BLUE}=========================================${NC}"
echo -e "${BLUE}  Performance Test Complete${NC}"
echo -e "${BLUE}=========================================${NC}"
echo ""
echo -e "Results saved to: ${GREEN}$OUTPUT_DIR${NC}"
echo ""
echo "To visualize results with gnuplot:"
echo "  gnuplot -e \"plot '$OUTPUT_DIR/List_Files_gnuplot.tsv' using 5 with lines\""
echo ""

# Generate summary report
SUMMARY_FILE="$OUTPUT_DIR/summary.txt"

echo "Edge Cloud Storage Performance Test Summary" > "$SUMMARY_FILE"
echo "==========================================" >> "$SUMMARY_FILE"
echo "" >> "$SUMMARY_FILE"
echo "Date: $(date)" >> "$SUMMARY_FILE"
echo "API URL: $API_URL" >> "$SUMMARY_FILE"
echo "Requests: $REQUESTS" >> "$SUMMARY_FILE"
echo "Concurrency: $CONCURRENCY" >> "$SUMMARY_FILE"
echo "" >> "$SUMMARY_FILE"

for file in "$OUTPUT_DIR"/*.txt; do
  if [ "$file" != "$SUMMARY_FILE" ]; then
    echo "----------------------------------------" >> "$SUMMARY_FILE"
    echo "Test: $(basename "$file" .txt)" >> "$SUMMARY_FILE"
    echo "----------------------------------------" >> "$SUMMARY_FILE"
    grep -E "Requests per second|Time per request|95%|Failed requests" "$file" >> "$SUMMARY_FILE"
    echo "" >> "$SUMMARY_FILE"
  fi
done

echo -e "Summary report: ${GREEN}$SUMMARY_FILE${NC}"
echo ""

# Cleanup
rm -f "$OUTPUT_DIR/body.json"
rm -f "$OUTPUT_DIR"/*_headers.txt

echo -e "${GREEN}✅ All tests complete!${NC}"
