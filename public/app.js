const $ = (selector) => document.querySelector(selector);
let token = "",
  provider = "all",
  data = null,
  demo = false,
  busy = false,
  sourceRevision = "refs/heads/main";
const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 2,
});
const exact = new Intl.NumberFormat("en");
const text = (selector, value) => {
  $(selector).textContent = value;
};
function notice(message) {
  $("#notice").hidden = !message;
  text("#notice", message);
}
function node(tag, className, content) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (content !== undefined) e.textContent = content;
  return e;
}
async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(result.error || "Request failed"), {
      status: response.status,
    });
  return result;
}
function render(result) {
  data = result;
  demo = result.demo;
  const t = result.totals,
    total = t.inputTokens + t.outputTokens;
  for (const [selector, value] of [
    ["#total", total],
    ["#input", t.inputTokens],
    ["#output", t.outputTokens],
    ["#teams", result.teams.length],
  ]) {
    text(selector, compact.format(value));
    $(selector).title = exact.format(value);
  }
  text(
    "#cache-note",
    `${exact.format(t.cacheReadTokens)} cache-read · ${exact.format(t.cacheWriteTokens)} cache-write`,
  );
  text("#session-note", `${exact.format(t.sessions)} anonymous sessions`);
  text("#mode", demo ? "DEMO DATA" : "LIVE EVENT");
  text(
    "#updated",
    `Updated ${new Date(result.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`,
  );
  $("#team-rows").replaceChildren();
  $("#empty").hidden = result.teams.length > 0;
  result.teams.forEach((team, index) => {
    const sum = team.inputTokens + team.outputTokens;
    const share = total ? (sum / total) * 100 : 0;
    const tr = node("tr");
    const rank = node("td");
    rank.append(
      node(
        "span",
        `rank-number ${index === 0 ? "top-rank" : ""}`,
        String(index + 1).padStart(2, "0"),
      ),
    );
    tr.append(rank);
    const name = node("td");
    name.append(
      node("span", "team-name", team.name),
      node(
        "span",
        "team-detail",
        `${team.sessions} sessions${!team.active ? " · paused" : ""}`,
      ),
    );
    tr.append(name);
    for (const value of [team.inputTokens, team.outputTokens, sum]) {
      const cell = node(
        "td",
        `numeric ${value === sum ? "total-cell" : ""}`,
        compact.format(value),
      );
      cell.title = exact.format(value);
      tr.append(cell);
    }
    const shareCell = node("td", "numeric share-cell", `${share.toFixed(1)}%`);
    const track = node("div", "share-track");
    const fill = node("div", "share-fill");
    fill.style.width = `${share}%`;
    track.append(fill);
    shareCell.append(track);
    tr.append(shareCell);
    $("#team-rows").append(tr);
  });
  let claude = 0,
    codex = 0;
  for (const team of result.teams) {
    claude += team.claude;
    codex += team.codex;
  }
  const both = claude + codex;
  for (const [tool, value] of [
    ["claude", claude],
    ["codex", codex],
  ]) {
    const percentage = both ? (value / both) * 100 : 0;
    text(`#${tool}-share`, `${percentage.toFixed(1)}%`);
    $(`#${tool}-bar`).style.width = `${percentage}%`;
  }
  const timeline = new Map(result.timeline.map((x) => [x.hour, x]));
  const hours = Array.from({ length: 24 }, (_, i) => {
    const hour =
      new Date(Date.now() - (23 - i) * 3600_000).toISOString().slice(0, 13) +
      ":00:00.000Z";
    return timeline.get(hour) || { hour, inputTokens: 0, outputTokens: 0 };
  });
  const peak = Math.max(1, ...hours.map((x) => x.inputTokens + x.outputTokens));
  $("#chart").replaceChildren();
  for (const h of hours) {
    const col = node("div", "bar-column");
    col.title = `${new Date(h.hour).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${exact.format(h.inputTokens)} in / ${exact.format(h.outputTokens)} out`;
    for (const [type, value] of [
      ["output", h.outputTokens],
      ["input", h.inputTokens],
    ]) {
      const bar = node("div", `chart-bar ${type}-bar`);
      bar.style.height = `${(value / peak) * 100}%`;
      col.append(bar);
    }
    $("#chart").append(col);
  }
  $("#chart").setAttribute(
    "aria-label",
    `Last 24 hours: ${exact.format(hours.reduce((s, h) => s + h.inputTokens + h.outputTokens, 0))} tokens. Each bar is one hour.`,
  );
  if (result.admin) renderAdmin();
  if (demo)
    notice(
      "DEMO · These are sample teams and synthetic counts. Your live server starts empty. No participant data is collected here.",
    );
}
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    // A static hosted preview uses exactly the same UI with clearly labelled fixtures.
    const result =
      demo && window.HTM_STATIC_DEMO
        ? window.HTM_STATIC_DEMO(provider)
        : await api(`/api/summary?provider=${provider}`);
    render(result);
    $("#login").hidden = true;
    if (!demo) notice("");
  } catch (e) {
    if (e.status === 401) {
      $("#login").hidden = false;
      text("#mode", "LOCKED");
    } else {
      notice(
        "Connection lost. Showing the last received counters. Retrying automatically.",
      );
      text("#mode", "OFFLINE");
    }
  } finally {
    busy = false;
  }
}
for (const button of document.querySelectorAll("[data-provider]"))
  button.addEventListener("click", () => {
    provider = button.dataset.provider;
    for (const b of document.querySelectorAll("[data-provider]")) {
      b.classList.toggle("selected", b === button);
      b.setAttribute("aria-pressed", String(b === button));
    }
    refresh();
  });
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = $("#dashboard-key").value;
  $("#dashboard-key").value = "";
  await refresh();
});
$("#organizer").addEventListener("click", () => {
  if (demo) {
    notice(
      "The preview is read-only. Run htm server to create teams and collect real usage.",
    );
    return;
  }
  $("#organizer-dialog").showModal();
});
$("#privacy-open").addEventListener("click", () =>
  $("#privacy-dialog").showModal(),
);
for (const close of document.querySelectorAll(".close"))
  close.addEventListener("click", () => close.closest("dialog").close());
$("#projector").addEventListener("click", () => {
  document.body.classList.toggle("projector");
  if (document.body.classList.contains("projector")) {
    document.documentElement.requestFullscreen?.().catch(() => {});
    notice("Projector view · Press Escape to return.");
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.body.classList.remove("projector");
    if (!demo) notice("");
  }
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) document.body.classList.remove("projector");
});
$("#export").addEventListener("click", () => {
  if (!data) return;
  const escape = (v) =>
    `"${String(v)
      .replace(/^[=+@\-\t\r]/, "'$&")
      .replaceAll('"', '""')}"`;
  const rows = [
    [
      "Team",
      "Input tokens",
      "Output tokens",
      "Cache read (included in input)",
      "Cache write (included in input)",
      "Total tokens",
      "Sessions",
    ],
    ...data.teams.map((t) => [
      t.name,
      t.inputTokens,
      t.outputTokens,
      t.cacheReadTokens,
      t.cacheWriteTokens,
      t.inputTokens + t.outputTokens,
      t.sessions,
    ]),
  ];
  const blob = new Blob(
    ["\uFEFF" + rows.map((r) => r.map(escape).join(",")).join("\r\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob);
  const a = node("a");
  a.href = url;
  a.download = `hackyeah-${demo ? "demo-" : ""}${provider}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("#admin-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const previous = token;
  token = $("#admin-key").value;
  $("#admin-key").value = "";
  try {
    const result = await api("/api/summary");
    if (!result.admin)
      throw new Error("This key is read-only. Enter an organizer key.");
    render(result);
    text("#admin-message", "");
  } catch (e) {
    token = previous;
    text("#admin-message", e.message);
  }
});
function renderAdmin() {
  $("#admin-login").hidden = true;
  $("#admin-content").hidden = false;
  $("#admin-teams").replaceChildren();
  for (const team of data.teams) {
    const row = node("div", "admin-team");
    row.append(node("strong", "", team.name));
    const actions = node("div", "actions");
    const pause = node("button", "quiet", team.active ? "Pause" : "Resume");
    pause.addEventListener("click", async () => {
      try {
        await api(`/api/admin/teams/${team.id}/status`, {
          method: "POST",
          body: { active: !team.active },
        });
        await refresh();
      } catch (e) {
        text("#admin-message", e.message);
      }
    });
    const rotate = node("button", "quiet", "Rotate key");
    rotate.addEventListener("click", async () => {
      if (
        !confirm(
          `Invalidate the current key for ${team.name}? Participants will need the new key.`,
        )
      )
        return;
      try {
        const result = await api(`/api/admin/teams/${team.id}/rotate`, {
          method: "POST",
          body: {},
        });
        showKey(team.name, result.key);
      } catch (e) {
        text("#admin-message", e.message);
      }
    });
    actions.append(pause, rotate);
    row.append(actions);
    $("#admin-teams").append(row);
  }
}
const shellQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
function showKey(name, key) {
  $("#new-team").hidden = false;
  text("#new-team-name", name);
  text("#new-key", key);
  text(
    "#install-command",
    `npx --yes --package=https://github.com/elanon1/hackyeah-token-dasboard/archive/${sourceRevision}.tar.gz htm join --server ${shellQuote(location.origin)} --team ${shellQuote(name)}`,
  );
}
$("#create-team").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const team = await api("/api/admin/teams", {
      method: "POST",
      body: { name: $("#team-name").value },
    });
    showKey(team.name, team.key);
    $("#team-name").value = "";
    text("#admin-message", "Team created. Share the key privately.");
    await refresh();
  } catch (e) {
    text("#admin-message", e.message);
  }
});
for (const [button, target] of [
  ["#copy-key", "#new-key"],
  ["#copy-install", "#install-command"],
])
  $(button).addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($(target).textContent);
      text("#admin-message", "Copied.");
    } catch {
      text("#admin-message", "Select and copy the text manually.");
    }
  });
setInterval(() => {
  text(
    "#clock",
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  );
}, 1000);
setInterval(() => {
  if (!document.hidden) refresh();
}, 5000);
async function start() {
  if (window.HTM_STATIC_DEMO) demo = true;
  else
    try {
      const health = await api("/api/health");
      demo = health.demo;
      if (/^[a-f0-9]{40}$/.test(health.sourceRevision))
        sourceRevision = health.sourceRevision;
    } catch {}
  await refresh();
}
start();
