#!/bin/bash
zip -r site_deploy.zip . -x "node_modules/*" -x ".git/*" -x ".env" -x "users.db" -x "*.log"
echo "✅ site_deploy.zip created. Upload this to hPanel."
