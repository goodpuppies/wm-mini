// webhook.ts

const GITHUB_SECRET = "my-super-secret-key";
const DISCORD_WEBHOOK = "http://localhost:8080/mock-discord"; // Loopback for testing

// ============================================================================
// CORE APPLICATION LOGIC (The Stress Test)
// ============================================================================

// 1. The Web Crypto API / FFI Stressor
async function verifyGithubSignature(signature: string | null, bodyText: string): Promise<boolean> {
  if (!signature) return false;
  const encoder = new TextEncoder();
  
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(GITHUB_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );

  const expectedBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(bodyText)
  );

  // 2. Buffer manipulation & fluent chaining
  const expectedHex = Array.from(new Uint8Array(expectedBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  
  return signature === `sha256=${expectedHex}`;
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  
  // (Mock Discord endpoint just to catch the fire-and-forget fetch)
  if (url.pathname === "/mock-discord") {
    const body = await req.json();
    console.log("\n[Discord Mock] Received message:\n" + body.content + "\n");
    return new Response("OK", { status: 200 });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const bodyText = await req.text();
  const signature = req.headers.get("x-hub-signature-256");

  if (!(await verifyGithubSignature(signature, bodyText))) {
    console.error("[Server] Unauthorized request!");
    return new Response("Unauthorized", { status: 401 });
  }

  // 3. Untyped JSON crossing the boundary
  const payload = JSON.parse(bodyText);

  if (req.headers.get("x-github-event") === "push") {
    
    // 4. Duck-typing and optional chaining on unknown structures
    const repoName = payload.repository?.full_name ?? "Unknown Repo";
    const commits = payload.commits ?? [];
    const pusherName = payload.pusher?.name ?? "Someone";

    if (commits.length > 0) {
      const commitList = commits
        // Explicit 'any' to simulate untyped JSON arrays
        .map((c: any) => `- [${c.id.slice(0, 7)}] ${c.message}`)
        .join("\n");

      const discordMessage = {
        content: `🚀 **${pusherName}** pushed ${commits.length} commits to \`${repoName}\`\n${commitList}`
      };

      // 5. Fire-and-forget fetch with nested record configurations
      fetch(DISCORD_WEBHOOK, {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify(discordMessage)
      }).catch(err => console.error("Discord error:", err));
    }
  }

  return new Response(JSON.stringify({ received: true }), { 
    status: 200, 
    headers: { "Content-Type": "application/json" } 
  });
}

// ============================================================================
// SELF-CONTAINED TEST RUNNER (Simulates the outside world)
// ============================================================================

async function runSimulation() {
  // We use AbortController to cleanly shut down Deno.serve later (More FFI testing!)
  const ac = new AbortController();
  
  // Start the server
  const server = Deno.serve({ port: 8080, signal: ac.signal }, handleRequest);
  console.log("Server started on http://localhost:8080");

  // Create a dummy GitHub payload
  const dummyPayload = {
    repository: { full_name: "my-org/my-compiler" },
    pusher: { name: "alice" },
    commits: [
      { id: "abcdef123456", message: "Initial commit" },
      { id: "9876543210ab", message: "Fix JS reflection type inference" }
    ]
  };
  const payloadText = JSON.stringify(dummyPayload);

  // Generate the correct HMAC signature so our server accepts it
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(GITHUB_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadText));
  const sigHex = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

  console.log("Simulating incoming GitHub Webhook...");
  
  // Fire the simulated request to our own server
  const res = await fetch("http://localhost:8080", {
    method: "POST",
    headers: {
      "x-github-event": "push",
      "x-hub-signature-256": `sha256=${sigHex}`,
      "Content-Type": "application/json"
    },
    body: payloadText
  });

  const responseBody = await res.json();
  console.log("[Simulation] Server responded with:", responseBody);

  // Give the fire-and-forget Discord fetch a tiny bit of time to complete
  await new Promise(r => setTimeout(r, 100));

  console.log("Shutting down server...");
  ac.abort();
  await server.finished;
}

if (import.meta.main) {
  runSimulation();
}