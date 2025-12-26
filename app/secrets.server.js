import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

let secretsCache = null;

// Map AWS secret keys to environment variables
const SECRET_TO_ENV = {
  shopify_api_key: "SHOPIFY_API_KEY",
  shopify_api_secret: "SHOPIFY_API_SECRET",
  scopes: "SCOPES",
  database_url: "DATABASE_URL",
  // Add more mappings here as needed
};

/**
 * Load secrets from AWS Secrets Manager and set as env vars
 */
async function loadSecrets() {
  const secretName = process.env.AWS_APP_SECRET_NAME;
  if (!secretName) return;

  console.log("🚀 Loading secrets from AWS:", secretName);

  try {
    const client = new SecretsManagerClient({
      region: process.env.AWS_REGION || "us-east-1",
    });

    const response = await client.send(
      new GetSecretValueCommand({ SecretId: secretName })
    );

    secretsCache = JSON.parse(response.SecretString);

    // Set env vars from mapping
    for (const [secretKey, envVar] of Object.entries(SECRET_TO_ENV)) {
      if (secretsCache[secretKey]) {
        process.env[envVar] = secretsCache[secretKey];
      }
    }

    console.log("✅ Secrets loaded:", Object.keys(secretsCache));
  } catch (error) {
    console.error("❌ Failed to load secrets:", error.message);
  }
}

// Load secrets at startup (blocks until complete)
await loadSecrets();

// Export for use elsewhere if needed
export function getSecrets() {
  return secretsCache;
}

export function getSecret(key) {
  return secretsCache?.[key] || null;
}
