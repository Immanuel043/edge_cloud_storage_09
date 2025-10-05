# OCR and File Similarity Features

## Overview

We've implemented comprehensive file analysis features including OCR text extraction, metadata extraction, and similar file detection using perceptual hashing.

## Features Implemented

### 1. **OCR Service** ([ocr_service.py](../services/storage-service/app/services/ocr_service.py))

**Capabilities:**
- Extract text from images using Tesseract OCR or EasyOCR
- Extract text from PDFs (multiple methods):
  - PyMuPDF for text-based PDFs (fastest)
  - pdfplumber for complex layouts
  - OCR for scanned PDFs (automatic fallback)
- Support for plain text files
- Multi-language support
- Confidence scoring

**Engines:**
- **Tesseract OCR**: Fast, supports 100+ languages, good accuracy
- **EasyOCR**: Better accuracy, GPU support, slower

**Example Usage:**
```python
from app.services.ocr_service import ocr_service

# Extract from image
result = await ocr_service.extract_text_from_image(image_bytes)
# Returns: {success, text, confidence, word_count, engine, languages}

# Extract from PDF
result = await ocr_service.extract_text_from_pdf(pdf_bytes)
# Returns: {success, text, word_count, page_count, method, confidence}
```

### 2. **Metadata Extraction Service** ([metadata_service.py](../services/storage-service/app/services/metadata_service.py))

**Supported File Types:**

#### Images (JPEG, PNG, etc.)
- EXIF data (camera, settings, GPS)
- Dimensions, resolution
- Date taken
- Camera make/model
- Focal length, ISO, Flash

#### PDFs
- Title, author, subject
- Page count, dimensions
- Creation/modification dates
- Creator software
- Encryption status

#### Audio Files (MP3, FLAC, etc.)
- ID3 tags (title, artist, album)
- Duration, bitrate, sample rate
- Genre, year
- Number of channels

#### Video Files
- Dimensions (width/height)
- FPS, frame count
- Duration
- Codec information

#### Documents (DOCX)
- Title, author, subject
- Word count, paragraph count
- Creation/modification dates
- Revision number

**Example Usage:**
```python
from app.services.metadata_service import metadata_service

metadata = await metadata_service.extract_metadata(
    file_data=file_bytes,
    mime_type="image/jpeg",
    filename="photo.jpg"
)
# Returns comprehensive metadata dict
```

### 3. **Similarity Detection Service** ([similarity_service.py](../services/storage-service/app/services/similarity_service.py))

**Algorithms:**

#### Perceptual Hashing (for images)
- **pHash**: Perceptual hash - robust to minor edits
- **dHash**: Difference hash - detects cropping/resizing
- **wHash**: Wavelet hash - good for scaled images
- **Average Hash**: Simple and fast
- **Color Hash**: Detects color similarity

#### SSIM (Structural Similarity Index)
- More accurate pixel-by-pixel comparison
- Slower but better quality

#### Text Similarity (TF-IDF)
- Document similarity using vector comparison
- Cosine similarity scoring

**Features:**
- Find similar images with threshold control
- Detect duplicate images
- Calculate similarity percentage
- Batch duplicate detection

**Example Usage:**
```python
from app.services.similarity_service import similarity_service

# Compute hashes for an image
hashes = await similarity_service.compute_image_hashes(image_bytes)
# Returns: {phash, dhash, whash, average_hash, colorhash}

# Find similar images
similar = await similarity_service.find_similar_images(
    image_data=query_image,
    all_image_hashes=stored_hashes,
    threshold=10  # Hamming distance
)
# Returns list of similar files with similarity scores

# Find all duplicates
duplicates = await similarity_service.find_duplicate_images(
    all_image_hashes=all_hashes,
    threshold=5
)
# Returns groups of duplicate images
```

## Database Schema

### New Tables Added:

#### `file_ocr`
Stores extracted text from files
```sql
- id (UUID)
- file_id (FK to objects)
- extracted_text (Text)
- word_count (Integer)
- confidence (Integer 0-100)
- ocr_engine (String)
- languages (JSON array)
- page_count (Integer)
- extraction_method (String)
- created_at, updated_at
```

#### `file_metadata_extended`
Stores rich metadata for all file types
```sql
- id (UUID)
- file_id (FK to objects)
- metadata_type (image/pdf/audio/video/document)
- raw_metadata (JSONB) - full metadata
- width, height (for images/videos)
- duration (for audio/video)
- page_count (for PDFs)
- camera_make, camera_model, date_taken, gps_* (images)
- artist, album, title, genre, bitrate (audio)
- author, word_count (documents)
- created_at, updated_at
```

#### `file_hashes`
Stores perceptual hashes for similarity detection
```sql
- id (UUID)
- file_id (FK to objects)
- phash, dhash, whash, average_hash, colorhash (String)
- text_hash (for documents)
- created_at
```

## Dependencies Added

```
# OCR
pytesseract>=0.3.10
easyocr>=1.7.0
pdfplumber>=0.10.0
PyPDF2>=3.0.0

# Metadata
mutagen>=1.47.0
python-magic>=0.4.27

# Similarity Detection
imagehash>=4.3.1
scikit-learn>=1.3.0
scipy>=1.11.0
numpy>=1.24.0
```

## System Requirements

For OCR to work, Tesseract must be installed on the system:

### Ubuntu/Debian:
```bash
apt-get update && apt-get install -y tesseract-ocr tesseract-ocr-eng
```

### macOS:
```bash
brew install tesseract
```

### Docker:
Will be added to Dockerfile automatically.

## Performance Considerations

### OCR
- **CPU Intensive**: Uses ThreadPoolExecutor with 4 workers
- **Async Support**: All operations are async
- **Lazy Loading**: EasyOCR models loaded on first use
- **PDF Limits**: OCR max 10 pages by default (configurable)

### Similarity Detection
- **Image Hashing**: ~100ms per image
- **SSIM**: ~500ms per comparison (more accurate)
- **Batch Processing**: Use for duplicate detection
- **Threshold Tuning**:
  - 0-5: Near identical
  - 5-10: Very similar
  - 10-20: Similar
  - >20: Different

### Metadata Extraction
- **Fast**: Usually <100ms
- **No External Dependencies**: Uses built-in libraries
- **Comprehensive**: Extracts all available metadata

## Use Cases

### 1. **Smart Search**
- Search within scanned documents
- Find files by extracted text
- Filter by metadata (camera, author, etc.)

### 2. **Duplicate Detection**
- Find duplicate/similar images
- Detect near-duplicates (edited versions)
- Save storage space

### 3. **Organization**
- Auto-tag by metadata
- Group similar files
- Sort by date taken (photos)

### 4. **Content Analysis**
- Extract information from receipts
- Index PDF documents
- Catalog music/video libraries

## Next Steps

### TODO:
1. ✅ Create OCR service
2. ✅ Create metadata service
3. ✅ Create similarity service
4. ✅ Add database models
5. ⏳ Update Dockerfile with Tesseract
6. ⏳ Create database migration
7. ⏳ Create API endpoints
8. ⏳ Integrate into upload pipeline
9. ⏳ Create frontend UI

### API Endpoints to Create:

```
POST /api/v1/files/{file_id}/ocr
  - Trigger OCR for a file
  - Returns extracted text

GET /api/v1/files/{file_id}/metadata
  - Get extended metadata
  - Returns all extracted metadata

GET /api/v1/files/{file_id}/similar
  - Find similar files
  - Query params: threshold, limit

POST /api/v1/files/find-duplicates
  - Find all duplicate groups
  - Returns groups of similar files

GET /api/v1/search/text
  - Search within OCR text
  - Full-text search across all extracted text
```

### Frontend Features:

1. **OCR Results View**
   - Display extracted text
   - Highlight searchable content
   - Show confidence score

2. **Metadata Panel**
   - Rich metadata display
   - GPS location map
   - Camera/audio details

3. **Similar Files Finder**
   - "Find Similar" button
   - Similarity percentage
   - Visual comparison

4. **Duplicate Manager**
   - Show duplicate groups
   - Keep/delete options
   - Storage savings calculator

## Configuration

Environment variables (optional):
```bash
# OCR Settings
OCR_ENGINE=tesseract  # or easyocr
OCR_LANGUAGES=eng,fra  # Comma-separated
OCR_MAX_PDF_PAGES=10

# Similarity Settings
SIMILARITY_THRESHOLD=10
HASH_SIZE=16

# Feature Toggles
ENABLE_AUTO_OCR=true
ENABLE_AUTO_METADATA=true
ENABLE_AUTO_HASHING=true
```

## Examples

### Full Pipeline Example:
```python
# Upload a file
file_id = await upload_service.upload_file(file_data, user_id)

# Extract OCR
ocr_result = await ocr_service.extract_text(file_data, mime_type)
await db.execute(insert(FileOCR).values(
    file_id=file_id,
    extracted_text=ocr_result["text"],
    confidence=ocr_result["confidence"],
    ...
))

# Extract metadata
metadata = await metadata_service.extract_metadata(file_data, mime_type, filename)
await db.execute(insert(FileMetadata).values(
    file_id=file_id,
    raw_metadata=metadata,
    width=metadata.get("width"),
    ...
))

# Compute hashes (for images)
if mime_type.startswith('image/'):
    hashes = await similarity_service.compute_image_hashes(file_data)
    await db.execute(insert(FileHash).values(
        file_id=file_id,
        phash=hashes["phash"],
        dhash=hashes["dhash"],
        ...
    ))

# Find similar files
similar_files = await similarity_service.find_similar_images(
    file_data,
    all_stored_hashes,
    threshold=10
)
```

## Production Deployment

### Resource Requirements:
- **CPU**: OCR is CPU-intensive, recommend 4+ cores
- **RAM**: EasyOCR models need ~2GB, recommend 8GB total
- **GPU**: Optional, speeds up EasyOCR significantly
- **Storage**: Models ~500MB

### Optimization Tips:
1. Use Tesseract for bulk processing (faster)
2. Use EasyOCR for better accuracy on complex images
3. Process OCR/hashing in background workers
4. Cache results in database
5. Index extracted text in Elasticsearch for fast search

### Monitoring:
- Track OCR success/failure rates
- Monitor processing times
- Alert on confidence drops
- Track duplicate detection savings
