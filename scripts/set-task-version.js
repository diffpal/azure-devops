const fs = require("node:fs");

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: node scripts/set-task-version.js <MAJOR.MINOR.PATCH>");
}

const [Major, Minor, Patch] = version.split(".").map((part) => Number.parseInt(part, 10));
for (const file of ["DiffPalReviewV1/task.json", "DiffPalReviewDevV1/task.json"]) {
  const task = JSON.parse(fs.readFileSync(file, "utf8"));
  task.version = { Major, Minor, Patch };
  fs.writeFileSync(file, `${JSON.stringify(task, null, 2)}\n`);
  console.log(`${file}: ${version}`);
}
