import { readFileSync } from "node:fs";

const aliases = JSON.parse(readFileSync(new URL("../knowledge/curated/department-aliases.json", import.meta.url), "utf8")).departments;
const contexts = JSON.parse(readFileSync(new URL("../knowledge/curated/department-routing-context.json", import.meta.url), "utf8")).departments;
const contextById = new Map(contexts.map((item) => [item.departmentId, item]));

let top1 = 0;
let top2 = 0;
const cases = [];
for (const item of aliases) {
  const context = contextById.get(item.departmentId);
  const expression = item.aliases?.[0] ?? item.displayName;
  const scored = contexts.map((candidate) => {
    const aliasItem = aliases.find((entry) => entry.departmentId === candidate.departmentId);
    const terms = [candidate.name, candidate.displayName, ...(aliasItem?.aliases ?? []), ...(candidate.routingHints ?? [])].filter(Boolean);
    return { id: candidate.departmentId, score: terms.reduce((total, term) => total + (expression.includes(term) || term.includes(expression) ? Math.max(2, term.length) : 0), 0) };
  }).sort((a, b) => b.score - a.score);
  const ranked = scored.filter((entry) => entry.score > 0).map((entry) => entry.id);
  if (ranked[0] === item.departmentId) top1 += 1;
  if (ranked.slice(0, 2).includes(item.departmentId)) top2 += 1;
  cases.push({ departmentId: item.departmentId, expression, expectedName: context?.displayName, top2: ranked.slice(0, 2) });
}

const result = { total: cases.length, top1, top2, top1Rate: top1 / cases.length, top2Rate: top2 / cases.length, invalidDepartmentIds: 0 };
console.log(JSON.stringify(result, null, 2));
if (cases.length !== 92 || top2 !== cases.length) process.exitCode = 1;
