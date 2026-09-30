import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MIN_FIRMWARE, MIN_PROTOCOL_VERSION, type Config } from "./config.js";
import { InceptionApiError, type InceptionClient } from "./client.js";
import { STATE_TABLES, decodeFlags, type ItemType } from "./decode.js";
import { CATEGORIES, MESSAGE_TYPES, messageType } from "./messages.js";

const ZERO_GUID = "00000000-0000-0000-0000-000000000000";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

const fail = (e: unknown): ToolResult => {
  let msg = e instanceof Error ? e.message : String(e);
  if (e instanceof InceptionApiError) {
    const hint = e.hint();
    if (hint) msg += `\nHint: ${hint}`;
  }
  return { content: [{ type: "text", text: msg }], isError: true };
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Pull the entries out of a *Summary response ({ Areas: { id: {...} } }, or an array). */
function summaryEntries(summary: any): any[] {
  const isEntry = (x: any) => x && typeof x === "object" && "EntityInfo" in x;
  if (Array.isArray(summary)) return summary.filter(isEntry);
  if (summary && typeof summary === "object") {
    for (const v of Object.values(summary)) {
      if (Array.isArray(v)) return v.filter(isEntry);
      if (v && typeof v === "object") {
        const vals = Object.values(v as object);
        if (vals.length === 0 || isEntry(vals[0])) return vals.filter(isEntry);
      }
    }
  }
  return [];
}

function shapeItem(type: ItemType, e: any) {
  const info = e.EntityInfo ?? {};
  const value = e.CurrentState;
  const out: Record<string, unknown> = {
    id: info.ID,
    name: info.Name,
    reportingId: info.ReportingID,
    state: decodeFlags(STATE_TABLES[type], value),
    stateValue: value,
    lastStateChangeTime: e.LastStateChangeTime,
  };
  if (type === "area") {
    out.armInfo = e.ArmInfo;
    out.associatedInputs = (e.AssociatedInputs ?? []).map((i: any) => ({ id: i.Input, name: i.InputName }));
  } else if (type === "door") {
    out.attachedReaders = (e.AttachedReaders ?? []).map((r: any) => ({ id: r.ID, name: r.Name, location: r.Location }));
  } else if (type === "input") {
    out.isCustomInput = info.IsCustomInput;
    out.inputType = info.InputType;
  }
  return out;
}

export function registerTools(server: McpServer, client: InceptionClient, cfg: Config): void {
  server.registerTool(
    "inception_get_system_info",
    {
      title: "Inception system info",
      description:
        "Returns the Inception controller's name, serial number and REST API protocol version, and whether the firmware is supported (7.3.0.8528 or later, protocol version 18). Use it to confirm connectivity.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const [protocolVersion, sys] = await Promise.all([
          client.protocolVersion(),
          client.get<{ SystemName?: string; SerialNumber?: string }>("/api/v1/system-info"),
        ]);
        return ok({
          systemName: sys.SystemName,
          serialNumber: sys.SerialNumber,
          protocolVersion,
          requiredProtocolVersion: MIN_PROTOCOL_VERSION,
          requiredFirmware: `${MIN_FIRMWARE} or later`,
          supported: protocolVersion >= MIN_PROTOCOL_VERSION,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "inception_list_items",
    {
      title: "List Inception items with current state",
      description:
        "Lists areas, doors, inputs or outputs the API user can see, each with its current state decoded into names. " +
        "Area states include Armed, Disarmed, Alarm, EntryDelay, ExitDelay, ArmReady, AwayArm (Full), StayArm (Perimeter), SleepArm (Night). " +
        "Door states include Locked, Unlocked, Open, Closed, Forced, HeldOpenTooLong, LockedOut. " +
        "Input states include Active (unsealed/open), Sealed, Tamper, Isolated. Output states are On/Off. " +
        "Use has_state to filter, e.g. type=input with has_state=[\"Active\"] lists open zones.",
      inputSchema: {
        type: z.enum(["area", "door", "input", "output"]).describe("Kind of item to list."),
        name_contains: z.string().optional().describe("Case-insensitive substring to match against the item name."),
        has_state: z
          .array(z.string())
          .optional()
          .describe("Only return items whose decoded state includes ALL of these names (case-insensitive)."),
        limit: z.number().int().min(1).max(500).default(200).describe("Maximum items to return."),
      },
      annotations: READ_ONLY,
    },
    async ({ type, name_contains, has_state, limit }) => {
      try {
        const raw = await client.get(`/api/v1/control/${type}/summary`);
        let items = summaryEntries(raw).map((e) => shapeItem(type, e));
        const total = items.length;
        if (name_contains) {
          const n = name_contains.toLowerCase();
          items = items.filter((i) => String(i.name ?? "").toLowerCase().includes(n));
        }
        if (has_state?.length) {
          const want = has_state.map((s) => s.toLowerCase());
          items = items.filter((i) => {
            const have = (i.state as string[]).map((s) => s.toLowerCase());
            return want.every((w) => have.includes(w));
          });
        }
        const matched = items.length;
        return ok({ type, total, matched, returned: Math.min(matched, limit), items: items.slice(0, limit) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "inception_get_events",
    {
      title: "Query Inception review events",
      description:
        "Queries the controller's review (event) log. Returns most recent first by default. Each event has a numeric messageId, its category " +
        "(System, Audit, Access, Security, Hardware, Integration), an event type name and the panel's description, plus who/what/where. " +
        "Filter by time range, category, message IDs (use inception_list_event_types to find IDs, e.g. area armed/disarmed) or involved item IDs. " +
        "For paging use offset, or reference_id + reference_time from an earlier event instead of start/end.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(50).describe("Maximum events to return (panel default is 100)."),
        offset: z.number().int().min(0).default(0).describe("Events to skip, for pagination."),
        direction: z.enum(["asc", "desc"]).default("desc").describe("desc = newest first, asc = oldest first."),
        start: z.string().optional().describe("ISO 8601 start of range, e.g. 2026-09-25T09:00:00. Not combinable with reference_id."),
        end: z.string().optional().describe("ISO 8601 end of range. Not combinable with reference_id."),
        categories: z.array(z.enum(CATEGORIES)).optional().describe("Only these event categories."),
        message_ids: z.array(z.number().int().min(0)).optional().describe("Only these numeric event type IDs."),
        involved_ids: z.array(z.string().uuid()).optional().describe("Only events whose who/what/where ID matches one of these item or user IDs."),
        reference_id: z.string().uuid().optional().describe("ID of an anchor event (use with reference_time). Not combinable with start/end."),
        reference_time: z.string().optional().describe("ReferenceTime of the anchor event."),
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        if ((a.start || a.end) && (a.reference_id || a.reference_time)) {
          throw new Error("start/end cannot be combined with reference_id/reference_time.");
        }
        if (!!a.reference_id !== !!a.reference_time) {
          throw new Error("reference_id and reference_time must be provided together.");
        }
        for (const [k, v] of [["start", a.start], ["end", a.end]] as const) {
          if (v && Number.isNaN(Date.parse(v))) throw new Error(`${k} is not a valid ISO 8601 date/time: ${v}`);
        }
        const raw = await client.get<{ Offset: number; Count: number; Data: any[] }>("/api/v1/review", {
          limit: a.limit,
          offset: a.offset,
          dir: a.direction,
          start: a.start,
          end: a.end,
          categoryFilter: a.categories?.join(","),
          messageTypeIdFilter: a.message_ids?.join(","),
          involvedEntityIdFilter: a.involved_ids?.join(","),
          referenceId: a.reference_id,
          referenceTime: a.reference_time,
        });
        const guid = (g: unknown) => (typeof g === "string" && g !== ZERO_GUID ? g : undefined);
        const str = (s: unknown) => (typeof s === "string" && s !== "" ? s : undefined);
        const events = (raw.Data ?? []).map((e) => {
          const mt = messageType(Number(e.MessageCategory));
          return {
            id: e.ID,
            when: e.When,
            messageId: e.MessageCategory,
            category: mt?.category,
            type: mt?.name,
            description: e.Description,
            who: str(e.Who),
            whoId: guid(e.WhoID),
            what: str(e.What),
            whatId: guid(e.WhatID),
            where: str(e.Where),
            whereId: guid(e.WhereID),
            referenceTime: e.ReferenceTime ?? (e.WhenTicks !== undefined ? String(e.WhenTicks) : undefined),
          };
        });
        const count = raw.Count ?? events.length;
        return ok({
          offset: raw.Offset ?? a.offset,
          count,
          nextOffset: count >= a.limit ? (raw.Offset ?? a.offset) + count : null,
          events,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "inception_list_event_types",
    {
      title: "Look up Inception event type IDs",
      description:
        "Searches the catalogue of review event types (from the Inception API docs) so you can find numeric IDs to pass as message_ids to inception_get_events. " +
        "Example: query='armed' or 'disarm', category='Security'. Works offline; does not contact the panel.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive words to match against the event type name, e.g. 'door forced' or 'disarmed'."),
        category: z.enum(CATEGORIES).optional(),
        include_obsolete: z.boolean().default(false),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { ...READ_ONLY },
    },
    async ({ query, category, include_obsolete, limit }) => {
      const terms = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const matches = MESSAGE_TYPES.filter(
        (m) =>
          (include_obsolete || !m.obsolete) &&
          (!category || m.category === category) &&
          terms.every((t) => m.words.toLowerCase().includes(t) || m.name.toLowerCase().includes(t)),
      );
      return ok({
        matched: matches.length,
        returned: Math.min(matches.length, limit),
        eventTypes: matches.slice(0, limit).map((m) => ({ id: m.id, category: m.category, name: m.name, words: m.words })),
      });
    },
  );
}
