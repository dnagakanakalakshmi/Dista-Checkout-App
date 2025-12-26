import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// Cache for secrets to avoid repeated API calls
let secretsCache = null;
let secretsCacheExpiry = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Promise for initial secrets load (used for ensuring secrets are ready)
let initialLoadPromise = null;

/**
 * Get AWS Secrets Manager client
 * Uses IAM role credentials when running in EKS, or AWS credentials from environment
 */
function getSecretsManagerClient() {
  return new SecretsManagerClient({
    region: process.env.AWS_REGION || "us-east-1",
  });
}

/**
 * Fetch secret from AWS Secrets Manager
 * @param {string} secretName - Name or ARN of the secret
 * @returns {Promise<Object>} Parsed JSON secret or string value
 */
async function getSecret(secretName) {
  try {
    const client = getSecretsManagerClient();
    const command = new GetSecretValueCommand({
      SecretId: secretName,
    });

    const response = await client.send(command);
    
    // Parse JSON if the secret is a JSON string
    if (response.SecretString) {
      try {
        return JSON.parse(response.SecretString);
      } catch {
        // If not JSON, return as string
        return response.SecretString;
      }
    }

    // If binary secret, decode it
    if (response.SecretBinary) {
      const buff = Buffer.from(response.SecretBinary, "base64");
      return buff.toString("utf-8");
    }

    return null;
  } catch (error) {
    console.error(`Error fetching secret ${secretName}:`, error.message);
    throw error;
  }
}

/**
 * Get all app secrets with caching
 * Uses a single secret per app: "shopify_app_dista_checkout-secrets"
 * Expected keys: shopify_api_key, shopify_api_secret, scopes, database_url, mongo_password, etc.
 * @returns {Promise<Object>} All secret values
 */
export async function getAppSecrets() {
  const secretName = process.env.AWS_APP_SECRET_NAME;
  
  if (!secretName) {
    return null;
  }

  const now = Date.now();
  
  // Return cached secret if still valid
  if (secretsCache && secretsCacheExpiry && now < secretsCacheExpiry) {
    return secretsCache;
  }

  // Fetch fresh secret
  const secret = await getSecret(secretName);
  
  // Cache it
  secretsCache = secret;
  secretsCacheExpiry = now + CACHE_TTL;

  return secret;
}

/**
 * Initialize secrets at app startup - call this before using any secrets
 * Uses top-level await pattern for proper sequencing
 * @returns {Promise<Object|null>} The loaded secrets or null
 */
export async function initializeSecrets() {
  const secretName = process.env.AWS_APP_SECRET_NAME;
  
  if (!secretName) {
    console.log("ℹ️ No AWS_APP_SECRET_NAME configured, using environment variables");
    return null;
  }

  // If already loading, return the existing promise
  if (initialLoadPromise) {
    return initialLoadPromise;
  }

  console.log("=".repeat(60));
  console.log("🚀 App starting - fetching secrets from AWS Secrets Manager...");
  console.log("AWS_APP_SECRET_NAME:", secretName);
  console.log("=".repeat(60));

  initialLoadPromise = getAppSecrets()
    .then((secrets) => {
      console.log("=".repeat(60));
      console.log("🔐 All secrets loaded from AWS Secrets Manager:");
      console.log("=".repeat(60));
      console.log("Secret keys:", Object.keys(secrets || {}));
      // Don't log full secrets in production for security
      if (process.env.NODE_ENV !== "production") {
        console.log("Full secrets:", JSON.stringify(secrets, null, 2));
      }
      console.log("=".repeat(60));
      return secrets;
    })
    .catch((error) => {
      console.error("❌ Failed to fetch secrets from AWS:", error.message);
      console.error("Stack:", error.stack);
      // Don't throw - allow fallback to env vars
      return null;
    });

  return initialLoadPromise;
}

/**
 * Get Shopify API credentials from AWS Secrets Manager or environment variables
 * Expected secret keys: shopify_api_key, shopify_api_secret, scopes
 * @returns {Promise<{apiKey: string, apiSecret: string, scopes: string}>}
 */
export async function getShopifyCredentials() {
  const secretName = process.env.AWS_APP_SECRET_NAME;
  
  if (secretName) {
    try {
      const secret = await getAppSecrets();
      
      if (typeof secret === "object" && secret !== null) {
        return {
          apiKey: secret.shopify_api_key || "",
          apiSecret: secret.shopify_api_secret || "",
          scopes: secret.scopes || "",
        };
      }
    } catch (error) {
      console.warn(
        "Failed to fetch Shopify credentials from AWS Secrets Manager, falling back to environment variables:",
        error.message
      );
    }
  }

  // Fallback to environment variables
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    apiSecret: process.env.SHOPIFY_API_SECRET || "",
    scopes: process.env.SCOPES || "",
  };
}

/**
 * Get database connection string from AWS Secrets Manager or environment variables
 * Expected secret key: database_url
 * @returns {Promise<string>} Database URL
 */
export async function getDatabaseUrl() {
  const secretName = process.env.AWS_APP_SECRET_NAME;
  
  if (secretName) {
    try {
      const secret = await getAppSecrets();
      
      if (typeof secret === "object" && secret !== null && secret.database_url) {
        return secret.database_url;
      }
    } catch (error) {
      console.warn(
        "Failed to fetch database URL from AWS Secrets Manager, falling back to environment variables:",
        error.message
      );
    }
  }

  // Fallback to environment variable
  return process.env.DATABASE_URL || "";
}

/**
 * Get MongoDB password from AWS Secrets Manager or environment variables
 * Expected secret key: mongo_password
 * @returns {Promise<string>} MongoDB password
 */
export async function getMongoPassword() {
  const secretName = process.env.AWS_APP_SECRET_NAME;
  
  if (secretName) {
    try {
      const secret = await getAppSecrets();
      
      if (typeof secret === "object" && secret !== null && secret.mongo_password) {
        return secret.mongo_password;
      }
    } catch (error) {
      console.warn(
        "Failed to fetch MongoDB password from AWS Secrets Manager, falling back to environment variables:",
        error.message
      );
    }
  }

  // Fallback to environment variable
  return process.env.MONGO_PASSWORD || "";
}

/**
 * Get MongoDB connection string from AWS Secrets Manager or environment variables
 * Expected secret key: mongo_url (or constructs from mongo_password)
 * @returns {Promise<string>} MongoDB URL
 */
export async function getMongoDbUrl() {
  const secretName = process.env.AWS_APP_SECRET_NAME;
  
  if (secretName) {
    try {
      const secret = await getAppSecrets();
      
      if (typeof secret === "object" && secret !== null) {
        // First check for full URL
        if (secret.mongo_url) {
          return secret.mongo_url;
        }
      }
    } catch (error) {
      console.warn(
        "Failed to fetch MongoDB URL from AWS Secrets Manager, falling back to environment variables:",
        error.message
      );
    }
  }

  // Fallback to environment variable
  return process.env.MONGODB_URL || process.env.MONGODB_URI || "";
}

/**
 * Clear the secrets cache (useful for testing or forced refresh)
 */
export function clearSecretsCache() {
  secretsCache = null;
  secretsCacheExpiry = null;
  initialLoadPromise = null;
}

// Initialize secrets at module load using top-level await
// This ensures secrets are loaded before any other module can use them
await initializeSecrets();
