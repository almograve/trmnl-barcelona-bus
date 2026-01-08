export default async function handler(req, res) {
  try {
    const stopId = (req.query.stop_id || "").toString().trim()
    const secondaryStopId = (req.query.secondary_stop_id || "").toString().trim()

    if (!stopId) {
      return res.status(400).json({ error: "Missing stop_id" })
    }

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

    const groupByLineTwoTimes = (items, maxLines) => {
      const map = new Map()

      for (const d of items) {
        const line = (d?.line || "").toString().trim()
        const destination = (d?.destination || "").toString().trim()
        const minutes = parseMinutes(d)

        if (!line || !destination || minutes === null) continue

        if (!map.has(line)) {
          map.set(line, { line, destination, times: [] })
        }

        const entry = map.get(line)

        entry.times.push(minutes)
      }

      const grouped = Array.from(map.values()).map((x) => {
        const uniqSorted = Array.from(new Set(x.times)).sort((a, b) => a - b)
        const m1 = uniqSorted.length > 0 ? uniqSorted[0] : null
        const m2 = uniqSorted.length > 1 ? uniqSorted[1] : null
        return { line: x.line, destination: x.destination, m1, m2 }
      })

      grouped.sort((a, b) => {
        const am = a.m1 ?? 9999
        const bm = b.m1 ?? 9999
        return am - bm
      })

      return grouped.slice(0, maxLines)
    }

    const stopsToFetch = [stopId]
    if (secondaryStopId) stopsToFetch.push(secondaryStopId)

    const results = await Promise.all(
      stopsToFetch.map(async (sid) => {
        const url = new URL(`https://api.tmb.cat/v1/ibus/stops/${encodeURIComponent(sid)}`)
        url.searchParams.set("app_id", TMB_APP_ID)
        url.searchParams.set("app_key", TMB_APP_KEY)

        const r = await fetch(url.toString(), { headers: { accept: "application/json" } })

        if (!r.ok) {
          return { stop_id: sid, error: `TMB error ${r.status}`, lines: [] }
        }

        const payload = await r.json()
        const ibus = normalizeIbusArray(payload)

        const lines = groupByLineTwoTimes(ibus, 10)

        return { stop_id: sid, lines }
      })
    )

    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=60")

    return res.status(200).json({
      title: "Barcelona buses",
      updated_at: new Date().toISOString(),
      stops: results,
    })
  } catch {
    return res.status(500).json({ error: "Unexpected error" })
  }
}
