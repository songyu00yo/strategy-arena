// Two fixed test ports keep concurrent worktrees away from the real preview port.
export function e2eAddress(value = process.env.E2E_PORT) {
  const port = value === undefined ? 3100 : Number(value);
  if (![3100, 3101].includes(port)) throw new Error("E2E_PORT must be 3100 or 3101.");
  return { port, origin: `http://127.0.0.1:${port}` };
}
