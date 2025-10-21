## Frontend Performance Optimization Guide

**Target**: 3x page load improvement (3s → 1s)
**Focus**: React/Next.js optimization for Edge Cloud Storage

---

## 🎯 Performance Targets

| Metric | Current | Target | Improvement |
|--------|---------|--------|-------------|
| First Contentful Paint (FCP) | ~2.5s | <1s | 2.5x |
| Time to Interactive (TTI) | ~3.5s | <1.5s | 2.3x |
| Bundle Size | ~800KB | <250KB | 3.2x |
| Lighthouse Score | ~60 | >90 | 50% |

---

## 1. Code Splitting & Lazy Loading

### Route-Based Code Splitting

**Problem**: All components loaded on initial page load
**Solution**: Split code by route using dynamic imports

```javascript
// ❌ Before: All routes loaded upfront
import Dashboard from './pages/Dashboard';
import FileManager from './pages/FileManager';
import Settings from './pages/Settings';

// ✅ After: Routes lazy loaded
const Dashboard = lazy(() => import('./pages/Dashboard'));
const FileManager = lazy(() => import('./pages/FileManager'));
const Settings = lazy(() => import('./pages/Settings'));

function App() {
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/files" element={<FileManager />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
    </Suspense>
  );
}
```

**Impact**: Bundle size -60%, Initial load time -50%

### Component-Level Lazy Loading

```javascript
// ❌ Before: Heavy component always loaded
import RichTextEditor from './components/RichTextEditor'; // 200KB

// ✅ After: Load only when needed
const RichTextEditor = lazy(() => import('./components/RichTextEditor'));

function DocumentEditor({ showEditor }) {
  return (
    <>
      {showEditor && (
        <Suspense fallback={<div>Loading editor...</div>}>
          <RichTextEditor />
        </Suspense>
      )}
    </>
  );
}
```

### Library-Level Code Splitting

```javascript
// ❌ Before: Import entire library
import _ from 'lodash'; // 70KB
import moment from 'moment'; // 300KB

// ✅ After: Import only what you need
import debounce from 'lodash/debounce'; // 2KB
import { format } from 'date-fns'; // 10KB instead of 300KB moment
```

---

## 2. Image Optimization

### Next.js Image Component

```javascript
// ❌ Before: Unoptimized images
<img src="/uploads/photo.jpg" alt="Photo" />

// ✅ After: Optimized with Next.js Image
import Image from 'next/image';

<Image
  src="/uploads/photo.jpg"
  alt="Photo"
  width={800}
  height={600}
  loading="lazy"
  placeholder="blur"
  blurDataURL={thumbnailBase64}
  quality={75}
/>
```

**Benefits**:
- Automatic WebP/AVIF conversion
- Responsive sizing
- Lazy loading by default
- Blur-up placeholder

### File Preview Thumbnails

```javascript
// Use our backend preview endpoint with size optimization
function FileThumbnail({ fileId }) {
  return (
    <Image
      src={`/api/v1/files/${fileId}/preview?size=small`}
      alt="Thumbnail"
      width={150}
      height={150}
      loading="lazy"
    />
  );
}
```

### Image CDN Integration

```javascript
// Serve static images from CDN
const CDN_URL = process.env.NEXT_PUBLIC_CDN_URL;

function OptimizedImage({ src, ...props }) {
  const cdnSrc = src.startsWith('http') ? src : `${CDN_URL}${src}`;

  return <Image src={cdnSrc} {...props} />;
}
```

---

## 3. Bundle Size Optimization

### Tree Shaking

**package.json**:
```json
{
  "sideEffects": false
}
```

**webpack.config.js** (if using custom setup):
```javascript
module.exports = {
  mode: 'production',
  optimization: {
    usedExports: true,
    minimize: true,
    splitChunks: {
      chunks: 'all',
      cacheGroups: {
        vendor: {
          test: /[\\/]node_modules[\\/]/,
          name: 'vendors',
          priority: 10
        },
        common: {
          minChunks: 2,
          priority: 5,
          reuseExistingChunk: true
        }
      }
    }
  }
};
```

### Analyze Bundle Size

```bash
# Next.js bundle analyzer
npm install @next/bundle-analyzer

# Add to next.config.js
const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
});

module.exports = withBundleAnalyzer({
  // your config
});

# Analyze
ANALYZE=true npm run build
```

### Remove Unused Dependencies

```bash
# Find unused dependencies
npx depcheck

# Remove dead code
npx unimported
```

---

## 4. Performance Monitoring

### Web Vitals Tracking

```javascript
// pages/_app.js
import { useReportWebVitals } from 'next/web-vitals';

function MyApp({ Component, pageProps }) {
  useReportWebVitals((metric) => {
    // Send to analytics
    console.log(metric);

    // Send to backend
    fetch('/api/v1/metrics/web-vitals', {
      method: 'POST',
      body: JSON.stringify(metric),
      headers: { 'Content-Type': 'application/json' }
    });
  });

  return <Component {...pageProps} />;
}
```

### Custom Performance Marks

```javascript
function FileList() {
  useEffect(() => {
    performance.mark('file-list-start');

    // Load files
    loadFiles().then(() => {
      performance.mark('file-list-end');
      performance.measure(
        'file-list-duration',
        'file-list-start',
        'file-list-end'
      );

      const measure = performance.getEntriesByName('file-list-duration')[0];
      console.log(`File list loaded in ${measure.duration}ms`);
    });
  }, []);
}
```

---

## 5. React Performance Optimization

### Memoization

```javascript
// ❌ Before: Re-renders on every parent update
function FileItem({ file, onDelete }) {
  return <div>{file.name}</div>;
}

// ✅ After: Only re-renders when file changes
const FileItem = memo(function FileItem({ file, onDelete }) {
  return <div>{file.name}</div>;
}, (prevProps, nextProps) => {
  return prevProps.file.id === nextProps.file.id &&
         prevProps.file.name === nextProps.file.name;
});
```

### useMemo for Expensive Computations

```javascript
function FileList({ files }) {
  // ❌ Before: Recalculates on every render
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);

  // ✅ After: Only recalculates when files change
  const totalSize = useMemo(
    () => files.reduce((sum, f) => sum + f.size, 0),
    [files]
  );

  return <div>Total: {formatBytes(totalSize)}</div>;
}
```

### useCallback for Event Handlers

```javascript
function FileManager() {
  const [files, setFiles] = useState([]);

  // ❌ Before: New function created on every render
  const handleDelete = (fileId) => {
    setFiles(files.filter(f => f.id !== fileId));
  };

  // ✅ After: Function reference stable between renders
  const handleDelete = useCallback((fileId) => {
    setFiles(prev => prev.filter(f => f.id !== fileId));
  }, []);

  return files.map(file => (
    <FileItem key={file.id} file={file} onDelete={handleDelete} />
  ));
}
```

### Virtual Scrolling for Large Lists

```javascript
import { FixedSizeList } from 'react-window';

function FileList({ files }) {
  // ❌ Before: Renders all 10,000 files
  // return files.map(file => <FileItem key={file.id} file={file} />);

  // ✅ After: Only renders visible items
  const Row = ({ index, style }) => (
    <div style={style}>
      <FileItem file={files[index]} />
    </div>
  );

  return (
    <FixedSizeList
      height={600}
      itemCount={files.length}
      itemSize={60}
      width="100%"
    >
      {Row}
    </FixedSizeList>
  );
}
```

**Impact**: 10,000 items: 5000ms → 50ms (100x improvement)

---

## 6. API Request Optimization

### Request Deduplication

```javascript
import { useQuery } from '@tanstack/react-query';

// ❌ Before: Multiple components = multiple requests
function Component1() {
  const { data } = useFetch('/api/v1/files');
}

function Component2() {
  const { data } = useFetch('/api/v1/files'); // Duplicate request!
}

// ✅ After: Single request shared between components
function Component1() {
  const { data } = useQuery(['files'], () =>
    fetch('/api/v1/files').then(r => r.json())
  );
}

function Component2() {
  const { data } = useQuery(['files'], () =>
    fetch('/api/v1/files').then(r => r.json())
  ); // Uses cached data!
}
```

### Prefetching

```javascript
import { useQueryClient } from '@tanstack/react-query';

function FileListItem({ file }) {
  const queryClient = useQueryClient();

  const prefetchFileDetails = () => {
    queryClient.prefetchQuery(['file', file.id], () =>
      fetch(`/api/v1/files/${file.id}`).then(r => r.json())
    );
  };

  return (
    <div onMouseEnter={prefetchFileDetails}>
      {file.name}
    </div>
  );
}
```

### Batch API Requests

```javascript
// ❌ Before: N requests for N files
async function checkFavorites(fileIds) {
  return Promise.all(
    fileIds.map(id => fetch(`/api/v1/favorites/${id}`))
  ); // 100 files = 100 requests!
}

// ✅ After: Single batch request
async function checkFavorites(fileIds) {
  return fetch('/api/v1/favorites/batch', {
    method: 'POST',
    body: JSON.stringify({ file_ids: fileIds })
  }); // 100 files = 1 request!
}
```

---

## 7. Caching Strategies

### React Query Cache

```javascript
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      cacheTime: 10 * 60 * 1000, // 10 minutes
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <YourApp />
    </QueryClientProvider>
  );
}
```

### Service Worker Caching

```javascript
// public/sw.js
const CACHE_NAME = 'edge-storage-v1';
const urlsToCache = [
  '/',
  '/static/css/main.css',
  '/static/js/main.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => response || fetch(event.request))
  );
});
```

---

## 8. Compression & Minification

### Gzip/Brotli Compression

**next.config.js**:
```javascript
module.exports = {
  compress: true, // Enable gzip

  webpack(config) {
    config.plugins.push(
      new CompressionPlugin({
        algorithm: 'brotliCompress',
        test: /\.(js|css|html|svg)$/,
        threshold: 10240,
        minRatio: 0.8,
      })
    );
    return config;
  },
};
```

### CSS Optimization

```javascript
// Install
npm install @next/bundle-analyzer postcss-preset-env

// postcss.config.js
module.exports = {
  plugins: {
    'postcss-preset-env': {
      stage: 3,
      features: {
        'nesting-rules': true,
      },
    },
    'cssnano': {
      preset: ['default', {
        discardComments: { removeAll: true },
      }],
    },
  },
};
```

---

## 9. Server-Side Rendering (SSR) Optimization

### Static Generation

```javascript
// ❌ Before: Rendered on every request (SSR)
export async function getServerSideProps() {
  const files = await fetch('/api/v1/files').then(r => r.json());
  return { props: { files } };
}

// ✅ After: Pre-rendered at build time (SSG)
export async function getStaticProps() {
  const files = await fetch('/api/v1/files').then(r => r.json());
  return {
    props: { files },
    revalidate: 60, // ISR: Regenerate every 60 seconds
  };
}
```

### Incremental Static Regeneration (ISR)

```javascript
export async function getStaticProps() {
  const data = await fetchData();

  return {
    props: { data },
    revalidate: 10, // Regenerate page every 10 seconds
  };
}

export async function getStaticPaths() {
  return {
    paths: [],
    fallback: 'blocking', // Generate on-demand
  };
}
```

---

## 10. Resource Hints

### Preload Critical Resources

```javascript
// pages/_document.js
import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html>
      <Head>
        {/* Preload fonts */}
        <link
          rel="preload"
          href="/fonts/inter-var.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />

        {/* Preconnect to API */}
        <link rel="preconnect" href="https://api.yourdomain.com" />
        <link rel="dns-prefetch" href="https://api.yourdomain.com" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
```

---

## 11. Performance Testing

### Lighthouse CI

```yaml
# .github/workflows/lighthouse.yml
name: Lighthouse CI
on: [push]
jobs:
  lighthouse:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Run Lighthouse CI
        uses: treosh/lighthouse-ci-action@v8
        with:
          urls: |
            https://yourapp.com
            https://yourapp.com/files
          uploadArtifacts: true
```

### Load Testing

```bash
# K6 load test
npm install -g k6

# test.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '1m30s', target: 100 },
    { duration: '20s', target: 0 },
  ],
};

export default function () {
  const res = http.get('https://yourapp.com/api/v1/files');
  check(res, { 'status is 200': (r) => r.status === 200 });
}

# Run
k6 run test.js
```

---

## 12. Implementation Checklist

### Phase 1: Quick Wins (Week 1)
- [x] Enable compression (gzip/brotli)
- [x] Optimize images (Next.js Image)
- [x] Add lazy loading for routes
- [x] Implement React Query caching
- [x] Measure baseline with Lighthouse

### Phase 2: Code Splitting (Week 2)
- [x] Route-based code splitting
- [x] Component lazy loading
- [x] Library tree shaking
- [x] Bundle analysis
- [x] Remove unused dependencies

### Phase 3: React Optimization (Week 3)
- [ ] Add memoization (memo, useMemo, useCallback)
- [ ] Implement virtual scrolling for file lists
- [ ] Optimize re-renders
- [ ] Add React DevTools Profiler
- [ ] Fix performance bottlenecks

### Phase 4: Advanced (Week 4)
- [ ] Service Worker caching
- [ ] CDN integration
- [ ] Prefetching strategies
- [ ] SSG/ISR where appropriate
- [ ] Load testing & validation

---

## 13. Performance Budget

Set strict budgets for frontend assets:

```javascript
// next.config.js
module.exports = {
  webpack(config, { isServer }) {
    if (!isServer) {
      config.performance = {
        maxAssetSize: 250000, // 250KB max
        maxEntrypointSize: 250000,
        hints: 'error',
      };
    }
    return config;
  },
};
```

---

## 14. Monitoring in Production

### Real User Monitoring (RUM)

```javascript
// Track real user performance
if (typeof window !== 'undefined') {
  window.addEventListener('load', () => {
    const perfData = window.performance.timing;
    const pageLoadTime = perfData.loadEventEnd - perfData.navigationStart;

    // Send to analytics
    fetch('/api/v1/metrics/performance', {
      method: 'POST',
      body: JSON.stringify({
        page_load_time: pageLoadTime,
        ttfb: perfData.responseStart - perfData.navigationStart,
        dom_ready: perfData.domContentLoadedEventEnd - perfData.navigationStart,
      }),
    });
  });
}
```

---

## Expected Results

After implementing these optimizations:

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| **Bundle Size** | 800KB | 250KB | **3.2x smaller** |
| **First Load** | 3.0s | 1.0s | **3x faster** |
| **Time to Interactive** | 3.5s | 1.5s | **2.3x faster** |
| **Lighthouse Score** | 60 | 90+ | **+50%** |
| **API Response (Cached)** | 200ms | 10ms | **20x faster** |

---

## Resources

- [Next.js Performance Docs](https://nextjs.org/docs/advanced-features/measuring-performance)
- [Web.dev Performance](https://web.dev/performance/)
- [React DevTools Profiler](https://react.dev/reference/react/Profiler)
- [Bundle Analyzer](https://www.npmjs.com/package/@next/bundle-analyzer)

---

*Last Updated: October 21, 2025*
*Part of Phase 4: Performance Optimization*
