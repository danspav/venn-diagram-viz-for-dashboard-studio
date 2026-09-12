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
export VIRTUAL_ENV="true"


echo "Activating virtual environment..."
source ./.venv/bin/activate


SOURCE_DIR="$GIT_HOME/$APP_DIRECTORY_NAME/stage/${APP_DIRECTORY_NAME//-/_}"
TARGET_DIR="$SPLUNK_HOME/etc/apps/${APP_DIRECTORY_NAME//-/_}"

echo "========================================"
echo "Building Splunk App: $APP_DIRECTORY_NAME"
echo "========================================"

# -----------------------------
# Step 1: Yarn build
# -----------------------------
echo ">> Running yarn build"
yarn build:prod

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
