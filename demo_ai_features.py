#!/usr/bin/env python3
"""
Demo Script for AI-Powered File Analysis Features

This script demonstrates:
1. OCR text extraction from images and PDFs
2. Metadata extraction from various file types
3. Perceptual hashing and similarity detection
4. AI-powered smart tagging
5. Duplicate file detection
6. Full-text search in documents

Usage:
    python demo_ai_features.py [file_path]
"""

import asyncio
import sys
import os
from pathlib import Path

# Add the storage service to path
sys.path.insert(0, str(Path(__file__).parent / 'services' / 'storage-service'))

from app.services.ocr_service import ocr_service
from app.services.metadata_service import metadata_service
from app.services.similarity_service import similarity_service
from app.services.ai_tagging_service import ai_tagging_service


def print_header(title):
    """Print a formatted header"""
    print("\n" + "=" * 80)
    print(f"  {title}")
    print("=" * 80 + "\n")


def print_section(title):
    """Print a section divider"""
    print("\n" + "-" * 80)
    print(f"  {title}")
    print("-" * 80 + "\n")


async def demo_ocr(file_path: str, mime_type: str):
    """Demonstrate OCR capabilities"""
    print_section("OCR Text Extraction")

    with open(file_path, 'rb') as f:
        file_data = f.read()

    print(f"Processing file: {file_path}")
    print(f"MIME type: {mime_type}")
    print(f"File size: {len(file_data):,} bytes")
    print("\nExtracting text...\n")

    result = await ocr_service.extract_text(file_data, mime_type)

    if result['success']:
        print("✅ OCR Successful!")
        print(f"   Engine: {result.get('engine', 'N/A')}")
        print(f"   Method: {result.get('method', 'N/A')}")
        print(f"   Confidence: {result.get('confidence', 0):.1f}%")
        print(f"   Word Count: {result.get('word_count', 0)}")
        print(f"   Page Count: {result.get('page_count', 1)}")

        # Show text preview
        text = result['text']
        if len(text) > 500:
            print(f"\n📄 Extracted Text (first 500 characters):\n")
            print(text[:500] + "...")
        else:
            print(f"\n📄 Extracted Text:\n")
            print(text)
    else:
        print(f"❌ OCR Failed: {result.get('error')}")

    return result


async def demo_metadata(file_path: str, mime_type: str):
    """Demonstrate metadata extraction"""
    print_section("Metadata Extraction")

    with open(file_path, 'rb') as f:
        file_data = f.read()

    filename = os.path.basename(file_path)
    print(f"Extracting metadata from: {filename}\n")

    metadata = await metadata_service.extract_metadata(file_data, mime_type, filename)

    if metadata.get('error'):
        print(f"❌ Error: {metadata['error']}")
        return metadata

    print(f"✅ Metadata extracted successfully!")
    print(f"   Type: {metadata.get('type', 'unknown')}\n")

    # Display relevant metadata based on type
    if metadata.get('type') == 'image':
        print("📷 Image Metadata:")
        print(f"   Format: {metadata.get('format')}")
        print(f"   Dimensions: {metadata.get('width')}x{metadata.get('height')} pixels")
        print(f"   Size: {metadata.get('size_mp')} megapixels")

        if metadata.get('camera_make'):
            print(f"   Camera: {metadata.get('camera_make')} {metadata.get('camera_model')}")
        if metadata.get('date_taken'):
            print(f"   Date Taken: {metadata.get('date_taken')}")
        if metadata.get('gps_latitude'):
            print(f"   GPS: {metadata.get('gps_latitude')}, {metadata.get('gps_longitude')}")

    elif metadata.get('type') == 'pdf':
        print("📄 PDF Metadata:")
        print(f"   Pages: {metadata.get('page_count')}")
        if metadata.get('title'):
            print(f"   Title: {metadata.get('title')}")
        if metadata.get('author'):
            print(f"   Author: {metadata.get('author')}")
        if metadata.get('creation_date'):
            print(f"   Created: {metadata.get('creation_date')}")

    elif metadata.get('type') == 'audio':
        print("🎵 Audio Metadata:")
        duration = metadata.get('duration', 0)
        print(f"   Duration: {int(duration//60)}:{int(duration%60):02d}")
        print(f"   Bitrate: {metadata.get('bitrate')} bps")
        if metadata.get('title'):
            print(f"   Title: {metadata.get('title')}")
        if metadata.get('artist'):
            print(f"   Artist: {metadata.get('artist')}")
        if metadata.get('album'):
            print(f"   Album: {metadata.get('album')}")

    return metadata


async def demo_similarity(file_path: str, mime_type: str):
    """Demonstrate perceptual hashing for similarity detection"""
    print_section("Similarity Detection (Perceptual Hashing)")

    if not mime_type.startswith('image/'):
        print("⚠️  Similarity detection only works for images")
        return None

    with open(file_path, 'rb') as f:
        file_data = f.read()

    print(f"Computing perceptual hashes...\n")

    result = await similarity_service.compute_image_hashes(file_data)

    if result.get('success'):
        print("✅ Hashes computed successfully!")
        print(f"   pHash: {result.get('phash')}")
        print(f"   dHash: {result.get('dhash')}")
        print(f"   wHash: {result.get('whash')}")
        print(f"   Average Hash: {result.get('average_hash')}")
        print(f"   Color Hash: {result.get('colorhash')}")

        print("\n💡 These hashes can be used to:")
        print("   • Find similar/duplicate images")
        print("   • Detect edited versions of the same photo")
        print("   • Compare images across your storage")
        print("   • Deduplicate your image library")
    else:
        print(f"❌ Failed: {result.get('error')}")

    return result


async def demo_ai_tagging(file_path: str, mime_type: str, ocr_text: str = None, metadata: dict = None):
    """Demonstrate AI-powered smart tagging"""
    print_section("AI-Powered Smart Tagging")

    with open(file_path, 'rb') as f:
        file_data = f.read()

    filename = os.path.basename(file_path)
    print(f"Generating smart tags for: {filename}\n")

    tags = await ai_tagging_service.generate_smart_tags(
        file_data=file_data,
        mime_type=mime_type,
        filename=filename,
        extracted_text=ocr_text,
        metadata=metadata
    )

    if tags:
        print(f"✅ Generated {len(tags)} smart tags:\n")

        # Group by source
        by_source = {}
        for tag in tags:
            source = tag['source']
            if source not in by_source:
                by_source[source] = []
            by_source[source].append(tag)

        # Display by source
        for source, source_tags in by_source.items():
            print(f"  {source.upper()}:")
            for tag in source_tags:
                confidence = tag['confidence']
                emoji = "🟢" if confidence >= 80 else "🟡" if confidence >= 60 else "🟠"
                print(f"    {emoji} {tag['tag']} ({confidence:.0f}% confidence)")
            print()
    else:
        print("⚠️  No tags generated")

    return tags


async def demo_complete_analysis(file_path: str):
    """Run complete analysis on a file"""
    print_header(f"AI-Powered File Analysis Demo")

    # Detect file type
    if not os.path.exists(file_path):
        print(f"❌ File not found: {file_path}")
        return

    # Simple MIME type detection
    ext = os.path.splitext(file_path)[1].lower()
    mime_map = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
    }
    mime_type = mime_map.get(ext, 'application/octet-stream')

    print(f"File: {file_path}")
    print(f"Type: {mime_type}")
    print(f"Size: {os.path.getsize(file_path):,} bytes")

    # 1. Metadata Extraction
    metadata = await demo_metadata(file_path, mime_type)

    # 2. OCR (if applicable)
    ocr_result = None
    if mime_type.startswith('image/') or mime_type == 'application/pdf':
        ocr_result = await demo_ocr(file_path, mime_type)

    # 3. Similarity Detection (images only)
    if mime_type.startswith('image/'):
        await demo_similarity(file_path, mime_type)

    # 4. AI Tagging
    ocr_text = ocr_result.get('text') if ocr_result and ocr_result.get('success') else None
    await demo_ai_tagging(file_path, mime_type, ocr_text, metadata)

    print_header("Analysis Complete! 🎉")

    # Summary
    print("📊 Summary:")
    print(f"   ✅ Metadata: {'Extracted' if metadata else 'N/A'}")
    print(f"   ✅ OCR: {'Extracted {0} words'.format(ocr_result.get('word_count', 0)) if ocr_result and ocr_result.get('success') else 'N/A'}")
    print(f"   ✅ Similarity: {'Hashes computed' if mime_type.startswith('image/') else 'N/A (images only)'}")
    print(f"   ✅ AI Tags: Generated")

    print("\n💡 Next Steps:")
    print("   • Upload this file to the storage system")
    print("   • Automatic analysis will run in the background")
    print("   • Search for the file using extracted text")
    print("   • Find similar files using perceptual hashing")
    print("   • Filter files by AI-generated tags")


async def demo_comparison():
    """Demonstrate comparing two images"""
    print_header("Image Similarity Comparison Demo")

    print("This demo shows how to compare two images for similarity.\n")
    print("To compare two images, you need:")
    print("  1. Compute hashes for both images")
    print("  2. Calculate Hamming distance between hashes")
    print("  3. Interpret the distance:\n")

    print("  Distance | Similarity")
    print("  ---------|------------")
    print("  0-5      | Near identical (likely same image)")
    print("  5-10     | Very similar (edited version or crop)")
    print("  10-20    | Similar (same subject, different angle)")
    print("  >20      | Different images")

    print("\n💡 Use Case Example:")
    print("  • You upload a photo to your storage")
    print("  • System computes hashes automatically")
    print("  • When you upload another photo:")
    print("    - System compares hashes with existing photos")
    print("    - Finds duplicates or similar images")
    print("    - Suggests: 'You have 3 similar photos. Keep or delete?'")
    print("  • Save storage space by removing duplicates!")


async def demo_duplicate_detection():
    """Demonstrate duplicate detection across multiple files"""
    print_header("Duplicate Detection Demo")

    print("This demo shows how to find duplicate images in your storage.\n")
    print("The system will:")
    print("  1. Compute perceptual hashes for all images")
    print("  2. Compare every hash with every other hash")
    print("  3. Group images with similar hashes (distance ≤ 5)")
    print("  4. Report duplicate groups\n")

    print("Example Output:")
    print("  Found 3 duplicate groups:")
    print("  ")
    print("  Group 1 (3 files):")
    print("    • vacation_photo_1.jpg (8.5 MB)")
    print("    • vacation_photo_1_edited.jpg (8.7 MB)")
    print("    • IMG_2023_copy.jpg (8.5 MB)")
    print("  ")
    print("  Group 2 (2 files):")
    print("    • screenshot_1.png (2.1 MB)")
    print("    • screenshot_1_resized.png (1.8 MB)")
    print("  ")
    print("  💾 Potential savings: 19.1 MB")


async def main():
    """Main demo function"""
    if len(sys.argv) > 1:
        file_path = sys.argv[1]
        await demo_complete_analysis(file_path)
    else:
        print_header("AI-Powered File Analysis System - Demo")

        print("This demo showcases the AI-powered file analysis features:")
        print()
        print("  1. 🔍 OCR Text Extraction")
        print("     Extract searchable text from images and PDFs")
        print()
        print("  2. 📋 Metadata Extraction")
        print("     Extract EXIF, ID3, and document properties")
        print()
        print("  3. 🎨 Perceptual Hashing")
        print("     Compute hashes for similarity detection")
        print()
        print("  4. 🤖 AI Smart Tagging")
        print("     Automatically tag files using AI/ML")
        print()
        print("  5. 🔎 Duplicate Detection")
        print("     Find near-duplicate images")
        print()
        print("  6. 📊 Full-Text Search")
        print("     Search within scanned documents")
        print()

        print("\n" + "=" * 80)
        print("Usage:")
        print("=" * 80)
        print()
        print("  Analyze a file:")
        print("    python demo_ai_features.py <file_path>")
        print()
        print("  Examples:")
        print("    python demo_ai_features.py photo.jpg")
        print("    python demo_ai_features.py document.pdf")
        print("    python demo_ai_features.py invoice.png")
        print()

        print("\n" + "=" * 80)
        print("Feature Demos:")
        print("=" * 80)
        print()

        # Run concept demos
        await demo_comparison()
        await demo_duplicate_detection()

        print("\n" + "=" * 80)
        print("API Endpoints Available:")
        print("=" * 80)
        print()
        print("  POST   /api/v1/files/{file_id}/analyze")
        print("         Trigger full analysis (OCR + metadata + hashing + tags)")
        print()
        print("  GET    /api/v1/files/{file_id}/ocr")
        print("         Get extracted text from file")
        print()
        print("  GET    /api/v1/files/{file_id}/metadata")
        print("         Get extended metadata")
        print()
        print("  GET    /api/v1/files/{file_id}/tags")
        print("         Get AI-generated and manual tags")
        print()
        print("  POST   /api/v1/files/{file_id}/tags")
        print("         Add a manual tag")
        print()
        print("  GET    /api/v1/files/{file_id}/similar")
        print("         Find similar files (images)")
        print()
        print("  POST   /api/v1/files/duplicates")
        print("         Find all duplicate groups")
        print()
        print("  GET    /api/v1/files/search/ocr?q=text")
        print("         Search within OCR text")
        print()
        print("  GET    /api/v1/files/search/tags/{tag}")
        print("         Find all files with a specific tag")
        print()

        print("\n" + "=" * 80)
        print("Try it with your own files!")
        print("=" * 80)
        print()
        print("  python demo_ai_features.py /path/to/your/file.pdf")
        print()


if __name__ == "__main__":
    asyncio.run(main())
