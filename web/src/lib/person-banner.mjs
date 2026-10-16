/**
 * Identity line for every page. Launch sets the person and port. An unset
 * launch is Armando on the default port.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} root
 */
export function personBanner(env, root) {
  const name = env.CAREER_OPS_PERSON?.trim() || "Armando";
  const port = env.CAREER_OPS_WEB_PORT?.trim() || "3000";
  return { name, root, port, label: `${name} · ${root} · port ${port}` };
}
