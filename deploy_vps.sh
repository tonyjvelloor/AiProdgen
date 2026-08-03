#!/bin/bash

# Configuration
USER="root"
IP="72.61.174.111"
DEST="/var/www/ai-product-catalogue"

# Check if variables are set
if [ -z "$USER" ] || [ -z "$IP" ] || [ -z "$DEST" ]; then
    echo "⚠️  Please edit this script to set USER, IP, and DEST variables first."
    exit 1
fi

echo "🚀 Deploying to $User@$IP:$DEST..."

# 1. Sync Files
# Excludes node_modules (re-install on server), users.db (PERSISTENT DATA), .env (Manual config), and git files
rsync -avz --exclude 'node_modules' \
    --exclude '.git' \
    --exclude '.env' \
    --exclude 'users.db' \
    --exclude 'verify_director_local.js' \
    --exclude 'deploy_vps.sh' \
    ./ $USER@$IP:$DEST

# 2. Remote Commands
echo "📦 Installing dependencies and restarting..."
ssh $USER@$IP << EOF
    cd $DEST
    npm install --production
    pm2 reload ecosystem.config.js || pm2 start ecosystem.config.js
    pm2 save
    echo "Ag Success! Deployment complete."
EOF
