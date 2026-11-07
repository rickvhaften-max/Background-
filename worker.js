
const DISCORD_API = "https://discord.com/api/v10";
const encoder = new TextEncoder();

const CACHE_SECONDS = 300;
const ROBLOX_TIMEOUT_MS = 6500;

// --------------------------------------------------
// GENERAL HELPERS
// --------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function clean(value, max = 100) {
  return String(value ?? "Unknown")
    .replace(/@/g, "@\u200b")
    .replace(/[`*_~|<>\\]/g, "")
    .replace(/[\r\n]/g, " ")
    .slice(0, max);
}

function fromHex(value) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) {
    throw new Error("Invalid hexadecimal value");
  }

  return Uint8Array.from(
    value.match(/../g),
    part => parseInt(part, 16)
  );
}

function field(name, value, inline = false) {
  return {
    name,
    value: String(value ?? "Unavailable").slice(0, 1024) || "Unavailable",
    inline
  };
}

function errorEmbed(message) {
  return {
    title: "LLTE | Background Check",
    description: clean(message, 500),
    color: 0xd08041
  };
}

// --------------------------------------------------
// DISCORD SIGNATURE VERIFICATION
// --------------------------------------------------

async function verifyDiscord(request, body, env) {
  const signature =
    request.headers.get("X-Signature-Ed25519") || "";

  const timestamp =
    request.headers.get("X-Signature-Timestamp") || "";

  const publicKey = env.DISCORD_PUBLIC_KEY || "";

  if (
    !/^[a-f0-9]{128}$/i.test(signature) ||
    !/^[a-f0-9]{64}$/i.test(publicKey) ||
    !/^\d+$/.test(timestamp)
  ) {
    return false;
  }

  if (
    Math.abs(Date.now() - Number(timestamp) * 1000) >
    300000
  ) {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      fromHex(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"]
    );

    return await crypto.subtle.verify(
      "Ed25519",
      key,
      fromHex(signature),
      encoder.encode(timestamp + body)
    );
  } catch (error) {
    console.error("Discord verification error:", String(error));
    return false;
  }
}

// --------------------------------------------------
// ROBLOX API + CACHE
// --------------------------------------------------

function makeCacheKey(url, payload) {
  const key =
    url + "|" + (payload ? JSON.stringify(payload) : "");

  return new Request(
    "https://llte-cache.invalid/" +
    encodeURIComponent(key)
  );
}

async function robloxRequest(url, payload = null, ttl = CACHE_SECONDS) {
  const cache = caches.default;
  const cacheKey = makeCacheKey(url, payload);

  const cached = await cache.match(cacheKey);

  if (cached) {
    return cached.json();
  }

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    ROBLOX_TIMEOUT_MS
  );

  let response;

  try {
    response = await fetch(url, {
      method: payload ? "POST" : "GET",
      headers: {
        accept: "application/json",
        ...(payload
          ? { "content-type": "application/json" }
          : {})
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        "Roblox took too long to respond. Try again."
      );
    }

    throw new Error(
      "Roblox is temporarily unreachable."
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    throw new Error(
      "Roblox rate limited this request. Please try again later."
    );
  }

  if (!response.ok) {
    throw new Error(
      `Roblox API returned HTTP ${response.status}.`
    );
  }

  const data = await response.json();

  if (ttl > 0) {
    try {
      await cache.put(
        cacheKey,
        new Response(JSON.stringify(data), {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${ttl}`
          }
        })
      );
    } catch (error) {
      console.warn("Cache write failed:", String(error));
    }
  }

  return data;
}

async function optionalRoblox(url, ttl = CACHE_SECONDS) {
  try {
    return await robloxRequest(url, null, ttl);
  } catch (error) {
    console.warn(
      "Optional Roblox request failed:",
      String(error)
    );

    return null;
  }
}

// --------------------------------------------------
// DISCORD RESPONSE
// --------------------------------------------------

async function updateDiscordMessage(interaction, embed) {
  const url =
    `${DISCORD_API}/webhooks/` +
    `${encodeURIComponent(interaction.application_id)}/` +
    `${encodeURIComponent(interaction.token)}/messages/@original`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      content: "",
      embeds: [embed],
      allowed_mentions: {
        parse: []
      }
    })
  });

  if (!response.ok) {
    const details = await response.text();

    console.error(
      "Discord message update failed:",
      response.status,
      details.slice(0, 500)
    );
  }
}

// --------------------------------------------------
// ROBLOX BACKGROUND CHECK
// --------------------------------------------------

async function runBackgroundCheck(interaction, username) {
  try {
    const lookup = await robloxRequest(
      "https://users.roblox.com/v1/usernames/users",
      {
        usernames: [username],
        excludeBannedUsers: false
      },
      600
    );

    const entry = lookup?.data?.[0];

    if (!entry?.id) {
      await updateDiscordMessage(
        interaction,
        errorEmbed(
          `Roblox account not found: ${username}`
        )
      );

      return;
    }

    const id = Number(entry.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error("Invalid Roblox user ID.");
    }

    const profile = await robloxRequest(
      `https://users.roblox.com/v1/users/${id}`,
      null,
      300
    );

    const [groups, friends, thumbnail] = await Promise.all([
      optionalRoblox(
        `https://groups.roblox.com/v1/users/${id}/groups/roles`,
        600
      ),

      optionalRoblox(
        `https://friends.roblox.com/v1/users/${id}/friends/count`,
        300
      ),

      optionalRoblox(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${id}&size=150x150&format=Png&isCircular=false`,
        900
      )
    ]);

    const created = profile?.created
      ? new Date(profile.created)
      : null;

    const validDate =
      created && !Number.isNaN(created.getTime());

    const ageDays = validDate
      ? Math.max(
          0,
          Math.floor(
            (Date.now() - created.getTime()) / 86400000
          )
        )
      : null;

    const accountAge = validDate
      ? `${ageDays} days (<t:${Math.floor(created.getTime() / 1000)}:D>)`
      : "Unavailable";

    const fields = [
      field(
        "Username",
        clean(profile?.name || entry.name, 70),
        true
      ),

      field(
        "Display Name",
        clean(
          profile?.displayName ||
          entry.displayName ||
          "Unavailable",
          70
        ),
        true
      ),

      field(
        "Roblox ID",
        String(id),
        true
      ),

      field(
        "Account Age",
        accountAge,
        true
      ),

      field(
        "Friends",
        typeof friends?.count === "number"
          ? String(friends.count)
          : "Unavailable",
        true
      ),

      field(
        "Roblox Ban Status",
        typeof profile?.isBanned === "boolean"
          ? profile.isBanned
            ? "Banned (Roblox profile flag)"
            : "Not banned (Roblox profile flag)"
          : "Unavailable",
        true
      ),

      field(
        "LLTE Verification",
        "Not checked — account ownership not verified"
      ),

      field(
        "LLTE Ban Records",
        "Not checked — no LLTE moderation database connected"
      ),

      field(
        "Community Blacklists",
        "Not checked — no blacklist database connected"
      )
    ];

    if (Array.isArray(groups?.data)) {
      const groupLines = groups.data
        .slice(0, 12)
        .map(item => {
          const groupName = clean(
            item.group?.name,
            40
          );

          const roleName = clean(
            item.role?.name,
            30
          );

          return `• ${groupName} — ${roleName}`;
        });

      fields.push(
        field(
          "Public Roblox Groups",
          groupLines.join("\n").slice(0, 950) ||
          "No public groups returned"
        )
      );

      if (groups.data.length > 12) {
        fields.push(
          field(
            "Additional Groups",
            `${groups.data.length - 12} more groups not displayed`
          )
        );
      }
    } else {
      fields.push(
        field(
          "Public Roblox Groups",
          "Unavailable"
        )
      );
    }

    const embed = {
      title:
        "LLTE Background Check | " +
        clean(profile?.name || username, 45),

      url:
        `https://www.roblox.com/users/${id}/profile`,

      description:
        "Public Roblox account information. " +
        "This report does not prove identity or trustworthiness.",

      color: 0x477cb5,

      fields: fields.slice(0, 25),

      timestamp: new Date().toISOString(),

      footer: {
        text:
          "LLTE PlatformBot • Public Background Check"
      }
    };

    const imageUrl =
      thumbnail?.data?.[0]?.imageUrl;

    if (
      typeof imageUrl === "string" &&
      imageUrl.startsWith("https://")
    ) {
      embed.thumbnail = {
        url: imageUrl
      };
    }

    await updateDiscordMessage(interaction, embed);

  } catch (error) {
    console.error(
      "Background Check failed:",
      String(error)
    );

    await updateDiscordMessage(
      interaction,
      errorEmbed(
        error?.message ||
        "Background Check is temporarily unavailable."
      )
    );
  }
}

// --------------------------------------------------
// REGISTER DISCORD SLASH COMMAND
// --------------------------------------------------

async function registerCommand(env) {
  if (
    !env.DISCORD_APPLICATION_ID ||
    !env.DISCORD_GUILD_ID ||
    !env.DISCORD_BOT_TOKEN
  ) {
    return json({
      error: "Missing Discord configuration",
      missing: [
        "DISCORD_APPLICATION_ID",
        "DISCORD_GUILD_ID",
        "DISCORD_BOT_TOKEN"
      ].filter(name => !env[name])
    }, 400);
  }

  const command = {
    name: "bgcheck",
    type: 1,
    description:
      "Check public Roblox account information",

    options: [
      {
        name: "username",
        description:
          "Exact Roblox username, not display name",
        type: 3,
        required: true,
        min_length: 3,
        max_length: 20
      }
    ]
  };

  const endpoint =
    `${DISCORD_API}/applications/` +
    `${env.DISCORD_APPLICATION_ID}/guilds/` +
    `${env.DISCORD_GUILD_ID}/commands`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization:
        `Bot ${env.DISCORD_BOT_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const responseText = await response.text();

  if (!response.ok) {
    return json({
      error: "Discord registration failed",
      discordStatus: response.status,
      details: responseText.slice(0, 2000)
    }, 400);
  }

  return json({
    registered: true,
    command: "/bgcheck username",
    visibility: "public",
    permission: "everyone",
    message: "LLTE command registered successfully"
  });
}

// --------------------------------------------------
// MAIN CLOUDFLARE WORKER
// --------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check
    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/health")
    ) {
      return json({
        service: "LLTE Roblox Background Check",
        status: "ready",
        command: "/bgcheck",
        publicResults: true,
        needsManualRestart: false
      });
    }

    // Protected registration endpoint
    if (
      request.method === "GET" &&
      url.pathname === "/register"
    ) {
      if (
        !env.SETUP_KEY ||
        url.searchParams.get("key") !== env.SETUP_KEY
      ) {
        return json({
          error: "Not authorized"
        }, 403);
      }

      return registerCommand(env);
    }

    // Discord interactions only
    if (
      url.pathname !== "/interactions" ||
      request.method !== "POST"
    ) {
      return json({
        error: "Not found"
      }, 404);
    }

    const rawBody = await request.text();

    const verified = await verifyDiscord(
      request,
      rawBody,
      env
    );

    if (!verified) {
      return json({
        error: "Invalid Discord signature"
      }, 401);
    }

    let interaction;

    try {
      interaction = JSON.parse(rawBody);
    } catch {
      return json({
        error: "Invalid JSON"
      }, 400);
    }

    // Discord endpoint verification
    if (interaction.type === 1) {
      return json({
        type: 1
      });
    }

    if (
      interaction.type !== 2 ||
      interaction.data?.name !== "bgcheck"
    ) {
      return json({
        type: 4,
        data: {
          content: "Unknown command"
        }
      });
    }

    // Restrict to LLTE server, but allow all members
    if (
      env.DISCORD_GUILD_ID &&
      interaction.guild_id !== env.DISCORD_GUILD_ID
    ) {
      return json({
        type: 4,
        data: {
          content:
            "This command is only available in the LLTE server.",
          flags: 64
        }
      });
    }

    const username = String(
      interaction.data?.options?.find(
        option => option.name === "username"
      )?.value || ""
    ).trim();

    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
      return json({
        type: 4,
        data: {
          content:
            "Please enter a valid Roblox username.",
          flags: 64
        }
      });
    }

    // Discord must receive an initial response quickly.
    // The final public message is edited asynchronously.
    ctx.waitUntil(
      runBackgroundCheck(interaction, username)
    );

    return json({
      type: 5
    });
  }
};
