require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const {
  SHOPIFY_SHOP,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  SHOPIFY_API_VERSION = "2026-01",
  PORT = 3000,
} = process.env;

function assertEnv(name, value) {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

assertEnv("SHOPIFY_SHOP", SHOPIFY_SHOP);
assertEnv("SHOPIFY_CLIENT_ID", SHOPIFY_CLIENT_ID);
assertEnv("SHOPIFY_CLIENT_SECRET", SHOPIFY_CLIENT_SECRET);

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

async function getShopifyAccessToken() {
  const now = Date.now();

  if (tokenCache.accessToken && now < tokenCache.expiresAt - 60_000) {
    return tokenCache.accessToken;
  }

  const response = await fetch(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Token request failed: ${response.status} ${JSON.stringify(data)}`
    );
  }

  if (!data.access_token) {
    throw new Error(`No access_token returned: ${JSON.stringify(data)}`);
  }

  tokenCache.accessToken = data.access_token;

  // Cache conservatively; Shopify's token is short-lived.
  tokenCache.expiresAt = now + 23 * 60 * 60 * 1000;

  return data.access_token;
}

async function shopifyGraphQL(query, variables = {}) {
  const accessToken = await getShopifyAccessToken();

  const response = await fetch(
    `https://${SHOPIFY_SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  const json = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      `Shopify GraphQL HTTP error ${response.status}: ${JSON.stringify(json)}`
    );
  }

  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

app.get("/", (_req, res) => {
  res.send(`Server running on http://localhost:${PORT}`);
});

app.get("/api/test-shopify", async (_req, res) => {
  try {
    const data = await shopifyGraphQL(`
      query {
        shop {
          name
          myshopifyDomain
        }
      }
    `);

    res.json({
      success: true,
      shop: data.shop,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/check-scopes", async (_req, res) => {
  try {
    const data = await shopifyGraphQL(`
      query {
        appInstallation {
          accessScopes {
            handle
          }
        }
      }
    `);

    res.json({
      success: true,
      scopes: data.appInstallation.accessScopes.map((s) => s.handle),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/find-order", async (req, res) => {
  try {
    const rawOrder = String(req.query.order || "").trim();

    if (!rawOrder) {
      return res.status(400).json({
        success: false,
        error: "Missing ?order=1001",
      });
    }

    const orderName = rawOrder.startsWith("#") ? rawOrder : `#${rawOrder}`;

    const data = await shopifyGraphQL(
      `
      query FindOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              displayFinancialStatus
              receiptUploaded: metafield(namespace: "custom", key: "receipt_uploaded") {
                value
              }
              receiptStatus: metafield(namespace: "custom", key: "receipt_status") {
                value
              }
            }
          }
        }
      }
      `,
      { query: `name:${orderName}` }
    );

    const order = data.orders.edges[0]?.node || null;

    if (!order) {
      return res.status(404).json({
        success: false,
        error: `Order ${orderName} not found`,
      });
    }

    res.json({
      success: true,
      order,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/find-order-by-id", async (req, res) => {
  try {
    const orderId = String(req.query.orderId || "").trim();

    if (!orderId) {
      return res.status(400).json({
        success: false,
        error: "Missing ?orderId=gid://shopify/Order/123",
      });
    }

    const data = await shopifyGraphQL(
      `
      query FindOrderById($id: ID!) {
        order(id: $id) {
          id
          name
          displayFinancialStatus
          receiptUploaded: metafield(namespace: "custom", key: "receipt_uploaded") {
            value
          }
          receiptStatus: metafield(namespace: "custom", key: "receipt_status") {
            value
          }
        }
      }
      `,
      { id: orderId }
    );

    const order = data.order || null;

    if (!order) {
      return res.status(404).json({
        success: false,
        error: `Order ${orderId} not found`,
      });
    }

    res.json({
      success: true,
      order,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.post("/api/mark-receipt-uploaded", async (req, res) => {
  try {
    const rawOrder = String(req.body.order || "").trim();

    if (!rawOrder) {
      return res.status(400).json({
        success: false,
        error: "Missing order in request body",
      });
    }

    const orderName = rawOrder.startsWith("#") ? rawOrder : `#${rawOrder}`;

    const found = await shopifyGraphQL(
      `
      query FindOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
      `,
      { query: `name:${orderName}` }
    );

    const order = found.orders.edges[0]?.node;

    if (!order) {
      return res.status(404).json({
        success: false,
        error: `Order ${orderName} not found`,
      });
    }

    const result = await shopifyGraphQL(
      `
      mutation SetReceiptMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
      `,
      {
        metafields: [
          {
            ownerId: order.id,
            namespace: "custom",
            key: "receipt_uploaded",
            type: "boolean",
            value: "true",
          },
          {
            ownerId: order.id,
            namespace: "custom",
            key: "receipt_status",
            type: "single_line_text_field",
            value: "pending_verification",
          },
        ],
      }
    );

    const userErrors = result.metafieldsSet.userErrors || [];

    if (userErrors.length) {
      return res.status(400).json({
        success: false,
        error: "metafieldsSet returned userErrors",
        details: userErrors,
      });
    }

    res.json({
      success: true,
      orderId: order.id,
      orderName: order.name,
      metafields: result.metafieldsSet.metafields,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
app.get("/api/has-pending-orders", async (req, res) => {
  try {
    const query = `
      {
        orders(first: 10, query: "financial_status:pending") {
          edges {
            node {
              id
              name
              displayFinancialStatus
              receiptUploaded: metafield(namespace: "custom", key: "receipt_uploaded") {
                value
              }
            }
          }
        }
      }
    `;

    const response = await fetch(
      `https://${process.env.SHOPIFY_SHOP}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        },
        body: JSON.stringify({ query }),
      }
    );

    const data = await response.json();

    const orders = data?.data?.orders?.edges || [];

    // Check if ANY order is pending and has NO receipt
    const hasPendingOrders = orders.some((edge) => {
      const order = edge.node;
      return (
        order.displayFinancialStatus === "PENDING" &&
        (!order.receiptUploaded || order.receiptUploaded.value !== "true")
      );
    });

    res.json({ hasPendingOrders });
  } catch (error) {
    console.error(error);
    res.json({ hasPendingOrders: false });
  }
});
