export default async function handler(req, res) {
  try {
    const stopId = (req.query.stop_id || "").toString().trim()
    const secondaryStopId = (req.query.secondary_stop_id || "").toString().trim()

    if (!stopId) return res.status(400).json({ error: "Missing stop_id" })

    const TMB_APP_ID = process.env.TMB_APP_ID
    const TMB_APP_KEY = process.env.TMB_APP_KEY
    if (!TMB_APP_ID || !TMB_APP_KEY) {
      return res.status(500).json({ error: "Server missing TMB credentials" })
    }

    const parseMinutes = (d) => {
      const raw =
        d?.t_in_min ??
        d?.["t-in-min"] ??
        d?.t_in_minute ??
        d?.["t-in-minute"] ??
        d?.minutes ??
        d?.["minutes"]
      const n = Number(raw)
      return Number.isFinite(n) ? n : null
    }

    const normalizeIbusArray = (payload) => {
      const ibus =
        payload?.data?.ibus ??
        payload?.data?.["ibus"] ??
        payload?.data?.["iBus"] ??
        payload?.data?.["i-bus"] ??
        payload?.ibus ??
        []
      return Array.isArray(ibus) ? ibus : []
    }

    const uniqSorted = (arr) => Array.from(new Set(arr)).sort((a, b) => a - b)

    const buildLinesFromDepartures = (deps, maxLines) => {
      const byLine = new Map()

      for (const d of deps) {
        if (!d.line || !d.destination || d.minutes === null) continue
        if (!byLine.has(d.line)) byLine.set(d.line, { line: d.line, destination: d.destination, mins: [] })
        byLine.get(d.line).mins.push(d.minutes)
      }

      const lines = Array.from(byLine.values())
        .map((x) => {
          const mins = uniqSorted(x.mins)
          return { line: x.line, destination: x.destination, m1: mins[0] ?? null, m2: mins[1] ?? null }
        })
        .sort((a, b) => (a.m1 ?? 9999) - (b.m1 ?? 9999))
        .slice(0, maxLines)

      return lines
    }

    const fetchStop = async (sid) => {
      const url = new URL(`https://api.tmb.cat/v1/ibus/stops/${encodeURIComponent(sid)}`)
      url.searchParams.set("app_id", TMB_APP_ID)
      url.searchParams.set("app_key", TMB_APP_KEY)

      const r = await fetch(url.toString(), { headers: { accept: "application/json" } })
      if (!r.ok) return { stop_id: sid, error: `TMB error ${r.status}`, departures: [], lines: [] }

      const payload = await r.json()
      const ibus = normalizeIbusArray(payload)

      const departures = ibus
        .map((d) => {
          const minutes = parseMinutes(d)
          return {
            line: (d?.line || "").toString().trim(),
            destination: (d?.destination || "").toString().trim(),
            minutes,
          }
        })
        .filter((d) => d.line && d.destination && d.minutes !== null)
        .sort((a, b) => a.minutes - b.minutes)
        .slice(0, 20)

      const lines = buildLinesFromDepartures(departures, 12)

      return { stop_id: sid, departures, lines }
    }

    const stops = [await fetchStop(stopId)]
    if (secondaryStopId) stops.push(await fetchStop(secondaryStopId))

    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=60")
    return res.status(200).json({
      title: "Barcelona buses",
      updated_at: new Date().toISOString(),
      stops,
    })
  } catch {
    return res.status(500).json({ error: "Unexpected error" })
  }
}
