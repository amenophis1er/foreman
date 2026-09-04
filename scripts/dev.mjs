// Runs the API server and the Vite dev server together, prefixing each line
// with its source so the interleaved output stays readable.
// Zero dependencies so it doesn't go through the package-approval process.
import { spawn } from "node:child_process";

const procs = [
  ["server", ["npm", ["start"]]],
  ["ui", ["npm", ["--prefix", "ui", "run", "dev"]]],
];

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  process.exit();
}

const children = procs.map(([name, [cmd, args]]) => {
  const child = spawn(cmd, args, {
    env: { ...process.env, FORCE_COLOR: "1" },
    stdio: ["inherit", "pipe", "pipe"],
  });
  const forward = (stream, out) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) process.stdout.write(`${name} | ${line}\n`);
    });
  };
  forward(child.stdout);
  forward(child.stderr);
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`${name} exited (code ${code}) — shutting everything down`);
      shutdown();
    }
  });
  return child;
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);