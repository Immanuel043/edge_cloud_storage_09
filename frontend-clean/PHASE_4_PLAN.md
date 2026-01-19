# Phase 4: Components Layer Migration Plan

**Total Files**: 75 JSX files + supporting JS files
**Target**: Convert all JSX → TSX with proper TypeScript types
**Status**: Starting

---

## Migration Strategy

### Priority Order:
1. **Contexts** (5 files) - Foundation layer
2. **Common Components** (3 files) - Shared utilities
3. **Auth Components** (10 files) - Authentication flow
4. **Dashboard Core** (10 files) - Main dashboard
5. **Dashboard Features** (30 files) - Feature components
6. **Other Components** (12 files) - Remaining components
7. **Main App** (5 files) - Entry points

---

## Phase 4.1: Contexts (Priority 1) ✅ STARTING

### Files to Migrate:
1. `contexts/ThemeContext.jsx` → `.tsx`
2. `contexts/NotificationContext.jsx` → `.tsx`
3. `contexts/AuthContext.jsx` → `.tsx`
4. `contexts/StorageContext.jsx` → `.tsx`
5. `contexts/SubscriptionContext.jsx` → `.tsx`

### Type Definitions Needed:
- Theme configuration types
- Notification types
- User authentication state
- Storage state
- Subscription state

---

## Phase 4.2: Common Components (Priority 2)

### Files:
1. `components/common/ErrorBoundary.jsx`
2. `components/common/OfflineBanner.jsx`
3. `components/common/RecoveryReminder.jsx`

---

## Phase 4.3: Auth Components (Priority 3)

### Files (10):
1. `components/auth/AuthPage.jsx` - Main auth page
2. `components/auth/PasswordStrengthMeter.jsx`
3. `components/auth/VerificationCodeInput.jsx`
4. `components/auth/RecoveryPhraseInput.jsx`
5. `components/auth/RecoveryPhraseSetup.jsx`
6. `components/auth/RecoveryPhraseConfirm.jsx`
7. `components/auth/RecoveryModal.jsx`
8. `components/auth/SessionUnlockModal.jsx`
9. ~~`components/auth/AuthPage_OLD.jsx`~~ (Skip - old file)

---

## Phase 4.4: Dashboard Core (Priority 4)

### Files (10):
1. `components/dashboard/Dashboard.jsx` - Main dashboard
2. `components/dashboard/Sidebar.jsx`
3. `components/dashboard/FileList.jsx`
4. `components/dashboard/FileGrid.jsx`
5. `components/dashboard/FilePreview.jsx`
6. `components/dashboard/UploadProgress.jsx`
7. `components/dashboard/SearchBar.jsx`
8. `components/dashboard/FilterPanel.jsx`
9. `components/dashboard/StorageStats.jsx`
10. `components/dashboard/ZKDashboardLayout.jsx`

---

## Phase 4.5: Dashboard Features (Priority 5)

### View Components (7):
1. `components/dashboard/RecentsView.jsx`
2. `components/dashboard/FavoritesView.jsx`
3. `components/dashboard/SharedWithMeView.jsx`
4. `components/dashboard/TrashView.jsx`
5. `components/dashboard/AnalyticsView.jsx`
6. `components/dashboard/RecommendationsView.jsx`
7. `components/dashboard/SettingsView.jsx`

### Modal Components (8):
1. `components/dashboard/ShareModal.jsx`
2. `components/dashboard/ShareOptionsModal.jsx`
3. `components/dashboard/RenameModal.jsx`
4. `components/dashboard/URLUploadModal.jsx`
5. `components/dashboard/FileCorruptionModal.jsx`

### Feature Components (15):
1. `components/dashboard/SecureVideoPlayer.jsx`
2. `components/dashboard/FileThumbnail.jsx`
3. `components/dashboard/FileDetailsTab.jsx`
4. `components/dashboard/FileActivityTab.jsx`
5. `components/dashboard/FileSecurityTab.jsx`
6. `components/dashboard/FileInfoPanel.jsx`
7. `components/dashboard/BulkActions.jsx`
8. `components/dashboard/QuickFilters.jsx`
9. `components/dashboard/SearchResults.jsx`
10. `components/dashboard/DownloadProgress.jsx`
11. `components/dashboard/VersionHistory.jsx`
12. `components/dashboard/KeyboardShortcuts.jsx`
13. `components/dashboard/ZKEncryptionStatus.jsx`
14. `components/dashboard/ZKStorageStats.jsx`
15. Plus others...

---

## Phase 4.6: Other Components (Priority 6)

### Subscription (3):
1. `components/subscription/SubscriptionDashboard.jsx`
2. `components/subscription/PlanCard.jsx`
3. `components/subscription/PlanChangeModal.jsx`

### Share (3):
1. `components/share/SharePage.jsx`
2. `components/share/ShareViewer.jsx`
3. `components/share/ShareBundleViewer.jsx`

### Settings (1):
1. `components/settings/RecoverySettings.jsx`

### Pricing (1):
1. `components/pricing/PricingPage.jsx`

### Notifications (1):
1. `components/notifications/NotificationToast.jsx`

---

## Phase 4.7: Entry Points (Priority 7)

### Files:
1. `main.jsx` → `main.tsx`
2. `App.jsx` → `App.tsx`

---

## Type Definitions to Create

### Shared Types (`src/types/`):
- `components.d.ts` - Shared component prop types
- `context.d.ts` - Context types
- `hooks.d.ts` - Custom hook types

### Patterns to Follow:
```typescript
// Component props
interface ComponentNameProps {
  // Props with proper types
  onAction?: () => void;
  data: DataType;
}

// Event handlers
const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
  // Handler logic
};

// Ref types
const inputRef = useRef<HTMLInputElement>(null);

// Context types
interface ContextValue {
  state: StateType;
  actions: ActionsType;
}
```

---

## Success Criteria

- ✅ All JSX files converted to TSX
- ✅ All props properly typed
- ✅ All event handlers typed
- ✅ All refs typed
- ✅ All context values typed
- ✅ Zero TypeScript errors
- ✅ All components compile successfully

---

## Estimated Scope

- **Total Components**: 75 JSX files
- **Estimated Time**: 3-5 sessions (depending on complexity)
- **Complexity**: Medium-High (React + ZK encryption patterns)

---

**Starting with**: Phase 4.1 - Contexts (5 files)
