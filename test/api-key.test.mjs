import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { init, addProject } from "../packages/bridge-core/lib/admin.mjs";
import { startControlPanel } from "../src/control-panel.mjs";
import { ClaudeAdapter } from "../src/claude-adapter.mjs";
import {
  API_KEY_FILE,
  apiKeyCommand,
  apiKeyEnvironment,
  apiKeyStatus,
  clearApiKey,
  readApiKey,
  saveApiKey,
} from "../src/api-key.mjs";

const KEY = "sk-ant-api03-" + "A".repeat(40) + "wxyz";

async function withState(run) {
  const root = await mkdtemp(join(tmpdir(), "remotedesk-claude-key-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the API key is read from the environment first, then the private state file", async () => {
  await withState(async (state) => {
    assert.deepEqual(await readApiKey(state, {}), { key: "", source: "none" });
    await saveApiKey(state, "  " + KEY + "\n");
    assert.deepEqual(await readApiKey(state, {}), { key: KEY, source: "file" });
    assert.equal((await stat(join(state, API_KEY_FILE))).mode & 0o777, 0o600);
    const other = "sk-ant-api03-" + "B".repeat(40);
    assert.deepEqual(await readApiKey(state, { ANTHROPIC_API_KEY: other }), { key: other, source: "environment" });
    assert.deepEqual(await apiKeyStatus(state, {}),
      { kind: "anthropicApiKey", required: true, configured: true, source: "file", hint: "…wxyz" });
    await clearApiKey(state);
    await clearApiKey(state);
    assert.equal((await apiKeyStatus(state, {})).configured, false);
  });
});

test("only Anthropic API keys are saved, and the command reads the key from stdin", async () => {
  await withState(async (state) => {
    for (const bad of ["", "sk-ant-short", "not-a-key-" + "x".repeat(40), KEY + " extra", 42])
      await assert.rejects(saveApiKey(state, bad), { code: "API_KEY_INVALID" });
    const status = await apiKeyCommand(state, "set", Readable.from([KEY + "\n"]));
    assert.equal(status.configured, true);
    assert.equal(JSON.stringify(status).includes(KEY), false);
    assert.equal((await readFile(join(state, API_KEY_FILE), "utf8")).trim(), KEY);
    assert.equal((await apiKeyCommand(state, "clear")).configured, false);
    await assert.rejects(apiKeyCommand(state, "rotate"), { code: "API_KEY_ACTION_INVALID" });
  });
});

test("the child environment can only authenticate with the configured key", () => {
  const env = apiKeyEnvironment({ PATH: "/bin", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDE_CODE_USE_BEDROCK: "1" }, KEY);
  assert.deepEqual(env, { PATH: "/bin", ANTHROPIC_API_KEY: KEY });
});

function fakeSdk(account) {
  const calls = [];
  return {
    calls,
    query({ options }) {
      calls.push(options);
      let closed = false;
      return {
        initializationResult: async () => ({ session_id: "upstream-1", model: "claude-test", account }),
        close() { closed = true; },
        async *[Symbol.asyncIterator]() { while (!closed) await new Promise((resolve) => setTimeout(resolve, 5)); },
      };
    },
  };
}

test("sessions refuse to start without an API key or on any other credential", async () => {
  await withState(async (state) => {
    const project = { id: "demo", path: state };
    const noKey = fakeSdk({ apiKeySource: "ANTHROPIC_API_KEY" });
    const adapter = new ClaudeAdapter({ sdk: noKey, env: { PATH: "/bin" }, state });
    await assert.rejects(adapter.open({ id: "s1", project: "demo" }, project), { code: "CLAUDE_API_KEY_REQUIRED" });
    assert.equal(noKey.calls.length, 0);

    await saveApiKey(state, KEY);
    const subscription = fakeSdk({ apiKeySource: "none", tokenSource: "claude.ai" });
    const viaLogin = new ClaudeAdapter({ sdk: subscription, env: { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "o" }, state });
    await assert.rejects(viaLogin.open({ id: "s2", project: "demo" }, project), { code: "CLAUDE_API_KEY_REQUIRED" });
    assert.equal(viaLogin.handles.size, 0);

    const keyed = fakeSdk({ apiKeySource: "ANTHROPIC_API_KEY" });
    const adapterWithKey = new ClaudeAdapter({ sdk: keyed, env: { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "o" }, state });
    const session = { id: "s3", project: "demo" };
    await adapterWithKey.open(session, project);
    assert.equal(session.upstream, "upstream-1");
    assert.equal(keyed.calls[0].env.ANTHROPIC_API_KEY, KEY);
    assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in keyed.calls[0].env, false);
    assert.equal(keyed.calls[0].env.CLAUDE_AGENT_SDK_CLIENT_APP, "remotedesk-claude-agent/0.2.0");
    await adapterWithKey.close();
  });
});

test("the control panel shows and manages the key without ever returning it", async () => {
  await withState(async (root) => {
    const state = join(root, "state");
    const projectPath = join(root, "project");
    await mkdir(projectPath);
    await init(state, { engine: "claudecode", port: 9445 });
    await addProject(state, { id: "demo", path: projectPath, title: "Demo" });
    const panel = await startControlPanel(state, { engine: "claudecode", port: 0 });
    try {
      const html = await (await fetch(panel.url)).text();
      assert.match(html, /Anthropic API Key/);
      const base = "http://127.0.0.1:" + panel.port;
      const headers = { Authorization: "Bearer " + panel.token, "Content-Type": "application/json" };
      const before = await (await fetch(base + "/api/status", { headers })).json();
      assert.equal(before.credential.configured, false);
      const invalid = await fetch(base + "/api/credential", { method: "POST", headers, body: JSON.stringify({ apiKey: "nope" }) });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error, "API_KEY_INVALID");
      const saved = await fetch(base + "/api/credential", { method: "POST", headers, body: JSON.stringify({ apiKey: KEY }) });
      const savedText = await saved.text();
      assert.equal(saved.status, 200);
      assert.equal(savedText.includes(KEY), false);
      const after = await (await fetch(base + "/api/status", { headers })).text();
      assert.equal(after.includes(KEY), false);
      assert.equal(JSON.parse(after).credential.hint, "…wxyz");
      const cleared = await (await fetch(base + "/api/credential/clear", { method: "POST", headers, body: "{}" })).json();
      assert.equal(cleared.credential.configured, false);
    } finally {
      await panel.close();
    }
  });
});
