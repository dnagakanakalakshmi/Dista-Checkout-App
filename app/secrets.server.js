import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// Cache for secrets to avoid repeated API calls
let secretsCache = null;
let secretsCacheExpiry = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
  const secretName = "shopify-app-dista-checkout";
  
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
 * Get Shopify API credentials from AWS Secrets Manager or environment variables
 * Expected secret keys: shopify_api_key, shopify_api_secret, scopes
 * @returns {Promise<{apiKey: string, apiSecret: string, scopes: string}>}
 */
export async function getShopifyCredentials() {
  const secretName = "shopify-app-dista-checkout";
  
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
  const secretName = "shopify-app-dista-checkout";
  
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
  const secretName = "shopify-app-dista-checkout";
  
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
  const secretName = "shopify-app-dista-checkout";
  
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
}
