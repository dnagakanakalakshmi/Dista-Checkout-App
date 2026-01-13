import { json, redirect } from '@remix-run/node';
import { useLoaderData, useActionData, Form } from '@remix-run/react';
import { authenticate } from '../shopify.server';
import {
  Card,
  Page,
  FormLayout,
  TextField,
  Button,
  Banner,
  InlineStack,
  Checkbox,
} from '@shopify/polaris';
import { useState, useEffect } from 'react';

// Loader: fetch current delivery_templates and zip_fee_extension metafields from Admin GraphQL
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const resp = await admin.graphql(`
    query getMetafields {
      shop {
        deliveryTemplates: metafield(namespace: "distacart", key: "delivery_templates") { value }
        zipFeeExtension: metafield(namespace: "distacart", key: "zip_fee_extension") { value }
      }
    }
  `);
  const data = await resp.json();
  const value = data?.data?.shop?.deliveryTemplates?.value ?? '';
  const zipFeeValue = data?.data?.shop?.zipFeeExtension?.value ?? '';
  return json({ value, zipFeeValue });
}

// Action: upsert the metafield via Admin GraphQL
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const templatesJson = form.get('templatesJson');
  const countriesText = form.get('countriesText');
  const zipFeeEnabled = form.get('zipFeeEnabled') === 'true';
  const zipFeeProductId = form.get('zipFeeProductId');
  try {
    const parsed = JSON.parse(templatesJson);
    if (!Array.isArray(parsed.templates)) return json({ error: 'templates must be an array' }, { status: 400 });

    // Parse countries from comma-separated ISO codes
    if (typeof countriesText === 'string') {
      const codes = countriesText
        .split(',')
        .map((c) => String(c).trim().toUpperCase())
        .filter((c) => c.length > 0);
      if (codes.length > 0) parsed.countries = codes;
    }

    // Build Zip Fee Extension config (optional)
    const zipFeeConfig = {
      enabled: zipFeeEnabled,
      productId: typeof zipFeeProductId === 'string' ? zipFeeProductId.trim() : '',
    };

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
    return redirect('/app/datesinput');
  } catch (e) {
    return json({ error: 'Invalid JSON' }, { status: 400 });
  }
}

export default function DatesInput() {
  const data = useLoaderData();
  const actionData = useActionData();
  const initial = data?.value || JSON.stringify({ templates: ["{window} business days"], replacementFormat: "Estimated Delivery: {label}", countries: ["GB"] }, null, 2);
  const [jsonText, setJsonText] = useState(initial);
  const [countriesText, setCountriesText] = useState('GB');
  const [zipFeeEnabled, setZipFeeEnabled] = useState(false);
  const [zipFeeProductId, setZipFeeProductId] = useState('');

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
      if (rawZip) {
        const parsedOuter = JSON.parse(rawZip);
        const parsedZip = typeof parsedOuter === 'string' ? JSON.parse(parsedOuter) : parsedOuter;
        if (parsedZip && typeof parsedZip === 'object') {
          if (typeof parsedZip.enabled === 'boolean') {
            setZipFeeEnabled(parsedZip.enabled);
          }
          if (typeof parsedZip.productId === 'string') {
            setZipFeeProductId(parsedZip.productId);
          }
        }
      }
    } catch (e) {
      // ignore zip fee parse errors
    }
  }, [initial]);

  return (
    <Page fullWidth>
      <Card sectioned>
        <Form method="post">
          <FormLayout>
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

            {actionData?.error && (
              <Banner status="critical">{actionData.error}</Banner>
            )}

            <TextField
              label="Templates JSON"
              name="templatesJson"
              multiline={8}
              value={jsonText}
              onChange={(value) => setJsonText(value)}
            />

            <TextField
              label="Countries to show (ISO codes)"
              name="countriesText"
              value={countriesText}
              onChange={(value) => setCountriesText(value)}
              helpText="Comma-separated list. Example: GB, US, IN"
            />


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

              {/* Hidden field to submit the checkbox value with the Remix form */}
              <input
                type="hidden"
                name="zipFeeEnabled"
                value={zipFeeEnabled ? 'true' : 'false'}
              />

              <TextField
                label="Surcharge Product ID"
                name="zipFeeProductId"
                value={zipFeeProductId}
                onChange={(value) => setZipFeeProductId(value)}
                helpText="Shopify Product ID that contains the surcharge variants. The extension will pick the closest matching variant price."
                disabled={!zipFeeEnabled}
              />
            </div>

            <InlineStack distribution="trailing">
              <Button primary submit>
                Save Templates
              </Button>
            </InlineStack>

          </FormLayout>
        </Form>
      </Card>
    </Page>
  );
}
