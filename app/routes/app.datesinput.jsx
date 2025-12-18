import { json, redirect } from '@remix-run/node';
import { useLoaderData, useActionData, Form } from '@remix-run/react';
import { authenticate } from '../shopify.server';
import { Card, Page, FormLayout, TextField, Button, Banner, InlineStack } from '@shopify/polaris';
import { useState, useEffect } from 'react';

// Loader: fetch current delivery_templates metafield from Admin GraphQL
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  const resp = await admin.graphql(`
    query getMetafield {
      shop {
        metafield(namespace: "distacart", key: "delivery_templates") { value }
      }
    }
  `);
  const data = await resp.json();
  const value = data?.data?.shop?.metafield?.value ?? '';
  return json({ value });
}

// Action: upsert the metafield via Admin GraphQL
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const form = await request.formData();
  const templatesJson = form.get('templatesJson');
  const countriesText = form.get('countriesText');
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

    // get shop id for ownerId when setting metafield
    const shopResp = await admin.graphql(`query { shop { id } }`);
    const shopData = await shopResp.json();
    const shopId = shopData?.data?.shop?.id;

    const mutation = `
      mutation {
        metafieldsSet(metafields: [{
          namespace: "distacart",
          key: "delivery_templates",
          type: "json",
          value: ${JSON.stringify(JSON.stringify(parsed))},
          ownerId: "${shopId}"
        }]) {
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
