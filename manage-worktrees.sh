#!/bin/bash

# Git Worktree Management Script for Cursor
# This script helps you view, inspect, and clean up Git worktrees

set -e

WORKTREE_DIR="$HOME/.cursor/worktrees/edge-cloud-storage-final-mvp"

echo "=== Git Worktree Manager ==="
echo ""

# Function to list all worktrees with details
list_worktrees() {
    echo "📋 All Worktrees:"
    echo ""
    git worktree list
    echo ""
    echo "Total: $(git worktree list | wc -l | tr -d ' ') worktrees"
}

# Function to show worktree details
show_details() {
    echo "📊 Worktree Details:"
    echo ""
    while IFS= read -r line; do
        if [[ $line == *"worktrees"* ]]; then
            path=$(echo "$line" | awk '{print $1}')
            branch=$(echo "$line" | awk '{print $2}' | tr -d '[]')
            commit=$(echo "$line" | awk '{print $3}')
            
            # Get last modified time
            if [ -d "$path" ]; then
                modified=$(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$path" 2>/dev/null || stat -c "%y" "$path" 2>/dev/null | cut -d' ' -f1-2)
                
                # Check for uncommitted changes
                cd "$path" 2>/dev/null
                if git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
                    status="✅ clean"
                else
                    status="⚠️  has changes"
                fi
                cd - > /dev/null
                
                echo "  $path"
                echo "    Branch: $branch | Commit: $commit"
                echo "    Modified: $modified | Status: $status"
                echo ""
            fi
        fi
    done < <(git worktree list)
}

# Function to clean up old worktrees
cleanup_old() {
    echo "🧹 Cleaning up old worktrees..."
    echo ""
    
    count=0
    while IFS= read -r line; do
        if [[ $line == *"worktrees"* ]]; then
            path=$(echo "$line" | awk '{print $1}')
            
            if [ -d "$path" ]; then
                # Check if worktree has uncommitted changes
                cd "$path" 2>/dev/null
                if git diff --quiet 2>/dev/null && git diff --cached --quiet 2>/dev/null; then
                    # Safe to remove
                    echo "  Removing: $path"
                    git worktree remove "$path" --force 2>/dev/null || rm -rf "$path"
                    ((count++))
                else
                    echo "  Skipping (has changes): $path"
                fi
                cd - > /dev/null
            fi
        fi
    done < <(git worktree list)
    
    echo ""
    echo "✅ Removed $count worktrees"
}

# Function to show worktrees with changes
show_with_changes() {
    echo "⚠️  Worktrees with uncommitted changes:"
    echo ""
    
    found=false
    while IFS= read -r line; do
        if [[ $line == *"worktrees"* ]]; then
            path=$(echo "$line" | awk '{print $1}')
            
            if [ -d "$path" ]; then
                cd "$path" 2>/dev/null
                if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
                    echo "  $path"
                    git status --short
                    echo ""
                    found=true
                fi
                cd - > /dev/null
            fi
        fi
    done < <(git worktree list)
    
    if [ "$found" = false ]; then
        echo "  ✅ All worktrees are clean"
    fi
}

# Main menu
case "${1:-list}" in
    list)
        list_worktrees
        ;;
    details)
        show_details
        ;;
    cleanup)
        cleanup_old
        ;;
    changes)
        show_with_changes
        ;;
    *)
        echo "Usage: $0 [list|details|cleanup|changes]"
        echo ""
        echo "Commands:"
        echo "  list     - List all worktrees (default)"
        echo "  details  - Show detailed information about each worktree"
        echo "  cleanup  - Remove worktrees without uncommitted changes"
        echo "  changes  - Show worktrees with uncommitted changes"
        exit 1
        ;;
esac
