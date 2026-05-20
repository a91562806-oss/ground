import { findTeam } from "@/lib/teams";

export const OFFICIAL_HIGHLIGHT_CHANNELS = [
  {
    id: "UCoVz66yWHzVsXAFG8WhJK9g",
    label: "@kbo",
  },
  {
    id: "UC8JtQf77wqhVpOQ8Cze8JjA",
    label: "@tvingsports",
  },
] as const;

export type HighlightEntry = {
  channelId: string;
  channelLabel: string;
  videoId: string;
  title: string;
  url: string;
  publishedAt: Date | null;
};

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\[\]\(\)\-_:|/.,!?\s]/g, "");
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function teamKeywordCandidates(teamId: string): string[] {
  const team = findTeam(teamId);
  const aliases: Record<string, string[]> = {
    lg: ["엘지", "트윈스"],
    kia: ["기아", "타이거즈"],
    samsung: ["삼성", "라이온즈"],
    doosan: ["두산", "베어스", "ob"],
    lotte: ["롯데", "자이언츠"],
    hanwha: ["한화", "이글스"],
    ssg: ["ssg", "랜더스", "sk"],
    nc: ["nc", "엔씨", "다이노스"],
    kt: ["kt", "위즈"],
    kiwoom: ["키움", "히어로즈", "wo"],
  };
  const raw = [
    team.short,
    team.shortEn,
    team.name,
    team.nameEn,
    team.name.split(" ")[0] ?? "",
    team.nameEn.split(" ")[0] ?? "",
    ...(aliases[teamId] ?? []),
  ];
  return [...new Set(raw.map((value) => normalizeText(value)).filter((value) => value.length > 0))];
}

function titleMatchesTeams(title: string, homeTeamId: string, awayTeamId: string): boolean {
  const normalized = normalizeText(title);
  if (!normalized.includes(normalizeText("하이라이트"))) return false;
  const homeTokens = teamKeywordCandidates(homeTeamId);
  const awayTokens = teamKeywordCandidates(awayTeamId);
  const hasHome = homeTokens.some((token) => normalized.includes(token));
  const hasAway = awayTokens.some((token) => normalized.includes(token));
  return hasHome && hasAway;
}

function parseRss(xml: string, channelId: string, channelLabel: string): HighlightEntry[] {
  const entries: HighlightEntry[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(xml)) !== null) {
    const chunk = match[1];
    const id = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(chunk)?.[1]?.trim();
    const titleRaw = /<title>([\s\S]*?)<\/title>/.exec(chunk)?.[1];
    const link = /<link[^>]+href="([^"]+)"/.exec(chunk)?.[1]?.trim();
    const publishedRaw = /<published>([^<]+)<\/published>/.exec(chunk)?.[1]?.trim();
    if (!id || !titleRaw) continue;
    const title = decodeXml(titleRaw.trim());
    const url = link && link.startsWith("http") ? link : `https://www.youtube.com/watch?v=${id}`;
    const publishedAtMs = publishedRaw ? Date.parse(publishedRaw) : Number.NaN;
    entries.push({
      channelId,
      channelLabel,
      videoId: id,
      title,
      url,
      publishedAt: Number.isFinite(publishedAtMs) ? new Date(publishedAtMs) : null,
    });
  }
  return entries;
}

export async function fetchOfficialHighlightEntries(limitPerChannel = 12): Promise<HighlightEntry[]> {
  const feeds = await Promise.all(
    OFFICIAL_HIGHLIGHT_CHANNELS.map(async (channel) => {
      const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`;
      try {
        const res = await fetch(url, {
          headers: {
            "user-agent": "Mozilla/5.0 GroundBot/1.0",
            accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
          },
          cache: "no-store",
        });
        if (!res.ok) return [] as HighlightEntry[];
        const xml = await res.text();
        return parseRss(xml, channel.id, channel.label).slice(0, limitPerChannel);
      } catch {
        return [] as HighlightEntry[];
      }
    })
  );
  return feeds.flat();
}

export function pickMatchingHighlightForGame(
  entries: HighlightEntry[],
  game: { homeTeam: string; awayTeam: string }
): HighlightEntry | null {
  const matched = entries.filter((entry) =>
    titleMatchesTeams(entry.title, game.homeTeam, game.awayTeam)
  );
  if (matched.length === 0) return null;
  matched.sort((a, b) => {
    const aMs = a.publishedAt?.getTime() ?? 0;
    const bMs = b.publishedAt?.getTime() ?? 0;
    return bMs - aMs;
  });
  return matched[0] ?? null;
}
