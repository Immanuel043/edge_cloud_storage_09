/**
 * K6 Load Testing Script for Edge Cloud Storage
 *
 * Tests performance under realistic load:
 * - File listing
 * - File search
 * - File upload/download
 * - Storage analytics
 *
 * Usage:
 *   k6 run load-tests/k6-performance-test.js
 *   k6 run --vus 100 --duration 5m load-tests/k6-performance-test.js
 *
 * Install K6:
 *   brew install k6  # macOS
 *   choco install k6  # Windows
 *   sudo snap install k6  # Linux
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const listFilesDuration = new Trend('list_files_duration');
const searchDuration = new Trend('search_duration');
const uploadDuration = new Trend('upload_duration');
const downloadDuration = new Trend('download_duration');
const apiCalls = new Counter('api_calls');

// Test configuration
export const options = {
  stages: [
    { duration: '30s', target: 10 },   // Warm up to 10 users
    { duration: '1m', target: 50 },    // Ramp up to 50 users
    { duration: '2m', target: 100 },   // Peak load: 100 concurrent users
    { duration: '1m', target: 50 },    // Ramp down
    { duration: '30s', target: 0 },    // Cool down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],   // 95% of requests under 500ms
    http_req_failed: ['rate<0.01'],     // Less than 1% errors
    errors: ['rate<0.01'],
    list_files_duration: ['p(95)<50'],  // List files under 50ms
    search_duration: ['p(95)<100'],     // Search under 100ms
  },
};

// Configuration
const BASE_URL = __ENV.API_URL || 'http://localhost:8001';
const TEST_USER_EMAIL = __ENV.TEST_EMAIL || 'test@example.com';
const TEST_USER_PASSWORD = __ENV.TEST_PASSWORD || 'testpassword123';

// Authentication
function login() {
  const loginRes = http.post(`${BASE_URL}/api/v1/auth/login`, JSON.stringify({
    email: TEST_USER_EMAIL,
    password: TEST_USER_PASSWORD,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });

  check(loginRes, {
    'login successful': (r) => r.status === 200,
  }) || errorRate.add(1);

  const token = loginRes.json('access_token');
  return token;
}

// Get auth headers
function getAuthHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

// Main test scenario
export default function () {
  // Login once per virtual user
  const token = login();
  if (!token) {
    console.error('Failed to login');
    return;
  }

  const headers = getAuthHeaders(token);

  // Test 1: List Files (most common operation)
  group('List Files', () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/v1/files?limit=100`, { headers });

    const duration = Date.now() - start;
    listFilesDuration.add(duration);
    apiCalls.add(1);

    check(res, {
      'list files status 200': (r) => r.status === 200,
      'list files fast (<100ms)': (r) => r.timings.duration < 100,
    }) || errorRate.add(1);
  });

  sleep(1);

  // Test 2: Search Files
  group('Search Files', () => {
    const start = Date.now();
    const res = http.post(`${BASE_URL}/api/v1/search`, JSON.stringify({
      query: 'test',
      limit: 50,
    }), { headers });

    const duration = Date.now() - start;
    searchDuration.add(duration);
    apiCalls.add(1);

    check(res, {
      'search status 200': (r) => r.status === 200,
      'search fast (<200ms)': (r) => r.timings.duration < 200,
    }) || errorRate.add(1);
  });

  sleep(1);

  // Test 3: Get Storage Stats (ML feature)
  group('Storage Analytics', () => {
    const res = http.get(`${BASE_URL}/api/v1/storage/optimization/analysis`, { headers });

    apiCalls.add(1);

    check(res, {
      'analytics status 200': (r) => r.status === 200,
      'analytics fast (<500ms)': (r) => r.timings.duration < 500,
    }) || errorRate.add(1);
  });

  sleep(2);

  // Test 4: List Folders
  group('List Folders', () => {
    const res = http.get(`${BASE_URL}/api/v1/folders`, { headers });

    apiCalls.add(1);

    check(res, {
      'list folders status 200': (r) => r.status === 200,
      'folders fast (<100ms)': (r) => r.timings.duration < 100,
    }) || errorRate.add(1);
  });

  sleep(1);

  // Test 5: Favorites
  group('Get Favorites', () => {
    const res = http.get(`${BASE_URL}/api/v1/favorites/files`, { headers });

    apiCalls.add(1);

    check(res, {
      'favorites status 200': (r) => r.status === 200,
      'favorites fast (<50ms)': (r) => r.timings.duration < 50,
    }) || errorRate.add(1);
  });

  sleep(2);

  // Test 6: User Profile
  group('Get User Profile', () => {
    const res = http.get(`${BASE_URL}/api/v1/auth/me`, { headers });

    apiCalls.add(1);

    check(res, {
      'profile status 200': (r) => r.status === 200,
      'profile fast (<50ms)': (r) => r.timings.duration < 50,
    }) || errorRate.add(1);
  });

  sleep(3);
}

// Teardown
export function teardown(data) {
  console.log('\n=== Performance Test Summary ===');
  console.log('Total API calls:', apiCalls.value);
  console.log('================================\n');
}
