export async function herdrPane(...args: string[]): Promise<unknown> {
  const proc = Bun.spawn([process.env["HERDR_BIN_PATH"] || "herdr", "pane", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (!out.trim()) {
    if (code !== 0) throw new Error(err.trim().split("\n").at(-1) || `herdr pane ${args[0]} 실패 (${code})`);
    return {};
  }
  const reply = JSON.parse(out) as { result?: unknown; error?: { message?: string } };
  if (reply.error) throw new Error(reply.error.message ?? JSON.stringify(reply.error));
  return reply.result;
}
