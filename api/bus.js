export default async function handler(req, res) {
  try {
    const stopId = (req.query.stop_id || "").toString().trim()
    const secondaryStopId = (req.query.secondary_stop_id || "").toString().trim()

    if (!stopId) return res.status(400).json({ error: "Missing stop_id" })

    const fetchStop = async (sid) => {
      const url =
        "https://www.tmb.cat/en/barcelona/tmb-ibus/next-bus" +
        "?_buslineportlet_cmd=BUS_TIME_STOPS_AMB" +
        "&_buslineportlet_groupId=20182" +
        "&_buslineportlet_ibus=1" +
        "&_buslineportlet_renderPage=view-bus-stop-line" +
        `&_buslineportlet_stopName=${encodeURIComponent(sid)}` +
        "&p_p_cacheability=cacheLevelPage" +
        "&p_p_id=buslineportlet" +
        "&p_p_lifecycle=2" +
        "&p_p_mode=view" +
        "&p_p_state=normal"

      const r = await fetch(url, { headers: { accept: "application/json" } })
      if (!r.ok) return { stop_id: sid, lines: [], error: `TMB web feed ${r.status}` }

      const payload = await r.json()
      const times = Array.isArray(payload?.times) ? payload.times : []

      const byLine = new Map()

      for (const t of times) {
        const line = (t?.lineCode || "").toString().trim()
        const destination = (t?.destination || "").toString().trim()
        const arrivalSec = Number(t?.arrivalTime)

        if (!line || !destination) continue
        if (!Number.isFinite(arrivalSec)) continue

        const minutes = Math.max(0, Math.round(arrivalSec / 60))

        if (!byLine.has(line)) byLine.set(line, { line, destination, mins: [] })
        byLine.get(line).mins.push(minutes)
      }

      const lines = Array.from(byLine.values())
        .map((x) => {
          const uniqSorted = Array.from(new Set(x.mins)).sort((a, b) => a - b)
          return {
            line: x.line,
            destination: x.destination,
            m1: uniqSorted[0] ?? null,
            m2: uniqSorted[1] ?? null,
          }
        })
        .sort((a, b) => (a.m1 ?? 9999) - (b.m1 ?? 9999))
        .slice(0, 12)

      return { stop_id: sid, lines }
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
