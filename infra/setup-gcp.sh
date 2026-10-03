#!/usr/bin/env bash
# One-time Google Cloud setup for ShrinkSight. Run in Cloud Shell as a project Owner.
# Safe to re-run: every step skips resources that already exist.
#
#   bash setup-gcp.sh
#
# Creates: Artifact Registry repo (+cleanup), 2 service accounts with minimal roles,
# evidence bucket (24h lifecycle), Gemini secret (hidden input), keyless GitHub -> GCP trust (WIF).
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-shrinksight-app}"
REGION="us-central1"
GITHUB_REPO="${GITHUB_REPO:-akshatjain-akj/shrinksight}"
AR_REPO="shrinksight"
DEPLOYER="shrinksight-deployer"
RUNTIME="shrinksight-runtime"
BUCKET="${PROJECT_ID}-evidence"
SECRET="gemini-api-key"
POOL="github"
PROVIDER="github-oidc"

DEPLOYER_SA="${DEPLOYER}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA="${RUNTIME}@${PROJECT_ID}.iam.gserviceaccount.com"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
exists() { "$@" >/dev/null 2>&1; }

gcloud config set project "$PROJECT_ID" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
echo "Project: $PROJECT_ID ($PROJECT_NUMBER) · Region: $REGION · Repo: $GITHUB_REPO"

step "1/7 Enabling APIs (idempotent)"
gcloud services enable \
  run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com \
  firestore.googleapis.com storage.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com cloudresourcemanager.googleapis.com firebase.googleapis.com \
  firebasehosting.googleapis.com firebaserules.googleapis.com identitytoolkit.googleapis.com

step "2/7 Artifact Registry repo '$AR_REPO' (keeps the 5 newest images)"
if ! exists gcloud artifacts repositories describe "$AR_REPO" --location "$REGION"; then
  gcloud artifacts repositories create "$AR_REPO" --repository-format=docker --location "$REGION" \
    --description "ShrinkSight container images"
fi
POLICY_FILE="$(mktemp)"
cat >"$POLICY_FILE" <<'JSON'
[
  {"name": "keep-newest-5", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 5}},
  {"name": "delete-older-than-1d", "action": {"type": "Delete"}, "condition": {"olderThan": "86400s"}}
]
JSON
gcloud artifacts repositories set-cleanup-policies "$AR_REPO" --location "$REGION" \
  --policy "$POLICY_FILE" --no-dry-run >/dev/null
rm -f "$POLICY_FILE"

step "3/7 Service accounts"
for SA in "$DEPLOYER" "$RUNTIME"; do
  if ! exists gcloud iam service-accounts describe "${SA}@${PROJECT_ID}.iam.gserviceaccount.com"; then
    gcloud iam service-accounts create "$SA" --display-name "$SA"
  fi
done

step "4/7 Roles (least privilege)"
for ROLE in roles/run.admin roles/firebasehosting.admin roles/firebaserules.admin roles/firebase.viewer \
            roles/serviceusage.serviceUsageConsumer roles/serviceusage.serviceUsageViewer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$DEPLOYER_SA" \
    --role "$ROLE" --condition=None >/dev/null
done
gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" --location "$REGION" \
  --member "serviceAccount:$DEPLOYER_SA" --role roles/artifactregistry.writer >/dev/null
# Deployer may deploy Cloud Run *as* the runtime account, nothing more
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --member "serviceAccount:$DEPLOYER_SA" --role roles/iam.serviceAccountUser >/dev/null
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$RUNTIME_SA" \
  --role roles/datastore.user --condition=None >/dev/null

step "5/7 Evidence bucket gs://$BUCKET (private, objects deleted after 1 day)"
if ! exists gcloud storage buckets describe "gs://$BUCKET"; then
  gcloud storage buckets create "gs://$BUCKET" --location "$REGION" \
    --uniform-bucket-level-access --public-access-prevention
fi
LIFECYCLE_FILE="$(mktemp)"
echo '{"rule": [{"action": {"type": "Delete"}, "condition": {"age": 1}}]}' >"$LIFECYCLE_FILE"
gcloud storage buckets update "gs://$BUCKET" --lifecycle-file "$LIFECYCLE_FILE" >/dev/null
rm -f "$LIFECYCLE_FILE"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$RUNTIME_SA" \
  --role roles/storage.objectAdmin >/dev/null

step "6/7 Gemini API key -> Secret Manager '$SECRET'"
if ! exists gcloud secrets describe "$SECRET"; then
  read -rsp "Paste the Gemini API key from the NO-BILLING project (input hidden): " GEMINI_KEY; echo
  [ -n "$GEMINI_KEY" ] || { echo "Empty key, aborting."; exit 1; }
  printf '%s' "$GEMINI_KEY" | gcloud secrets create "$SECRET" --replication-policy automatic --data-file=-
  unset GEMINI_KEY
else
  echo "Secret already exists (to rotate: gcloud secrets versions add $SECRET --data-file=-)"
fi
gcloud secrets add-iam-policy-binding "$SECRET" --member "serviceAccount:$RUNTIME_SA" \
  --role roles/secretmanager.secretAccessor >/dev/null

step "7/7 Keyless GitHub Actions -> Google Cloud trust (Workload Identity Federation)"
if ! exists gcloud iam workload-identity-pools describe "$POOL" --location global; then
  gcloud iam workload-identity-pools create "$POOL" --location global --display-name "GitHub Actions"
fi
if ! exists gcloud iam workload-identity-pools providers describe "$PROVIDER" --location global \
    --workload-identity-pool "$POOL"; then
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --location global \
    --workload-identity-pool "$POOL" --display-name "GitHub OIDC" \
    --issuer-uri "https://token.actions.githubusercontent.com" \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition "assertion.repository=='${GITHUB_REPO}'"
fi
gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_REPO}" \
  >/dev/null

step "Gemini models visible to this key (pick one for GEMINI_MODEL)"
GEMINI_KEY="$(gcloud secrets versions access latest --secret "$SECRET")"
curl -fsS -H "x-goog-api-key: $GEMINI_KEY" \
  "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200" \
  | grep -o '"name": *"models/[^"]*flash[^"]*"' | sed 's/.*models\//  /; s/"$//' || echo "  (could not list models)"
unset GEMINI_KEY

cat <<EOF

Done. Add these as GitHub repository VARIABLES (not secrets):
  Repo → Settings → Secrets and variables → Actions → Variables tab → New repository variable

  GCP_PROJECT_ID   = $PROJECT_ID
  WIF_PROVIDER     = projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/providers/$PROVIDER
  DEPLOYER_SA      = $DEPLOYER_SA
  RUNTIME_SA       = $RUNTIME_SA
  EVIDENCE_BUCKET  = $BUCKET
  GEMINI_MODEL     = <a flash-lite model id from the list above, e.g. gemini-3.5-flash-lite>
EOF
