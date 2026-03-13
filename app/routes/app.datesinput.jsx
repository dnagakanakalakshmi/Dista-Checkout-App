import { json } from '@remix-run/node';
import { useLoaderData, useActionData, Form } from '@remix-run/react';
import { authenticate } from '../shopify.server';
import {
  isDeliveryCustomizationEnabledByTitle,
  setDeliveryCustomizationEnabledByTitle,
} from '../delivery-customization-util';
import {
  Card,
  Page,
  Tabs,
  FormLayout,
  TextField,
  Button,
  Banner,
  InlineStack,
  Checkbox,
} from '@shopify/polaris';
import { useState, useEffect } from 'react';

function normalizeCountryCodes(text) {
  if (typeof text !== 'string') {
    return [];
  }

  return text
    .split(',')
    .map((code) => String(code).trim().toUpperCase())
    .filter((code) => code.length > 0);
}

function parseMetafieldJsonValue(rawValue, fallback) {
  if (!rawValue) {
    return fallback;
  }

  try {
    const parsedOuter = JSON.parse(rawValue);
    return typeof parsedOuter === 'string' ? JSON.parse(parsedOuter) : parsedOuter;
  } catch (error) {
    return fallback;
  }
}

// Loader: fetch current delivery_templates and zip_fee_extension metafields from Admin GraphQL
export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);

  const resp = await admin.graphql(`
    query getMetafields {
      shop {
        deliveryTemplates: metafield(namespace: "distacart", key: "delivery_templates") { value }
        zipFeeExtension: metafield(namespace: "distacart", key: "zip_fee_extension") { value }
        prioritizeFastestShippingCountries: metafield(namespace: "distacart", key: "prioritize_fastest_shipping_countries") { value }
      }
    }
  `);
  const data = await resp.json();
  const value = data?.data?.shop?.deliveryTemplates?.value ?? '';
  const zipFeeValue = data?.data?.shop?.zipFeeExtension?.value ?? '';
  const prioritizeFastestShippingCountriesValue = data?.data?.shop?.prioritizeFastestShippingCountries?.value ?? '';
  const prioritizeFastestShippingEnabled = await isDeliveryCustomizationEnabledByTitle(
    session.shop,
    'Prioritize Fastest Shipping',
  );

  const prioritizeFastestShippingCountries = parseMetafieldJsonValue(
    prioritizeFastestShippingCountriesValue,
    [],
  );

  return json({
    value,
    zipFeeValue,
    prioritizeFastestShippingEnabled,
    prioritizeFastestShippingCountries,
  });
}

// Action: upsert the metafield via Admin GraphQL
export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const templatesJson = form.get('templatesJson');
  const countriesText = form.get('countriesText');
  const zipFeeEnabled = form.get('zipFeeEnabled') === 'true';
  const zipFeeProductId = form.get('zipFeeProductId');
  const prioritizeFastestShippingEnabled = form.get('prioritizeFastestShippingEnabled') === 'true';
  const prioritizeFastestShippingCountriesText = form.get('prioritizeFastestShippingCountriesText');
  try {
    const parsed = JSON.parse(templatesJson);
    if (!Array.isArray(parsed.templates)) return json({ error: 'templates must be an array' }, { status: 400 });

    // Parse countries from comma-separated ISO codes
    if (typeof countriesText === 'string') {
      const codes = normalizeCountryCodes(countriesText);
      if (codes.length > 0) {
        parsed.countries = codes;
      }
    }

    // Build Zip Fee Extension config (optional)
    const zipFeeConfig = {
      enabled: zipFeeEnabled,
      productId: typeof zipFeeProductId === 'string' ? zipFeeProductId.trim() : '',
    };

    const prioritizeFastestShippingCountries = normalizeCountryCodes(
      prioritizeFastestShippingCountriesText,
    );

    // get shop id for ownerId when setting metafield
    const shopResp = await admin.graphql(`query { shop { id } }`);
    const shopData = await shopResp.json();
    const shopId = shopData?.data?.shop?.id;

    const mutation = `
      mutation {
        metafieldsSet(metafields: [
          {
            namespace: "distacart",
            key: "delivery_templates",
            type: "json",
            value: ${JSON.stringify(JSON.stringify(parsed))},
            ownerId: "${shopId}"
          },
          {
            namespace: "distacart",
            key: "zip_fee_extension",
            type: "json",
            value: ${JSON.stringify(JSON.stringify(zipFeeConfig))},
            ownerId: "${shopId}"
          },
          {
            namespace: "distacart",
            key: "prioritize_fastest_shipping_countries",
            type: "json",
            value: ${JSON.stringify(JSON.stringify(prioritizeFastestShippingCountries))},
            ownerId: "${shopId}"
          }
        ]) {
          metafields { id }
          userErrors { field message }
        }
      }
    `;
    const upsertResp = await admin.graphql(mutation);
    const upsertResult = await upsertResp.json();
    const userErrors = upsertResult?.data?.metafieldsSet?.userErrors || [];
    if (userErrors.length) return json({ error: userErrors.map(e => e.message).join('; ') }, { status: 400 });

    await setDeliveryCustomizationEnabledByTitle(session.shop, {
      title: 'Prioritize Fastest Shipping',
      functionHandle: 'prioritize-fastest-shipping',
      enabled: prioritizeFastestShippingEnabled,
    });

    return json({ success: true, savedAt: Date.now() });
  } catch (e) {
    console.error('Dates input action error:', e);
    return json({ error: e?.message || 'Invalid JSON' }, { status: 400 });
  }
}

export default function DatesInput() {
  const data = useLoaderData();
  const actionData = useActionData();
  const [selectedTab, setSelectedTab] = useState(0);
  const initial = data?.value || JSON.stringify({ templates: ["{window} business days"], replacementFormat: "Estimated Delivery: {label}", countries: ["GB"] }, null, 2);
  const [jsonText, setJsonText] = useState(initial);
  const [countriesText, setCountriesText] = useState('GB');
  const [zipFeeEnabled, setZipFeeEnabled] = useState(false);
  const [zipFeeProductId, setZipFeeProductId] = useState('');
  const [prioritizeFastestShippingEnabled, setPrioritizeFastestShippingEnabled] = useState(false);
  const [prioritizeFastestShippingCountriesText, setPrioritizeFastestShippingCountriesText] = useState('');
  const [showSuccessBanner, setShowSuccessBanner] = useState(false);

  const tabs = [
    { id: 'delivery-templates-tab', content: 'Delivery Templates' },
    { id: 'zip-fee-extension-tab', content: 'Zip Fee Extension' },
    { id: 'prioritize-fastest-shipping-tab', content: 'Prioritize Fastest Shipping' },
  ];

  useEffect(() => {
    setJsonText(initial);
    try {
      const parsed = JSON.parse(initial);
      if (Array.isArray(parsed?.countries)) {
        setCountriesText(parsed.countries.map((c) => String(c).toUpperCase()).join(', '));
      }
    } catch (e) {
      // ignore parse errors
    }

    // Initialize Zip Fee Extension config from loader data (if present)
    try {
      const rawZip = data?.zipFeeValue;
      const parsedZip = parseMetafieldJsonValue(rawZip, null);
      if (parsedZip && typeof parsedZip === 'object') {
        if (typeof parsedZip.enabled === 'boolean') {
          setZipFeeEnabled(parsedZip.enabled);
        }
        if (typeof parsedZip.productId === 'string') {
          setZipFeeProductId(parsedZip.productId);
        }
      }
    } catch (e) {
      // ignore zip fee parse errors
    }

    setPrioritizeFastestShippingEnabled(Boolean(data?.prioritizeFastestShippingEnabled));
    setPrioritizeFastestShippingCountriesText(
      Array.isArray(data?.prioritizeFastestShippingCountries)
        ? data.prioritizeFastestShippingCountries.map((code) => String(code).toUpperCase()).join(', ')
        : '',
    );
  }, [
    initial,
    data?.zipFeeValue,
    data?.prioritizeFastestShippingEnabled,
    data?.prioritizeFastestShippingCountries,
  ]);

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccessBanner(true);
      const timer = setTimeout(() => {
        setShowSuccessBanner(false);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [actionData?.savedAt]);

  return (
    <Page fullWidth>
      <Card sectioned>
        <Form method="post">
          <div style={{ marginBottom: 5 }}>
            <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab} />
          </div>

          <FormLayout>
            {showSuccessBanner && (
              <Banner status="success">Settings saved successfully!</Banner>
            )}
            {actionData?.error && (
              <Banner status="critical">{actionData.error}</Banner>
            )}

            {selectedTab === 0 && (
              <div>
              <h2 style={{ margin: 0 }}>Delivery Templates</h2>
              <div>
                <p style={{ marginTop: 8 }}>
                  Provide a small JSON object with "templates" array containing templates with <code>{'{window}'}</code> placeholder.
                </p>
                <p style={{ marginTop: 4, color: '#6B7380' }}>
                  Example: {'{"templates":["{window} business days"]}'}
                </p>
                <p style={{ marginTop: 12 }}>
                  Countries to show: enter ISO country codes (e.g., GB, US, IN) separated by commas.
                </p>
              </div>

              <TextField
                label="Templates JSON"
                multiline={8}
                value={jsonText}
                onChange={(value) => setJsonText(value)}
              />

              <TextField
                label="Countries to show (ISO codes)"
                value={countriesText}
                onChange={(value) => setCountriesText(value)}
                helpText="Comma-separated list. Example: GB, US, IN"
              />
              </div>
            )}

            {selectedTab === 1 && (
              <div>
              <h2 style={{ margin: 0, marginBottom: 8 }}>Zip Fee Extension</h2>
              <p style={{ marginTop: 4, color: '#6B7380' }}>
                Configure the surcharge product used by the Zip Fee Checkout extension. Enable it if you are using this extension.
              </p>

              <Checkbox
                label="Enable Zip Fee Extension configuration"
                checked={zipFeeEnabled}
                onChange={(newChecked) => setZipFeeEnabled(Boolean(newChecked))}
              />

              <TextField
                label="Surcharge Product ID"
                value={zipFeeProductId}
                onChange={(value) => setZipFeeProductId(value)}
                helpText="Shopify Product ID that contains the surcharge variants. The extension will pick the closest matching variant price."
                disabled={!zipFeeEnabled}
              />
              </div>
            )}

            {selectedTab === 2 && (
              <div>
              <h2 style={{ margin: 0, marginBottom: 8 }}>Prioritize Fastest Shipping</h2>
              <p style={{ marginTop: 4, color: '#6B7380' }}>
                Enable this to activate the delivery customization function that prioritizes the fastest shipping option at checkout.
              </p>

              <Checkbox
                label="Enable Prioritize Fastest Shipping"
                checked={prioritizeFastestShippingEnabled}
                onChange={(newChecked) => setPrioritizeFastestShippingEnabled(Boolean(newChecked))}
              />

              <TextField
                label="Countries to enable (ISO codes)"
                value={prioritizeFastestShippingCountriesText}
                onChange={(value) => setPrioritizeFastestShippingCountriesText(value)}
                helpText="Enter country codes or ALL. Example: GB, US, IN for specific countries, or ALL for all countries."
              />
              </div>
            )}

            <InlineStack distribution="trailing">
              <Button primary submit>
                Save Settings
              </Button>
            </InlineStack>

          </FormLayout>

          {/* Keep hidden fields outside FormLayout to avoid extra vertical spacing */}
          <input type="hidden" name="templatesJson" value={jsonText} />
          <input type="hidden" name="countriesText" value={countriesText} />
          <input type="hidden" name="zipFeeEnabled" value={zipFeeEnabled ? 'true' : 'false'} />
          <input type="hidden" name="zipFeeProductId" value={zipFeeProductId} />
          <input type="hidden" name="prioritizeFastestShippingEnabled" value={prioritizeFastestShippingEnabled ? 'true' : 'false'} />
          <input type="hidden" name="prioritizeFastestShippingCountriesText" value={prioritizeFastestShippingCountriesText} />
        </Form>
      </Card>
    </Page>
  );
}
