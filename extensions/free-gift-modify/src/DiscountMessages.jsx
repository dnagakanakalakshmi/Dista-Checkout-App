import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export default function extension() {
  render(<DiscountMessages />, document.body);
}

function DiscountMessages() {
  console.log("DiscountMessages render");
  const discountCodes = shopify.discountCodes.value;
  const discountAllocations = shopify.discountAllocations.value;
  console.log('discountCodes:', discountCodes);
  console.log('discountAllocations:', discountAllocations);
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    async function fetchDiscountInfo() {
      try {
        const { data } = await shopify.query(`
          {
            metaobjects(type: "discount_info", first: 250) {
              nodes {
                fields {
                  key
                  value
                }
              }
            }
          }
        `);

        if (data?.metaobjects?.nodes) {
          const parsed = data.metaobjects.nodes.map((node) =>
            Object.fromEntries(
              node.fields.map(({ key, value }) => [key, value]),
            ),
          );
          setEntries(parsed);
        }
      } catch (_err) {
        // Fail silently -- Shopify's default behaviour takes over
      }
    }

    fetchDiscountInfo();
  }, []);

  if (!discountCodes.length || !entries.length) return null;

  // A code only actually discounted something if there's a matching
  // 'code' type allocation. `CartDiscountCode` itself has no
  // `applicable` field in this API, so we infer it this way.
  const appliedCodesWithEffect = new Set(
    discountAllocations
      .filter((a) => a.type === 'code')
      .map((a) => a.code),
  );

  return (
    <>
      {discountCodes.map(({ code }) => {
        const applicable = appliedCodesWithEffect.has(code);
        const match = findMatch(code, entries);

        // No metaobject entry for this code -- let Shopify handle it natively
        if (!match) return null;

        const message = applicable ? match.description : match.error_message;

        // If the matched entry has no text for this state, do nothing
        if (!message) return null;

        return (
          <s-banner key={code} tone={applicable ? 'success' : 'critical'}>
            {message}
          </s-banner>
        );
      })}
    </>
  );
}

/**
 * Finds the best matching metaobject entry for a given discount code.
 *
 * Priority:
 * 1. Exact match   -- match_type === "exact" and code_or_prefix === entered code
 * 2. Prefix match  -- match_type === "prefix" and code starts with code_or_prefix
 *                     If multiple prefixes match, the longest one wins
 *
 * All comparisons are case-insensitive.
 *
 * @param {string} code
 * @param {Array<Object>} entries
 * @returns {Object|null}
 */
function findMatch(code, entries) {
  const normalized = code.toUpperCase().trim();

  // --- 1. Exact match ---
  const exactMatch = entries.find(
    (entry) =>
      entry.match_type === 'exact' &&
      entry.code_or_prefix?.toUpperCase().trim() === normalized,
  );

  if (exactMatch) return exactMatch;

  // --- 2. Prefix match (longest prefix wins to avoid false partial matches) ---
  const prefixMatches = entries.filter(
    (entry) =>
      entry.match_type === 'prefix' &&
      entry.code_or_prefix &&
      normalized.startsWith(entry.code_or_prefix.toUpperCase().trim()),
  );

  if (!prefixMatches.length) return null;

  return prefixMatches.reduce((best, current) =>
    current.code_or_prefix.length > best.code_or_prefix.length
      ? current
      : best,
  );
}