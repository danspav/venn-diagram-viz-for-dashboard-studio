#!/usr/bin/env bash

#set -e  # stop on error

# -----------------------------
# Variables
# -----------------------------
if [ "$(hostname)" = "cannonst" ]; then
    export SPLUNK_HOME="/splunk"
    export GIT_HOME="/splunk/git"
else
    export SPLUNK_HOME="/opt/splunk"
    export GIT_HOME="/opt/git"
fi

export APP_DIRECTORY_NAME=$(basename "$PWD")
export SPLUNK_APP_DIRECTORY_NAME="${APP_DIRECTORY_NAME//-/_}"
export VIRTUAL_ENV="true"

# -----------------------------
# Build mode: ./rebuild.sh [dev|prod] -- defaults to dev (fast, unminified,
# fine for local iteration against your own Splunk instance). Pass "prod"
# before packaging anything meant to be installed elsewhere -- a plain dev
# build ships React's development runtime, which has already caused a real
# "Cannot set properties of undefined (setting 'key')" failure on a fresh
# Splunk instance from a stray internal React dev-mode code path.
BUILD_MODE="${1:-dev}"
if [ "$BUILD_MODE" != "dev" ] && [ "$BUILD_MODE" != "prod" ]; then
    echo "Usage: $0 [dev|prod]"
    echo "  dev  (default) - yarn build, fast, unminified, local iteration only"
    echo "  prod            - yarn build:prod, minified, safe to package/install"
    exit 1
fi


echo "Activating virtual environment..."
source ./.venv/bin/activate


SOURCE_DIR="$GIT_HOME/$APP_DIRECTORY_NAME/stage/$SPLUNK_APP_DIRECTORY_NAME"
TARGET_DIR="$SPLUNK_HOME/etc/apps/$SPLUNK_APP_DIRECTORY_NAME"

echo "========================================"
echo "Building Splunk App: $APP_DIRECTORY_NAME ($BUILD_MODE)"
echo "========================================"

# -----------------------------
# Step 1: Yarn build
# -----------------------------
if [ "$BUILD_MODE" = "prod" ]; then
    echo ">> Running yarn build:prod"
    yarn build:prod
else
    echo ">> Running yarn build"
    yarn build
fi

# -----------------------------
# Step 2: Yarn package
# -----------------------------
echo ">> Running yarn package"
yarn package

# -----------------------------
# Step 3: Create symlink if missing
# -----------------------------
echo ">> Setting up symlink"

if [ ! -e "$TARGET_DIR" ]; then
    echo "Creating symlink:"
    echo "  $TARGET_DIR -> $SOURCE_DIR"
    ln -s "$SOURCE_DIR" "$TARGET_DIR"
else
    echo "Symlink or directory already exists at $TARGET_DIR"
fi

# -----------------------------
# Step 4: Run refresh script
# -----------------------------
echo ">> Running refresh.py"
echo ">> Using Python: $(which python)"
echo ">> Virtual env: ${VIRTUAL_ENV:-none}"

python3 refresh.py

echo "========================================"
echo "Build complete ✔"
echo "========================================"
