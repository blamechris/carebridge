"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
  Scatter,
  ComposedChart,
  ReferenceArea,
} from "recharts";

type VitalRecord = {
  id: string;
  recorded_at: string;
  type: string;
  value_primary: number;
  value_secondary?: number | null;
  unit: string;
};

type RangeKey = "7d" | "30d" | "90d";

const RANGE_DAYS: Record<RangeKey, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

// Normal ranges (inclusive). Out-of-range values are highlighted.
const NORMAL_RANGES: Record<
  string,
  { primary: [number, number]; secondary?: [number, number]; label: string }
> = {
  blood_pressure: {
    primary: [90, 140], // systolic
    secondary: [60, 90], // diastolic
    label: "Blood Pressure",
  },
  heart_rate: { primary: [60, 100], label: "Heart Rate" },
  o2_sat: { primary: [95, 100], label: "O2 Saturation" },
  temperature: { primary: [97, 99.5], label: "Temperature" },
  weight: { primary: [0, Infinity], label: "Weight" },
  respiratory_rate: { primary: [12, 20], label: "Respiratory Rate" },
  pain_level: { primary: [0, 3], label: "Pain Level" },
  blood_glucose: { primary: [70, 140], label: "Blood Glucose" },
};

function isOutOfRange(type: string, value: number): boolean {
  const range = NORMAL_RANGES[type]?.primary;
  if (!range) return false;
  return value < range[0] || value > range[1];
}

function formatTick(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function VitalChart({
  type,
  records,
}: {
  type: string;
  records: VitalRecord[];
}) {
  const info = NORMAL_RANGES[type];
  const unit = records[0]?.unit ?? "";
  const label = info?.label ?? type;
  const isBP = type === "blood_pressure";

  // Sort ascending for the chart.
  const data = useMemo(
    () =>
      [...records]
        .sort(
          (a, b) =>
            new Date(a.recorded_at).getTime() -
            new Date(b.recorded_at).getTime(),
        )
        .map((r) => ({
          ts: r.recorded_at,
          primary: r.value_primary,
          secondary: r.value_secondary ?? null,
          primaryOut: isOutOfRange(type, r.value_primary),
        })),
    [records, type],
  );

  if (data.length === 0) {
    return null;
  }

  return (
    <div
      className="detail-card"
      style={{ padding: 16, minHeight: 260 }}
    >
      <div
        className="detail-card-title"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <span>
          {label} {unit ? `(${unit})` : ""}
        </span>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {data.length} reading{data.length === 1 ? "" : "s"}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart
          data={data}
          margin={{ top: 8, right: 12, left: -8, bottom: 0 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.08)"
          />
          <XAxis
            dataKey="ts"
            tickFormatter={formatTick}
            stroke="var(--text-muted)"
            fontSize={11}
          />
          <YAxis stroke="var(--text-muted)" fontSize={11} />
          <Tooltip
            contentStyle={{
              background: "var(--bg-card, #1a1a1a)",
              border: "1px solid var(--border)",
              fontSize: 12,
            }}
            labelFormatter={(v) =>
              typeof v === "string" ? new Date(v).toLocaleString() : String(v)
            }
          />
          {isBP && <Legend wrapperStyle={{ fontSize: 11 }} />}
          <Line
            type="monotone"
            dataKey="primary"
            name={isBP ? "Systolic" : label}
            stroke="#4f9dff"
            strokeWidth={2}
            dot={(props: {
              cx?: number;
              cy?: number;
              payload?: { primaryOut?: boolean };
              index?: number;
            }) => {
              const { cx, cy, payload, index } = props;
              if (cx == null || cy == null) {
                return <g key={`dot-${index ?? 0}`} />;
              }
              const out = payload?.primaryOut;
              return (
                <circle
                  key={`dot-${index ?? 0}`}
                  cx={cx}
                  cy={cy}
                  r={out ? 5 : 3}
                  fill={out ? "#ff5c5c" : "#4f9dff"}
                  stroke={out ? "#ff5c5c" : "#4f9dff"}
                />
              );
            }}
            isAnimationActive={false}
          />
          {isBP && (
            <Line
              type="monotone"
              dataKey="secondary"
              name="Diastolic"
              stroke="#8b7cff"
              strokeWidth={2}
              dot={{ r: 3, fill: "#8b7cff" }}
              isAnimationActive={false}
            />
          )}
          {/* Scatter just to anchor out-of-range tooltip color; using Line dot above handles highlighting. */}
          <Scatter dataKey="primaryOut" hide />
          {/* Reference band for normal range (primary metric). */}
          {info &&
            info.primary[1] !== Infinity &&
            info.primary[0] !== -Infinity && (
              <ReferenceArea
                y1={info.primary[0]}
                y2={info.primary[1]}
                fill="#4ade80"
                fillOpacity={0.06}
                stroke="none"
              />
            )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function VitalsTrendChart({
  vitals,
}: {
  vitals: VitalRecord[];
}) {
  const [range, setRange] = useState<RangeKey>("30d");

  const filtered = useMemo(() => {
    const cutoff = Date.now() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000;
    return vitals.filter((v) => new Date(v.recorded_at).getTime() >= cutoff);
  }, [vitals, range]);

  const byType = useMemo(() => {
    const map = new Map<string, VitalRecord[]>();
    for (const v of filtered) {
      const list = map.get(v.type) ?? [];
      list.push(v);
      map.set(v.type, list);
    }
    return map;
  }, [filtered]);

  const types = Array.from(byType.keys());

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Range:
        </span>
        {(["7d", "30d", "90d"] as RangeKey[]).map((r) => (
          <button
            key={r}
            className={`btn btn-sm ${range === r ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setRange(r)}
          >
            {r}
          </button>
        ))}
      </div>
      {types.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-text">
            No vitals recorded in this range
          </div>
        </div>
      ) : (
        <div
          className="detail-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
            gap: 16,
          }}
        >
          {types.map((type) => (
            <VitalChart
              key={type}
              type={type}
              records={byType.get(type) ?? []}
            />
          ))}
        </div>
      )}
    </div>
  );
}
