# Logo Installation Instructions

## Required File
Save your Edge Cloud Storage logo (the one you shared earlier) to this directory as:

**File name:** `logo.png`

**Path:** `/Users/immanraj/edge-cloud-storage-final-mvp/frontend-clean/public/logo.png`

## Logo Specifications
- **Format:** PNG (with transparent background recommended)
- **Recommended dimensions:** 400x400px or similar square/rectangular format
- **Color:** Should include Pantone PMS 286C (#0033A0) blue as primary color
- **The logo shows:** Cloud with lock icon and "EDGE CLOUD STORAGE" text

## How the Logo is Used
The logo appears in the sidebar at the top and is configured in:
- `frontend-clean/src/components/dashboard/Sidebar.jsx` (line ~73)
- Referenced as `/logo.png` in the public folder

## Fallback
If the logo image fails to load, the sidebar will automatically show:
- A Cloud icon
- "EDGE CLOUD" text

This ensures the app works even without the image file.

##To Add Your Logo
1. Take your logo image file (PNG format)
2. Rename it to `logo.png`
3. Copy it to this directory (`frontend-clean/public/`)
4. Refresh your browser - the logo will appear automatically!
