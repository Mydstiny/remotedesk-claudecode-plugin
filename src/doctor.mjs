import { loadPi } from "./pi-runtime.mjs";

export const ADAPTER_VERSION = "0.3.0";

/** Checks Node, the user's Pi install and whether Pi has a signed-in provider; never runs a model turn. */
export async function doctor({ probe = false, env = process.env, load = loadPi } = {}) {
  const report = {
    schemaVersion: 1,
    status: "blocked",
    changed: false,
    componentVersions: { adapter: ADAPTER_VERSION, node: process.versions.node, pi: null },
    checks: [],
    actions: [],
    requiresUserAction: [],
    warnings: [],
    capabilities: { remoteAccess: true, remoteProtocol: 1, proEntitlement: "pro.lifetime", appExposure: true },
  };
  const check = (id, status, code, detail) => report.checks.push({ id, status, code, ...(detail ? { detail } : {}) });
  try {
    if (Number(process.versions.node.split(".")[0]) < 22) throw Object.assign(new Error("NODE_VERSION_UNSUPPORTED"), { code: "NODE_VERSION_UNSUPPORTED" });
    check("node", "pass", "NODE_22_OR_NEWER");
    const pi = await load(env);
    report.componentVersions.pi = pi.version;
    check("pi", "pass", "PI_SDK_FOUND", pi.directory);
    const runtime = await pi.sdk.ModelRuntime.create();
    const available = await runtime.getAvailable();
    const providers = [...new Set(available.map((model) => model.provider))];
    if (available.length) check("models", "pass", "PI_MODELS_AVAILABLE", providers.join(", ") + " · " + available.length + " models");
    else {
      check("models", "warn", "PI_LOGIN_REQUIRED");
      report.requiresUserAction.push("PI_LOGIN_REQUIRED");
    }
    if (probe) {
      const sessions = await pi.sdk.SessionManager.listAll();
      check("sessions", "pass", "PI_SESSIONS_READABLE", sessions.length + " sessions in " + pi.sdk.getAgentDir());
      report.warnings.push("NO_MODEL_TURN_PERFORMED");
    }
    report.status = "ok";
  } catch (error) {
    const code = error?.code || error?.message || "PI_PROBE_FAILED";
    check("probe", "fail", code);
    report.requiresUserAction.push(code === "PI_NOT_INSTALLED" ? "INSTALL_PI" : code === "PI_VERSION_UNSUPPORTED" ? "UPDATE_PI" : "CHECK_PI");
  }
  return report;
}
