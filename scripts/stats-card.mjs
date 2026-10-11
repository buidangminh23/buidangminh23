import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const user = process.env.GITHUB_USER_NAME;
const token = process.env.GITHUB_TOKEN;
const output = process.env.OUTPUT_PATH ?? "dist/stats-card.svg";
const now = new Date();
const today = now.toISOString().slice(0, 10);

if (!user || !token) {
  throw new Error("GITHUB_USER_NAME and GITHUB_TOKEN are required");
}

const graphql = async (query, variables) => {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "profile-stats-card",
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status} ${await response.text()}`);
  }
  const payload = await response.json();
  if (payload.errors?.length || !payload.data?.user) {
    throw new Error(`GitHub GraphQL returned no data: ${JSON.stringify(payload.errors ?? payload)}`);
  }
  return payload.data.user;
};

const fetchRepositories = async () => {
  const repositories = [];
  let cursor = null;
  let profile = null;
  do {
    const page = await graphql(
      `query ($login: String!, $cursor: String) {
        user(login: $login) {
          followers { totalCount }
          contributionsCollection { contributionYears }
          repositories(ownerAffiliations: OWNER, privacy: PUBLIC, first: 100, after: $cursor) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes { stargazerCount }
          }
        }
      }`,
      { login: user, cursor },
    );
    profile = page;
    repositories.push(...page.repositories.nodes);
    cursor = page.repositories.pageInfo.hasNextPage ? page.repositories.pageInfo.endCursor : null;
  } while (cursor);
  return { profile, repositories };
};

const fetchYear = async (year) => {
  const from = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
  const to = yearEnd < now ? yearEnd : now;
  const data = await graphql(
    `query ($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }`,
    { login: user, from: from.toISOString(), to: to.toISOString() },
  );
  return data.contributionsCollection.contributionCalendar.weeks
    .flatMap((week) => week.contributionDays)
    .filter((day) => day.date.startsWith(`${year}-`));
};

const { profile, repositories } = await fetchRepositories();
const firstYear = Math.min(now.getUTCFullYear(), ...profile.contributionsCollection.contributionYears);
const years = Array.from({ length: now.getUTCFullYear() - firstYear + 1 }, (_, index) => firstYear + index);
const days = (await Promise.all(years.map(fetchYear)))
  .flat()
  .filter((day) => day.date <= today)
  .sort((a, b) => a.date.localeCompare(b.date));

if (days.length === 0) {
  throw new Error("No contribution days returned");
}

if (days.at(-1).date !== today || days.some((day) => !Number.isSafeInteger(day.contributionCount) || day.contributionCount < 0)) {
  throw new Error("Incomplete or invalid contribution calendar");
}
for (let index = 1; index < days.length; index += 1) {
  if (Date.parse(days[index].date) - Date.parse(days[index - 1].date) !== 86_400_000) {
    throw new Error("Contribution calendar contains missing or duplicate dates");
  }
}

const total = days.reduce((sum, day) => sum + day.contributionCount, 0);
const firstActive = days.find((day) => day.contributionCount > 0) ?? days[0];

let longest = { length: 0, start: null, end: null };
let run = { length: 0, start: null, end: null };
for (const day of days) {
  if (day.contributionCount > 0) {
    run = run.length === 0
      ? { length: 1, start: day.date, end: day.date }
      : { length: run.length + 1, start: run.start, end: day.date };
    if (run.length > longest.length) {
      longest = run;
    }
  } else {
    run = { length: 0, start: null, end: null };
  }
}

const lastIndex = days.length - 1;
const anchor = days[lastIndex].contributionCount > 0 ? lastIndex : lastIndex - 1;
let current = { length: 0, start: null, end: null };
for (let index = anchor; index >= 0 && days[index].contributionCount > 0; index -= 1) {
  current = {
    length: current.length + 1,
    start: days[index].date,
    end: current.end ?? days[index].date,
  };
}

const stars = repositories.reduce((sum, repository) => sum + repository.stargazerCount, 0);
const publicRepos = profile.repositories.totalCount;
const followers = profile.followers.totalCount;

const formatDay = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
const formatRange = (streak) =>
  streak.length === 0 ? "No active streak" : `${formatDay(streak.start)} - ${formatDay(streak.end)}`;
const formatNumber = (value) => value.toLocaleString("en-US");
const updated = `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;

const width = 900;
const height = 330;
const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const accent = "#ff4444";
const columns = [150, 450, 750];
const ringRadius = 44;
const circumference = Math.round(2 * Math.PI * ringRadius * 10) / 10;

const footerCell = (x, label, value) => `
  <text x="${x}" y="268" text-anchor="middle" font-size="24" font-weight="700" fill="#ffffff">${formatNumber(value)}</text>
  <text x="${x}" y="290" text-anchor="middle" font-size="12" letter-spacing="1.5" fill="#888888">${label}</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="GitHub stats for ${user}: ${total} total contributions, current streak ${current.length} days, longest streak ${longest.length} days, ${publicRepos} public repositories, ${stars} stars, ${followers} followers">
  <rect width="${width}" height="${height}" rx="10" fill="#0d0d0d"/>
  <g font-family="${font}">
    <text x="${columns[0]}" y="92" text-anchor="middle" font-size="34" font-weight="700" fill="#ffffff">${formatNumber(total)}</text>
    <text x="${columns[0]}" y="128" text-anchor="middle" font-size="15" fill="#ffffff">Total Contributions</text>
    <text x="${columns[0]}" y="154" text-anchor="middle" font-size="12" fill="#888888">${formatDay(firstActive.date)} - Present</text>

    <circle cx="${columns[1]}" cy="80" r="${ringRadius}" fill="none" stroke="${accent}" stroke-width="5" stroke-dasharray="${circumference}" stroke-linecap="round"/>
    <text x="${columns[1]}" y="92" text-anchor="middle" font-size="34" font-weight="700" fill="#ffffff">${formatNumber(current.length)}</text>
    <text x="${columns[1]}" y="156" text-anchor="middle" font-size="15" font-weight="700" fill="${accent}">Current Streak</text>
    <text x="${columns[1]}" y="180" text-anchor="middle" font-size="12" fill="#888888">${formatRange(current)}</text>

    <text x="${columns[2]}" y="92" text-anchor="middle" font-size="34" font-weight="700" fill="#ffffff">${formatNumber(longest.length)}</text>
    <text x="${columns[2]}" y="128" text-anchor="middle" font-size="15" fill="#ffffff">Longest Streak</text>
    <text x="${columns[2]}" y="154" text-anchor="middle" font-size="12" fill="#888888">${formatRange(longest)}</text>

    <line x1="300" y1="36" x2="300" y2="170" stroke="${accent}" stroke-opacity="0.6"/>
    <line x1="600" y1="36" x2="600" y2="170" stroke="${accent}" stroke-opacity="0.6"/>
    <line x1="40" y1="212" x2="${width - 40}" y2="212" stroke="#2a2a2a"/>
    ${footerCell(columns[0], "PUBLIC REPOS", publicRepos)}
    ${footerCell(columns[1], "TOTAL STARS", stars)}
    ${footerCell(columns[2], "FOLLOWERS", followers)}
    <text x="${width - 20}" y="${height - 12}" text-anchor="end" font-size="10" fill="#555555">Updated ${updated}</text>
  </g>
</svg>
`;

await mkdir(dirname(output), { recursive: true });
await writeFile(output, svg, "utf8");
console.log(
  JSON.stringify({ output, total, current, longest, publicRepos, stars, followers }),
);
