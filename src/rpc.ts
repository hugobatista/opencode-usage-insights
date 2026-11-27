import { Rpc } from "@opencode/plugin/rpc"
import { MAX_PANEL_WIDTH, MAX_TURNS } from "./limits"
import type { LineFormatOptions, PanelLine, PanelRow, PanelSettings } from "./panel-data"
import type { BackfillResult, DbInfo, PruneResult } from "./stats/maintenance"
import type { FilterOption } from "./stats/queries"

/**
 * The usage-insights RPC contract. One definition is served by the server
 * part and consumed by the TUI and the desktop GUI, so both clients read the
 * same database through the same validated surface.
 *
 * JSON Schema keeps the contract portable: the server does not need a newer
 * `effect` runtime, and a client can be a TUI, an Electron window or a plain
 * HTTP client. TypeScript types are declared next to the schemas and are the
 * only thing imported with `import type`; the schemas are the runtime truth.
 */

export type PanelInput = {
  sessionID: string
  settings: PanelSettings
  detail?: PanelRow | undefined
  width: number
  busy?: boolean | undefined
}

export type PanelOutput = {
  lines: PanelLine[]
  database?: DbInfo | undefined
}

export type TurnsInput = {
  sessionID: string
  limit: number
  width: number
}

export type TurnsOutput = {
  summary: PanelLine[]
  history: PanelLine[]
}

export type ListCostInput = {
  sessionID: string
}

export type ListCostOutput = {
  cost: number
}

export type FiltersOutput = {
  models: FilterOption[]
  providers: FilterOption[]
}

export type PruneInput = {
  days: number
  confirm: true
}

export type WipeInput = {
  confirm: true
}

export type VacuumInput = {
  confirm: true
}

export type BackfillInput = {
  confirm: true
}

export type VacuumOutput = {
  before: number
  after: number
  freed: number
}

export type RecordedEvent = {
  sessionID?: string | undefined
  at: number
}

export type UsageFormat = LineFormatOptions

const Tone = { type: "string", enum: ["base", "muted", "warning", "accent"] } as const

const PanelRowSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["model", "session", "period", "provider", "turn", "prune", "wipe"] },
    value: { type: "string", maxLength: 500 },
    variant: { type: "string", maxLength: 200 },
  },
  required: ["kind", "value"],
  additionalProperties: false,
} as const

const PanelLineSchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    tone: Tone,
    hint: { type: "boolean" },
    row: PanelRowSchema,
  },
  required: ["text"],
  additionalProperties: false,
} as const

const PanelSettingsSchema = {
  type: "object",
  properties: {
    view: { type: "string", enum: ["overview", "models", "providers", "cache", "periods", "latency", "sessions", "turns", "db"] },
    range: { type: "string", enum: ["session", "today", "7d", "30d", "all"] },
    sort: { type: "string", maxLength: 40 },
    sortDesc: { type: "boolean" },
    granularity: { type: "string", enum: ["day", "week", "month"] },
    turnsScope: { type: "string", enum: ["session", "all"] },
    modelID: { type: "string", maxLength: 300 },
    providerID: { type: "string", maxLength: 300 },
  },
  required: ["view", "range", "sort", "sortDesc", "granularity", "turnsScope", "modelID", "providerID"],
  additionalProperties: false,
} as const

const TableSizeSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    rows: { type: "number" },
  },
  required: ["name", "rows"],
  additionalProperties: false,
} as const

const DbInfoSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    bytes: { type: "number" },
    walBytes: { type: "number" },
    schemaVersion: { type: "number" },
    tables: { type: "array", items: TableSizeSchema },
    firstAt: { type: "number" },
    lastAt: { type: "number" },
    removable: {
      type: "array",
      items: {
        type: "object",
        properties: { days: { type: "number" }, steps: { type: "number" } },
        required: ["days", "steps"],
        additionalProperties: false,
      },
    },
    unpriced: { type: "number" },
  },
  required: ["path", "bytes", "schemaVersion", "tables", "removable", "unpriced"],
  additionalProperties: false,
} as const

const FilterOptionSchema = {
  type: "object",
  properties: { value: { type: "string" }, steps: { type: "number" } },
  required: ["value", "steps"],
  additionalProperties: false,
} as const

const PruneResultSchema = {
  type: "object",
  properties: {
    steps: { type: "number" },
    prompts: { type: "number" },
    events: { type: "number" },
    usage: { type: "number" },
  },
  required: ["steps", "prompts", "events", "usage"],
  additionalProperties: false,
} as const

const WipeResultSchema = {
  type: "object",
  properties: {
    steps: { type: "number" },
    prompts: { type: "number" },
    events: { type: "number" },
    usage: { type: "number" },
    sessions: { type: "number" },
  },
  required: ["steps", "prompts", "events", "usage", "sessions"],
  additionalProperties: false,
} as const

const BackfillResultSchema = {
  type: "object",
  properties: {
    candidates: { type: "number" },
    updated: { type: "number" },
  },
  required: ["candidates", "updated"],
  additionalProperties: false,
} as const

const VacuumResultSchema = {
  type: "object",
  properties: {
    before: { type: "number" },
    after: { type: "number" },
    freed: { type: "number" },
  },
  required: ["before", "after", "freed"],
  additionalProperties: false,
} as const

const NoInput = { type: "object", properties: {}, additionalProperties: false } as const

const ErrorSchema = {
  type: "object",
  properties: { message: { type: "string", maxLength: 500 } },
  additionalProperties: false,
} as const

const errors = {
  busy: ErrorSchema,
  unavailable: ErrorSchema,
  disabled: ErrorSchema,
  invalid: ErrorSchema,
} as const

export const UsageInsights = Rpc.define({
  id: "usage-insights",
  methods: {
    panel: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", maxLength: 200 },
          settings: PanelSettingsSchema,
          detail: PanelRowSchema,
          width: { type: "number", minimum: 20, maximum: MAX_PANEL_WIDTH },
          busy: { type: "boolean" },
        },
        required: ["sessionID", "settings", "width"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          lines: { type: "array", items: PanelLineSchema },
          database: DbInfoSchema,
        },
        required: ["lines"],
        additionalProperties: false,
      },
      errors,
    },
    turns: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", maxLength: 200 },
          limit: { type: "number", minimum: 1, maximum: MAX_TURNS },
          width: { type: "number", minimum: 20, maximum: 120 },
        },
        required: ["sessionID", "limit", "width"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          summary: { type: "array", items: PanelLineSchema },
          history: { type: "array", items: PanelLineSchema },
        },
        required: ["summary", "history"],
        additionalProperties: false,
      },
      errors,
    },
    listCost: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string", maxLength: 200 } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { cost: { type: "number" } },
        required: ["cost"],
        additionalProperties: false,
      },
      errors,
    },
    filters: {
      input: NoInput,
      output: {
        type: "object",
        properties: {
          models: { type: "array", items: FilterOptionSchema },
          providers: { type: "array", items: FilterOptionSchema },
        },
        required: ["models", "providers"],
        additionalProperties: false,
      },
      errors,
    },
    dbInfo: {
      input: NoInput,
      output: DbInfoSchema,
      errors,
    },
    prune: {
      input: {
        type: "object",
        properties: {
          days: { type: "number", minimum: 1, maximum: 3650 },
          confirm: { type: "boolean", enum: [true] },
        },
        required: ["days", "confirm"],
        additionalProperties: false,
      },
      output: PruneResultSchema,
      errors,
    },
    wipe: {
      input: {
        type: "object",
        properties: { confirm: { type: "boolean", enum: [true] } },
        required: ["confirm"],
        additionalProperties: false,
      },
      output: WipeResultSchema,
      errors,
    },
    vacuum: {
      input: {
        type: "object",
        properties: { confirm: { type: "boolean", enum: [true] } },
        required: ["confirm"],
        additionalProperties: false,
      },
      output: VacuumResultSchema,
      errors,
    },
    backfill: {
      input: {
        type: "object",
        properties: { confirm: { type: "boolean", enum: [true] } },
        required: ["confirm"],
        additionalProperties: false,
      },
      output: BackfillResultSchema,
      errors,
    },
  },
  events: {
    recorded: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string", maxLength: 200 },
          at: { type: "number" },
        },
        required: ["at"],
        additionalProperties: false,
      },
    },
  },
})
