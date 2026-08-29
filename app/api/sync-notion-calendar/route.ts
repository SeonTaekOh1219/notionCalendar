// app/api/sync-notion-calendar/route.ts
//
// Notion 데이터베이스 → Google Calendar 단방향 동기화
// Vercel Cron이 주기적으로 호출한다. Notion 페이지 ID를 그대로 구글 이벤트 ID로
// 쓰기 때문에 몇 번을 돌려도 중복이 생기지 않는다(멱등).

import { NextResponse } from "next/server";
import { Client } from "@notionhq/client";
import { google, calendar_v3 } from "googleapis";

export const runtime = "nodejs";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────
// 설정: 본인 Notion DB에 맞게 속성 이름만 바꾸면 된다
// ─────────────────────────────────────────────────────────────
const PROP = {
  title: "Name",       // 제목(title) 속성
  date: "Due Date",    // 날짜(date) 속성  ← 필수
  status: "Status",    // 셀렉트 속성. 제목 앞에 아이콘으로 붙는다. 없으면 null
  location: null,      // 텍스트/셀렉트 속성. 없으면 null로 두면 무시된다
  notes: null,         // 텍스트 속성. 없으면 null
} as {
  title: string;
  date: string;
  status: string | null;
  location: string | null;
  notes: string | null;
};

// Status 값 → 제목 앞에 붙일 아이콘.
// 여기 없는 값이나 빈 값은 아이콘 없이 제목만 나간다.
const STATUS_ICON: Record<string, string> = {
  Completed: "✅",
  "In Progress": "🔄",
  "Next Up": "⬜",
};

const TIME_ZONE = "Asia/Seoul";
const PAST_DAYS = 30;    // 며칠 전까지 동기화할지
const FUTURE_DAYS = 365; // 며칠 후까지 동기화할지

// ─────────────────────────────────────────────────────────────

const notion = new Client({
  auth: process.env.NOTION_TOKEN!,
});

// SDK v5(API 2025-09-03)부터 데이터베이스 하나가 여러 개의 data source를 가질 수
// 있게 바뀌었고, 쿼리는 database가 아니라 data source에 대고 한다.
// NOTION_DATA_SOURCE_ID를 직접 넣어도 되고, 없으면 DB에서 첫 번째 것을 찾아 쓴다.
let dataSourceIdCache: string | undefined;

async function getDataSourceId(): Promise<string> {
  if (dataSourceIdCache) return dataSourceIdCache;

  const fromEnv = process.env.NOTION_DATA_SOURCE_ID;
  if (fromEnv) {
    dataSourceIdCache = fromEnv;
    return fromEnv;
  }

  const db: any = await notion.databases.retrieve({
    database_id: process.env.NOTION_DATABASE_ID!,
  });
  const id = db.data_sources?.[0]?.id;
  if (!id) {
    throw new Error(
      "이 데이터베이스에서 data source를 찾지 못했다. NOTION_DATA_SOURCE_ID를 직접 지정해라."
    );
  }
  dataSourceIdCache = id;
  return id;
}

function getCalendar(): calendar_v3.Calendar {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL!,
    key: process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  return google.calendar({ version: "v3", auth });
}

// ── 날짜 유틸 ────────────────────────────────────────────────

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

// ── Notion 속성 읽기 ─────────────────────────────────────────

function readTitle(prop: any): string {
  const parts = prop?.title ?? [];
  const text = parts.map((t: any) => t.plain_text).join("").trim();
  return text || "(제목 없음)";
}

function readText(prop: any): string | undefined {
  if (!prop) return undefined;
  if (prop.type === "rich_text") {
    const t = prop.rich_text.map((r: any) => r.plain_text).join("").trim();
    return t || undefined;
  }
  if (prop.type === "select") return prop.select?.name ?? undefined;
  if (prop.type === "url") return prop.url ?? undefined;
  return undefined;
}

// Notion 페이지 ID(UUID) → 구글 이벤트 ID
// 구글은 소문자 a~v와 숫자만 허용하는데, UUID는 16진수라 그대로 들어간다.
function toEventId(pageId: string): string {
  return "n" + pageId.replace(/-/g, "").toLowerCase();
}

// ── Notion 페이지 → 구글 이벤트 ──────────────────────────────

function toEvent(page: any): calendar_v3.Schema$Event | null {
  const props = page.properties;
  const date = props[PROP.date]?.date;
  if (!date?.start) return null; // 날짜 없는 항목은 건너뛴다

  const isAllDay = !date.start.includes("T");

  let start: calendar_v3.Schema$EventDateTime;
  let end: calendar_v3.Schema$EventDateTime;

  if (isAllDay) {
    // 구글의 종일 일정은 end가 '다음 날'이어야 한다 (exclusive)
    const endDate = date.end ? addDays(date.end, 1) : addDays(date.start, 1);
    start = { date: date.start };
    end = { date: endDate };
  } else {
    const endIso =
      date.end ?? new Date(new Date(date.start).getTime() + 60 * 60 * 1000).toISOString();
    start = { dateTime: date.start, timeZone: date.time_zone ?? TIME_ZONE };
    end = { dateTime: endIso, timeZone: date.time_zone ?? TIME_ZONE };
  }

  const status = PROP.status ? readText(props[PROP.status]) : undefined;
  const icon = status ? STATUS_ICON[status] : undefined;
  const title = readTitle(props[PROP.title]);

  const notes = PROP.notes ? readText(props[PROP.notes]) : undefined;
  const description = [notes, `Notion에서 열기: ${page.url}`]
    .filter(Boolean)
    .join("\n\n");

  return {
    id: toEventId(page.id),
    summary: icon ? `${icon} ${title}` : title,
    location: PROP.location ? readText(props[PROP.location]) : undefined,
    description,
    start,
    end,
    source: { title: "Notion", url: page.url },
    // 이 마커가 있어야 '내가 만든 이벤트'만 골라서 정리할 수 있다
    extendedProperties: { private: { source: "notion", pageId: page.id } },
  };
}

// ── Notion에서 대상 페이지 전부 가져오기 ─────────────────────

async function fetchNotionPages(from: string, to: string): Promise<any[]> {
  const pages: any[] = [];
  let cursor: string | undefined = undefined;
  const dataSourceId = await getDataSourceId();

  do {
    const res: any = await notion.dataSources.query({
      data_source_id: dataSourceId,
      filter: {
        and: [
          { property: PROP.date, date: { on_or_after: from } },
          { property: PROP.date, date: { on_or_before: to } },
        ],
      },
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return pages;
}

// ── 캘린더에 이미 있는 '노션발' 이벤트 목록 ──────────────────

async function fetchExistingEventIds(
  cal: calendar_v3.Calendar,
  timeMin: string,
  timeMax: string
): Promise<Set<string>> {
  const ids = new Set<string>();
  let pageToken: string | undefined = undefined;

  do {
    const res: any = await cal.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID!,
      privateExtendedProperty: ["source=notion"],
      timeMin,
      timeMax,
      showDeleted: false,
      singleEvents: false,
      maxResults: 2500,
      pageToken,
    });
    for (const e of res.data.items ?? []) if (e.id) ids.add(e.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return ids;
}

// ── 메인 ─────────────────────────────────────────────────────

export async function GET(request: Request) {
  // Vercel Cron은 CRON_SECRET을 Authorization 헤더로 보내준다
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  const now = new Date();
  const from = ymd(new Date(now.getTime() - PAST_DAYS * 86400_000));
  const to = ymd(new Date(now.getTime() + FUTURE_DAYS * 86400_000));

  const cal = getCalendar();
  const calendarId = process.env.GOOGLE_CALENDAR_ID!;

  const [pages, existingIds] = await Promise.all([
    fetchNotionPages(from, to),
    fetchExistingEventIds(cal, `${from}T00:00:00Z`, `${to}T23:59:59Z`),
  ]);

  const stats = { created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0 };
  const seen = new Set<string>();

  for (const page of pages) {
    const event = toEvent(page);
    if (!event?.id) {
      stats.skipped++;
      continue;
    }
    seen.add(event.id);

    try {
      if (existingIds.has(event.id)) {
        await cal.events.update({ calendarId, eventId: event.id, requestBody: event });
        stats.updated++;
      } else {
        try {
          await cal.events.insert({ calendarId, requestBody: event });
          stats.created++;
        } catch (err: any) {
          // 예전에 지웠던 ID를 다시 쓰면 409가 난다 → 되살린다
          if (err?.code === 409) {
            await cal.events.update({ calendarId, eventId: event.id, requestBody: event });
            stats.updated++;
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      console.error(`sync failed for ${page.id}`, err);
      stats.failed++;
    }
  }

  // Notion에서 사라졌거나 날짜가 지워진 일정은 캘린더에서도 제거
  for (const id of existingIds) {
    if (seen.has(id)) continue;
    try {
      await cal.events.delete({ calendarId, eventId: id });
      stats.deleted++;
    } catch (err: any) {
      if (err?.code !== 410 && err?.code !== 404) {
        console.error(`delete failed for ${id}`, err);
        stats.failed++;
      }
    }
  }

  return NextResponse.json({ ok: true, range: { from, to }, ...stats });
}
