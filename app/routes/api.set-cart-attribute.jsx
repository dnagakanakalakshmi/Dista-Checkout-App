const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function loader({ request }) {
  // Handle OPTIONS preflight request
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  return new Response("Method not allowed", { status: 405 });
}

export async function action({ request }) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await request.json();

    // Call the remote area API
    const response = await fetch("https://api.dista.global/internal/logistics/remote-area", {
      method: "POST",
      headers: {
        "Authorization": "Bearer 74ae2bea8842834a33d062653069baaa",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    console.log("Remote area API response:", data);

    // Check if isRemote is true in the response
    const isRemote = data?.isRemoteArea === true;
    console.log("Determined isRemote:", isRemote);

    return new Response(JSON.stringify({ isRemote }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  } catch (error) {
    console.error("Error calling remote-area API:", error);
    return new Response(JSON.stringify({ isRemote: false, error: error.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
      },
    });
  }
}
