import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const user = process.env.GITHUB_USER_NAME;
const token = process.env.GITHUB_TOKEN;
const output = process.env.OUTPUT_PATH ?? "dist/activity-graph.svg";
const dayCount = 31;

if (!user || !token) {
  throw new Error("GITHUB_USER_NAME and GITHUB_TOKEN are required");
}

const to = new Date();
const from = new Date(to.getTime() - (dayCount - 1) * 86_400_000);

const response = await fetch("https://api.github.com/graphql", {
  method: "POST",
  headers: {
    authorization: `bearer ${token}`,
    "content-type": "application/json",
    "user-agent": "profile-activity-graph",
  },
  body: JSON.stringify({
    query: `query ($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }`,
    variables: { login: user, from: from.toISOString(), to: to.toISOString() },
  }),
});

if (!response.ok) {
  throw new Error(`GitHub GraphQL request failed: ${response.status} ${await response.text()}`);
}

const payload = await response.json();
if (payload.errors?.length || !payload.data?.user) {
  throw new Error(`GitHub GraphQL returned no data: ${JSON.stringify(payload.errors ?? payload)}`);
}

const days = payload.data.user.contributionsCollection.contributionCalendar.weeks
  .flatMap((week) => week.contributionDays)
  .slice(-dayCount);

if (days.length < 2) {
  throw new Error(`Expected at least 2 contribution days, received ${days.length}`);
}

const width = 1000;
const height = 380;
const plot = { left: 64, right: 968, top: 84, bottom: 316 };
const counts = days.map((day) => day.contributionCount);
const total = counts.reduce((sum, count) => sum + count, 0);
const peak = Math.max(...counts);

const niceStep = (value) => {
  const rough = Math.max(value, 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const candidates = [1, 2, 5, 10].map((factor) => factor * magnitude);
  return Math.max(1, candidates.find((candidate) => candidate >= rough));
};

const step = niceStep(peak);
const axisMax = Math.max(step, Math.ceil(peak / step) * step);
const round = (value) => Math.round(value * 10) / 10;
const xAt = (index) => plot.left + ((plot.right - plot.left) * index) / (days.length - 1);
const yAt = (count) => plot.bottom - ((plot.bottom - plot.top) * count) / axisMax;
const points = counts.map((count, index) => ({ x: xAt(index), y: yAt(count) }));

const tangents = (() => {
  const n = points.length;
  const slopes = [];
  for (let i = 0; i < n - 1; i += 1) {
    slopes.push((points[i + 1].y - points[i].y) / (points[i + 1].x - points[i].x));
  }
  const result = [slopes[0]];
  for (let i = 1; i < n - 1; i += 1) {
    result.push(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2);
  }
  result.push(slopes[n - 2]);
  for (let i = 0; i < n - 1; i += 1) {
    if (slopes[i] === 0) {
      result[i] = 0;
      result[i + 1] = 0;
      continue;
    }
    const a = result[i] / slopes[i];
    const b = result[i + 1] / slopes[i];
    const length = Math.hypot(a, b);
    if (length > 3) {
      result[i] = (3 * a * slopes[i]) / length;
      result[i + 1] = (3 * b * slopes[i]) / length;
    }
  }
  return result;
})();

let line = `M${round(points[0].x)},${round(points[0].y)}`;
for (let i = 0; i < points.length - 1; i += 1) {
  const dx = (points[i + 1].x - points[i].x) / 3;
  line += ` C${round(points[i].x + dx)},${round(points[i].y + tangents[i] * dx)}`;
  line += ` ${round(points[i + 1].x - dx)},${round(points[i + 1].y - tangents[i + 1] * dx)}`;
  line += ` ${round(points[i + 1].x)},${round(points[i + 1].y)}`;
}
const area = `${line} L${round(plot.right)},${plot.bottom} L${round(plot.left)},${plot.bottom} Z`;

const monthDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const label = (date) => monthDay.format(new Date(`${date}T00:00:00Z`));

const grid = [];
for (let value = 0; value <= axisMax; value += step) {
  const y = round(yAt(value));
  grid.push(
    `<line x1="${plot.left}" y1="${y}" x2="${plot.right}" y2="${y}" stroke="#ffffff" stroke-opacity="${value === 0 ? 0.28 : 0.08}"/>`,
    `<text x="${plot.left - 12}" y="${y + 4}" text-anchor="end" class="axis">${value}</text>`,
  );
}

const ticks = days
  .map((day, index) => ({ day, index }))
  .filter(({ index }) => (days.length - 1 - index) % 5 === 0)
  .map(({ day, index }) => `<text x="${round(xAt(index))}" y="${plot.bottom + 26}" text-anchor="middle" class="axis">${label(day.date)}</text>`);

const dots = points.map(
  (point, index) =>
    `<circle cx="${round(point.x)}" cy="${round(point.y)}" r="3.5" fill="#ffffff" stroke="#ff4444" stroke-width="1.5"><title>${label(days[index].date)}: ${counts[index]} contributions</title></circle>`,
);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="title desc">
<title id="title">${user} contribution activity</title>
<desc id="desc">${total} contributions between ${label(days[0].date)} and ${label(days.at(-1).date)}, peaking at ${peak} in one day.</desc>
<style>
.title{font:600 20px 'Segoe UI',Ubuntu,Helvetica,Arial,sans-serif;fill:#ff4444}
.meta{font:400 13px 'Segoe UI',Ubuntu,Helvetica,Arial,sans-serif;fill:#b8b8b8}
.axis{font:400 12px 'Segoe UI',Ubuntu,Helvetica,Arial,sans-serif;fill:#9a9a9a}
</style>
<defs>
<linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#ff4444" stop-opacity="0.38"/>
<stop offset="1" stop-color="#ff4444" stop-opacity="0.02"/>
</linearGradient>
</defs>
<rect width="${width}" height="${height}" rx="8" fill="#0d0d0d"/>
<text x="${plot.left}" y="42" class="title">Contribution activity</text>
<text x="${plot.left}" y="64" class="meta">Last ${days.length} days · ${total} contributions · peak ${peak}/day</text>
${grid.join("\n")}
<path d="${area}" fill="url(#fill)"/>
<path d="${line}" fill="none" stroke="#ff4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
${dots.join("\n")}
${ticks.join("\n")}
</svg>
`;

await mkdir(dirname(output), { recursive: true });
await writeFile(output, svg, "utf8");
console.log(`Wrote ${output}: ${days.length} days, ${total} contributions, peak ${peak}`);
