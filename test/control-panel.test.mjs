import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, addProject } from "../packages/bridge-core/lib/admin.mjs";
import { Store } from "../packages/bridge-core/lib/store.mjs";
import { startControlPanel } from "../src/control-panel.mjs";

test("Pi control panel stays loopback, dark-mode safe, and manages pairing state", async () => {
  const root = await mkdtemp(join(tmpdir(), "remotedesk-pi-panel-"));
  const state = join(root, "state");
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  try {
    await init(state, { engine: "pi", port: 9445 });
    await addProject(state, { id: "demo", path: projectPath, title: "Demo" });
    const panel = await startControlPanel(state, { engine: "pi", port: 0 });
    try {
      assert.equal(panel.server.address().address, "127.0.0.1");
      const page = await fetch(panel.url);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /控制面板/);
      assert.match(html, /prefers-color-scheme:dark/);
      assert.match(html, /--panel-surface/);
      assert.match(html, /二维码（默认）/);
      assert.match(html, /链接配对/);
      assert.match(html, /全部项目（含电脑 App 里的项目）/);
      assert.doesNotMatch(html, /API Key/);

      const headers = { Authorization: "Bearer " + panel.token };
      const unauthorized = await fetch("http://127.0.0.1:" + panel.port + "/api/status");
      assert.equal(unauthorized.status, 401);
      const crossOrigin = await fetch("http://127.0.0.1:" + panel.port + "/api/status", {
        headers: { ...headers, Origin: "https://example.invalid" },
      });
      assert.equal(crossOrigin.status, 401);
      const response = await fetch("http://127.0.0.1:" + panel.port + "/api/status", { headers });
      assert.equal(response.status, 200);
      const snapshot = await response.json();
      assert.equal(snapshot.engine, "pi");
      assert.equal(snapshot.credential, undefined, "Pi resolves its own credentials");
      assert.equal(snapshot.projects[0].id, "demo");

      const inviteResponse = await fetch("http://127.0.0.1:" + panel.port + "/api/invite", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ projects: ["*"], role: "viewer" }),
      });
      assert.equal(inviteResponse.status, 200);
      const invitation = await inviteResponse.json();
      assert.equal(typeof invitation.invite.code, "string");
      assert.match(invitation.qrSvg, /^<svg[ >]/);
      assert.match(invitation.pairingLink, /^remotedesk:\/\/pair\?data=/);
      const link = JSON.parse(Buffer.from(invitation.pairingLink.split("data=")[1], "base64url").toString("utf8"));
      assert.equal(link.engine, "pi");

      const store = new Store(state);
      store.put("device", "device-1", {
        id: "device-1",
        name: "Test device",
        projects: ["demo"],
        role: "viewer",
        revoked: false,
        generation: 0,
        expires: Date.now() + 60_000,
      });
      store.close();
      const revokeResponse = await fetch("http://127.0.0.1:" + panel.port + "/api/revoke", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ device: "device-1" }),
      });
      assert.equal(revokeResponse.status, 200);
      assert.deepEqual((await revokeResponse.json()).result, { revoked: "device-1" });
    } finally {
      await panel.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
