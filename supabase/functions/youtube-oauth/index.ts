import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = { "content-type": "text/html; charset=utf-8" };
const youtubeScope = "https://www.googleapis.com/auth/youtube.upload";
const youtubeReadonlyScope = "https://www.googleapis.com/auth/youtube.readonly";
const identityScope = "openid email";
const expectedAccount = "maiduan2589@gmail.com";
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const clientId = Deno.env.get("YOUTUBE_CLIENT_ID")!;
const clientSecret = Deno.env.get("YOUTUBE_CLIENT_SECRET")!;
const callbackUrl = Deno.env.get("YOUTUBE_REDIRECT_URI")!;

function base64url(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return base64url(bytes);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]!));
}

async function handle(req: Request) {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/start")) {
    const state = randomState();
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.searchParams.set("client_id", clientId);
    auth.searchParams.set("redirect_uri", callbackUrl);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", `${youtubeScope} ${youtubeReadonlyScope} ${identityScope}`);
    auth.searchParams.set("include_granted_scopes", "true");
    auth.searchParams.set("access_type", "offline");
    auth.searchParams.set("prompt", "select_account consent");
    auth.searchParams.set("login_hint", expectedAccount);
    auth.searchParams.set("state", state);
    return new Response(null, {
      status: 302,
      headers: {
        location: auth.toString(),
        "set-cookie": `yt_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
      },
    });
  }

  const error = url.searchParams.get("error");
  if (error) return new Response(`OAuth failed: ${escapeHtml(error)}`, { status: 400, headers: cors });

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = req.headers.get("cookie") || "";
  const expected = cookie.match(/(?:^|; )yt_oauth_state=([^;]+)/)?.[1];
  if (!code || !state || !expected || state !== expected) {
    return new Response("Invalid or missing OAuth state/code.", { status: 400, headers: cors });
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl,
      grant_type: "authorization_code",
    }),
  });
  const token = await tokenRes.json();
  if (!tokenRes.ok || !token.access_token) {
    return new Response(`Token exchange failed: ${escapeHtml(JSON.stringify(token))}`, { status: 502, headers: cors });
  }

  const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  const user = await userRes.json();
  if (!userRes.ok || user.email !== expectedAccount || user.email_verified !== true) {
    return new Response(
      `Wrong Google account. Expected ${escapeHtml(expectedAccount)}. No YouTube token was stored.`,
      { status: 403, headers: cors },
    );
  }

  const channelRes = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    { headers: { authorization: `Bearer ${token.access_token}` } },
  );
  const channels = await channelRes.json();
  if (!channelRes.ok) {
    const detail = escapeHtml(JSON.stringify(channels));
    return new Response(`YouTube channel lookup failed (HTTP ${channelRes.status}): ${detail}`, { status: 502, headers: cors });
  }
  if (!channels.items?.length) {
    return new Response("YouTube API succeeded but returned zero channels for this authorization. If Hidden Beyond is a Brand Account, select that channel/default channel during authorization.", { status: 502, headers: cors });
  }

  const channel = channels.items[0];
  const refreshToken = token.refresh_token;
  if (!refreshToken) {
    return new Response("OAuth succeeded but no refresh token was returned. Re-run consent.", { status: 502, headers: cors });
  }

  const saveRes = await fetch(`${supabaseUrl}/rest/v1/youtube_connections`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      provider: "youtube",
      channel_id: channel.id,
      channel_title: channel.snippet.title,
      refresh_token: refreshToken,
      scope: token.scope ?? `${youtubeScope} ${youtubeReadonlyScope} ${identityScope}`,
      updated_at: new Date().toISOString(),
    }),
  });

  if (!saveRes.ok) {
    return new Response("YouTube connected, but secure token storage failed.", { status: 502, headers: cors });
  }

  return new Response(
    `<h2>YouTube connected</h2><p>Google account: <b>${escapeHtml(user.email)}</b></p><p>Channel: <b>${escapeHtml(channel.snippet.title)}</b></p><p>Channel ID: <code>${escapeHtml(channel.id)}</code></p><p>OAuth verification succeeded.</p>`,
    { status: 200, headers: cors },
  );
}

Deno.serve(async (req) => {
  try {
    return await handle(req);
  } catch (error) {
    return new Response(`OAuth server error: ${escapeHtml(String(error))}`, { status: 500, headers: cors });
  }
});
