#!/bin/sh
# Get a list of files modified by Claude/Staged for commit
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$STAGED_FILES" ]; then
    exit 0
fi

echo "🔄 Claude modified files detected. Running SonarQube complexity check..."

# Trigger a fast local SonarLint scan or local sonar-scanner container
# (Ensures Claude's code adheres to the Connected Mode Quality Profile)
sonar-scanner \
  -Dsonar.host.url=http://your-sonarqube-server \
  -Dsonar.token=$SONAR_TOKEN \
  -Dsonar.inclusions=$(echo "$STAGED_FILES" | paste -sd "," -) \
  -Dsonar.qualitygate.wait=true

# If SonarQube quality gate fails (complexity too high), reject the commit
if [ $? -ne 0 ]; then
    echo "❌ SonarQube Quality Gate Failed! Claude's changes are too complex."
    exit 1
fi
