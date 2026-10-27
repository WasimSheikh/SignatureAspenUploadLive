"use client";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function shiftMonth(key, delta) {
  const [year, month] = String(key || "").split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  const y = next.getUTCFullYear();
  if (!year || y < 2000 || y > 2100) return key;
  return `${y}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

function cells(year, month) {
  const leading = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = String(month).padStart(2, "0");
  const items = Array.from({ length: leading }, () => null);
  for (let day = 1; day <= count; day += 1) {
    items.push(`${year}-${pad}-${String(day).padStart(2, "0")}`);
  }
  return items;
}

export default function TransferCalendar({ data, selected, onSelect, onMonth, compact = false }) {
  const month = data?.month;
  const counts = new Map((data?.days || []).map((day) => [day.date, day]));
  if (!month) return <p role="status">Loading calendar…</p>;

  return (
    <div className={`cal${compact ? " compact" : ""}`}>
      <div className="cal-head">
        <button type="button" className="secondary" onClick={() => onMonth(shiftMonth(month.key, -1))}
          aria-label="Previous month">‹</button>
        <h3>{month.label}</h3>
        <button type="button" className="secondary" onClick={() => onMonth(shiftMonth(month.key, 1))}
          aria-label="Next month">›</button>
      </div>
      <div className="cal-week" aria-hidden="true">
        {WEEKDAYS.map((day) => <span key={day} className="cal-dow">{day}</span>)}
      </div>
      <div className="cal-grid" role="grid" aria-label={`${month.label} transfers`}>
        {cells(month.year, month.month).map((date, index) => {
          if (!date) return <div key={`empty-${index}`} className="cal-day empty" />;
          const info = counts.get(date);
          const day = Number(date.slice(8));
          return (
            <button
              key={date}
              type="button"
              className={`cal-day${info ? " has" : ""}${date === data.today ? " today" : ""}${date === selected ? " on" : ""}`}
              aria-label={info ? `${date}, ${info.transferCount} job${info.transferCount === 1 ? "" : "s"}` : date}
              onClick={() => onSelect(date)}
            >
              <span className="cal-num">{day}</span>
              {info && <span className="cal-count">{info.transferCount} job{info.transferCount === 1 ? "" : "s"}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
