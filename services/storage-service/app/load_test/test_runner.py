# load_test/test_runner.py
import asyncio
import aiohttp
import time
import random
import json
from dataclasses import dataclass
from typing import List
import statistics

@dataclass
class TestResult:
    user_id: int
    success: bool
    duration: float
    error: str = None
    
class LoadTestRunner:
    def __init__(self, base_url="http://localhost:8001"):
        self.base_url = base_url
        self.results: List[TestResult] = []
        
    async def create_test_users(self, count: int):
        """Create test users for load testing"""
        async with aiohttp.ClientSession() as session:
            for i in range(count):
                await session.post(
                    f"{self.base_url}/api/v1/auth/register",
                    data={
                        'email': f'loadtest{i}@test.com',
                        'username': f'loadtest{i}',
                        'password': 'test123'
                    }
                )
                
    async def simulate_user_upload(self, session: aiohttp.ClientSession, user_id: int, file_size: int):
        """Simulate a single user uploading a file"""
        start_time = time.time()
        
        try:
            # Login
            async with session.post(
                f"{self.base_url}/api/v1/auth/login",
                data={'email': f'loadtest{user_id}@test.com', 'password': 'test123'}
            ) as resp:
                if resp.status != 200:
                    raise Exception(f"Login failed: {resp.status}")
                data = await resp.json()
                token = data['access_token']
            
            headers = {'Authorization': f'Bearer {token}'}
            
            # Initialize upload
            async with session.post(
                f"{self.base_url}/api/v1/upload/init",
                json={
                    'file_name': f'test_{user_id}_{int(time.time())}.dat',
                    'file_size': file_size
                },
                headers=headers
            ) as resp:
                if resp.status != 200:
                    raise Exception(f"Init failed: {resp.status}")
                upload_data = await resp.json()
            
            # Direct upload for small files
            if upload_data['direct_upload']:
                chunk_data = b'x' * file_size
                files = {'file': ('test.dat', chunk_data)}
                async with session.post(
                    f"{self.base_url}/api/v1/upload/direct/{upload_data['upload_id']}",
                    data=files,
                    headers=headers
                ) as resp:
                    if resp.status != 200:
                        raise Exception(f"Direct upload failed: {resp.status}")
            else:
                # Chunked upload for large files
                chunk_size = upload_data['chunk_size']
                total_chunks = upload_data['total_chunks']
                
                for i in range(total_chunks):
                    chunk_data = b'x' * min(chunk_size, file_size - i * chunk_size)
                    files = {'chunk': ('chunk.dat', chunk_data)}
                    async with session.post(
                        f"{self.base_url}/api/v1/upload/chunk/{upload_data['upload_id']}",
                        data={'chunk_index': i},
                        files=files,
                        headers=headers
                    ) as resp:
                        if resp.status != 200:
                            raise Exception(f"Chunk {i} failed: {resp.status}")
            
            # Complete upload
            async with session.post(
                f"{self.base_url}/api/v1/upload/complete/{upload_data['upload_id']}",
                headers=headers
            ) as resp:
                if resp.status != 200:
                    raise Exception(f"Complete failed: {resp.status}")
                result = await resp.json()
            
            duration = time.time() - start_time
            return TestResult(user_id, True, duration)
            
        except Exception as e:
            duration = time.time() - start_time
            return TestResult(user_id, False, duration, str(e))
    
    async def run_concurrent_test(self, num_users: int, file_size: int):
        """Run test with specified number of concurrent users"""
        connector = aiohttp.TCPConnector(limit=num_users)
        timeout = aiohttp.ClientTimeout(total=300)
        
        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            tasks = []
            for i in range(num_users):
                tasks.append(self.simulate_user_upload(session, i, file_size))
            
            results = await asyncio.gather(*tasks, return_exceptions=True)
            
            # Process results
            for result in results:
                if isinstance(result, TestResult):
                    self.results.append(result)
                else:
                    self.results.append(TestResult(-1, False, 0, str(result)))
    
    def print_summary(self):
        """Print test results summary"""
        successful = [r for r in self.results if r.success]
        failed = [r for r in self.results if not r.success]
        
        print(f"\n{'='*60}")
        print(f"Load Test Results")
        print(f"{'='*60}")
        print(f"Total requests: {len(self.results)}")
        print(f"Successful: {len(successful)}")
        print(f"Failed: {len(failed)}")
        print(f"Success rate: {len(successful)/len(self.results)*100:.2f}%")
        
        if successful:
            durations = [r.duration for r in successful]
            print(f"\nResponse Times (successful requests):")
            print(f"  Min: {min(durations):.2f}s")
            print(f"  Max: {max(durations):.2f}s")
            print(f"  Mean: {statistics.mean(durations):.2f}s")
            print(f"  Median: {statistics.median(durations):.2f}s")
            print(f"  P95: {statistics.quantiles(durations, n=20)[18]:.2f}s")
            print(f"  P99: {statistics.quantiles(durations, n=100)[98]:.2f}s")
        
        if failed:
            print(f"\nFailed requests:")
            error_counts = {}
            for r in failed:
                error = r.error or "Unknown"
                error_counts[error] = error_counts.get(error, 0) + 1
            for error, count in error_counts.items():
                print(f"  {error}: {count}")

async def main():
    runner = LoadTestRunner()
    
    # Create test users
    print("Creating test users...")
    await runner.create_test_users(200)
    
    # Test scenarios
    test_scenarios = [
        (10, 1024 * 1024),      # 10 users, 1MB files
        (50, 1024 * 1024),      # 50 users, 1MB files
        (100, 10 * 1024 * 1024), # 100 users, 10MB files
        (200, 10 * 1024 * 1024), # 200 users, 10MB files
    ]
    
    for num_users, file_size in test_scenarios:
        print(f"\n\nTesting with {num_users} concurrent users, {file_size/(1024*1024):.1f}MB files")
        runner.results = []  # Reset results
        
        start = time.time()
        await runner.run_concurrent_test(num_users, file_size)
        total_time = time.time() - start
        
        runner.print_summary()
        print(f"Total test duration: {total_time:.2f}s")
        print(f"Throughput: {num_users/total_time:.2f} uploads/sec")
        
        # Cool down between tests
        print("Cooling down for 30 seconds...")
        await asyncio.sleep(30)

if __name__ == "__main__":
    asyncio.run(main())